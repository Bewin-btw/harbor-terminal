const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Client } = require('./rpc.cjs');
const { socketPath, scanConversations } = require('./core.cjs');
const { ActivityMonitor } = require('./activity.cjs');
const { readConversation } = require('./conversation.cjs');

app.setName('Harbor');
const dataDirectory = process.env.HARBOR_DATA_DIR || path.join(app.getPath('appData'), 'Harbor');
app.setPath('userData', dataDirectory);
let window, client, connecting, quitting = false;
const activityMonitor = new ActivityMonitor({ home: process.env.HARBOR_TEST === '1' && process.env.HARBOR_HISTORY_HOME || os.homedir(), directory: dataDirectory });
let activityTimer, activityBusy = false, activitySessions = [], activities = {}, activitySignature = '';
async function refreshActivity() {
  if (activityBusy || quitting || !window || window.isDestroyed()) return;
  activityBusy = true;
  try {
    const statuses = await activityMonitor.scan(activitySessions);
    const signature = JSON.stringify(statuses); activities = statuses;
    if (signature !== activitySignature) { activitySignature = signature; forward('activity', { statuses }); }
  } finally { activityBusy = false; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const methods = new Set(['list', 'create', 'start', 'attach', 'detach', 'input', 'resize', 'pause', 'resume', 'stop', 'update', 'checkpoint', 'scan', 'activity', 'conversation']);

function forward(event, value) { if (window && !window.isDestroyed()) window.webContents.send('harbor:event', { event, ...value }); }
async function connectManager() {
  if (client?.socket && !client.socket.destroyed) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const address = socketPath(dataDirectory);
    let launched = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = new Client(address);
      try {
        await candidate.connect(); await candidate.request('ping'); client = candidate;
        for (const event of ['sessions', 'output', 'reset', 'warning']) client.on(event, message => {
          if (event === 'sessions') { activitySessions = message.sessions; refreshActivity().catch(() => {}); }
          forward(event, message);
        });
        client.on('disconnected', () => {
          forward('connection', { connected: false });
          activitySessions = []; activities = {}; activitySignature = ''; forward('activity', { statuses: {} });
          if (!quitting) setTimeout(() => connectManager().then(() => forward('connection', { connected: true })).catch(error => forward('warning', { message: error.message })), 800);
        });
        return client;
      } catch {
        candidate.close();
        if (!launched) {
          fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
          const log = fs.openSync(path.join(dataDirectory, 'manager.log'), 'a', 0o600);
          const child = spawn(process.execPath, [path.join(__dirname, 'daemon.cjs'), dataDirectory], {
            detached: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          });
          child.on('error', error => forward('warning', { message: error.message })); child.unref(); fs.closeSync(log); launched = true;
        }
        await delay(80);
      }
    }
    throw new Error(`Не удалось подключиться к менеджеру сессий. Журнал: ${path.join(dataDirectory, 'manager.log')}`);
  })().finally(() => { connecting = null; });
  return connecting;
}
function trusted(event) { return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame; }
function registerIPC() {
  ipcMain.handle('harbor:request', async (event, method, params) => {
    if (!trusted(event) || !methods.has(method)) throw new Error('Операция недоступна');
    // History browsing belongs to the UI and can update without restarting PTYs.
    if (method === 'scan') return scanConversations(process.env.HARBOR_TEST === '1' && process.env.HARBOR_HISTORY_HOME || os.homedir());
    if (method === 'activity') return activities;
    if (method === 'conversation') {
      const session = activitySessions.find(s => s.id === params?.id);
      if (!session || !['claude', 'codex'].includes(session.kind) || !/^[a-f0-9-]{36}$/i.test(session.resumeId)) return { messages: [], before: null };
      if (params.before !== undefined && (!Number.isSafeInteger(params.before) || params.before < 0)) throw new Error('Некорректная страница истории');
      if (params.after !== undefined && (!Number.isSafeInteger(params.after) || params.after < 0)) throw new Error('Некорректная позиция истории');
      const file = await activityMonitor.locate(session);
      if (!file) return { messages: [], before: null };
      return readConversation(file, session.kind, { before: params.before, after: params.after, revision: params.revision });
    }
    const manager = await connectManager(); const value = await manager.request(method, params);
    if (method === 'list') { activitySessions = value.sessions; refreshActivity().catch(() => {}); }
    return value;
  });
  ipcMain.handle('harbor:info', event => {
    if (!trusted(event)) return;
    return { home: os.homedir(), version: app.getVersion(), dataDirectory };
  });
  ipcMain.handle('harbor:folder', async event => {
    if (!trusted(event)) return;
    const result = await dialog.showOpenDialog(window, { title: 'Рабочая папка', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('harbor:confirm', async (event, options) => {
    if (!trusted(event)) return false;
    const result = await dialog.showMessageBox(window, {
      type: 'question', message: String(options.title).slice(0, 200), detail: String(options.detail).slice(0, 2000),
      buttons: ['Отмена', String(options.action || 'Продолжить').slice(0, 60)], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  });
  ipcMain.handle('harbor:external', async (event, url) => {
    if (!trusted(event)) return;
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol)) await shell.openExternal(parsed.href);
  });
  ipcMain.handle('harbor:copy', (event, text) => { if (trusted(event) && typeof text === 'string') clipboard.writeText(text); });
  ipcMain.handle('harbor:paste', event => trusted(event) ? clipboard.readText() : '');
  ipcMain.handle('harbor:data-folder', event => { if (trusted(event)) return shell.openPath(dataDirectory); });
  ipcMain.handle('harbor:context', (event, session) => {
    if (!trusted(event)) return;
    const action = name => forward('action', { name, id: session.id });
    const live = ['running', 'paused'].includes(session.state);
    Menu.buildFromTemplate([
      { label: 'Переименовать', click: () => action('rename') },
      { label: session.pinned ? 'Открепить' : 'Закрепить', click: () => action('pin') },
      { type: 'separator' },
      { label: 'Привязать сохранённый диалог…', enabled: !live && ['claude', 'codex'].includes(session.kind), click: () => action('bind') },
      { label: 'Скопировать рабочую папку', click: () => clipboard.writeText(session.cwd) },
      { type: 'separator' },
      { label: 'Сохранить вывод и завершить процесс…', enabled: live, click: () => action('stop') },
      { label: session.archived ? 'Вернуть из архива' : 'В архив', enabled: !live, click: () => action('archive') },
    ]).popup({ window });
  });
}
function createWindow() {
  if (window && !window.isDestroyed()) { window.show(); return; }
  window = new BrowserWindow({
    width: 1260, height: 820, minWidth: 820, minHeight: 520,
    title: 'Harbor', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: '#151719', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.loadFile(path.join(__dirname, 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { client?.request('detach').catch(() => {}); window = null; });
}
function createMenu() {
  const action = name => { createWindow(); forward('action', { name }); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Harbor', submenu: [
      { role: 'about' }, { type: 'separator' }, { label: 'Папка сохранённых сессий', click: () => shell.openPath(dataDirectory) },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { label: 'Выйти из Harbor · сессии продолжат работать', accelerator: 'Cmd+Q', click: () => app.quit() },
    ] },
    { label: 'Сессия', submenu: [
      { label: 'Новая сессия', accelerator: 'Cmd+N', click: () => action('new') },
      { label: 'Импортировать диалог…', accelerator: 'Cmd+O', click: () => action('import') },
      { label: 'Найти сессию', accelerator: 'Cmd+K', click: () => action('search') },
      { type: 'separator' }, { label: 'Закрыть окно', accelerator: 'Cmd+W', click: () => window?.close() },
    ] },
    { label: 'Правка', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' },
      { label: 'Копировать', accelerator: 'Cmd+C', click: () => action('copy') },
      { label: 'Вставить', accelerator: 'Cmd+V', click: () => action('paste') }, { role: 'selectAll' },
      { type: 'separator' }, { label: 'Найти в терминале', accelerator: 'Cmd+F', click: () => action('find') },
    ] },
    { label: 'Вид', submenu: [
      { label: 'Оформление…', click: () => action('themes') }, { type: 'separator' },
      { label: 'Увеличить шрифт', accelerator: 'Cmd+Plus', click: () => action('font-up') },
      { label: 'Уменьшить шрифт', accelerator: 'Cmd+-', click: () => action('font-down') },
      { label: 'Обычный размер', accelerator: 'Cmd+0', click: () => action('font-reset') },
      { type: 'separator' }, { role: 'togglefullscreen' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
    ] }, { role: 'windowMenu' },
  ]));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { createWindow(); window.focus(); });
  app.whenReady().then(() => { registerIPC(); createMenu(); createWindow(); activityTimer = setInterval(() => refreshActivity().catch(() => {}), 1000); connectManager().catch(error => forward('warning', { message: error.message })); });
  app.on('activate', createWindow);
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; clearInterval(activityTimer); client?.close(); });
}
