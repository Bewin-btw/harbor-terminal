// The detached session manager owns PTYs; GUI clients can come and go.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { localeEnvironment, SessionStore, launchSpec, scanConversations, quoteShell, socketPath, verifySocketOwner, readSettings, writeSettings } = require('./core.cjs');
const { createCodexThread } = require('./codex.cjs');
const { suspendTree } = require('./process-control.cjs');
process.umask(0o077);
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error('Absolute data directory required');
const address = socketPath(directory), runtimes = new Map(), clients = new Set();
let appleLocale = '';
try { appleLocale = require('node:child_process').execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch {}
let store, server, checkpointTimer, cwdTimer, stopping = false, saving = false, settings = readSettings(directory);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(socket, message) {
  if (socket.destroyed) return;
  if (socket.writableLength > 8 * 1024 * 1024) return socket.destroy();
  socket.write(JSON.stringify(message) + '\n');
}
function broadcast(message) { for (const client of clients) send(client, message); }
function changed() { broadcast({ event: 'sessions', sessions: store.list() }); }
function update(id, patch) {
  let session;
  try { session = store.update(id, patch); }
  catch (error) {
    if (error.code !== 'HARBOR_PERSISTENCE') throw error;
    session = store.get(id);
    broadcast({ event: 'warning', message: error.message });
  }
  changed(); return session;
}
function runtime(id) {
  const r = runtimes.get(id);
  if (!r || r.exited) throw new Error('Процесс завершён. Откройте сессию заново.');
  return r;
}
async function screen(id) {
  const r = runtimes.get(id);
  if (!r) return store.screen(id);
  await new Promise(resolve => r.terminal.write('', resolve));
  return { cols: r.terminal.cols, rows: r.terminal.rows, data: r.serialize.serialize(), savedAt: new Date().toISOString() };
}
async function checkpoint() {
  if (saving) return;
  saving = true;
  try {
    for (const [id, r] of runtimes) if (r.dirty) {
      r.dirty = false;
      try { store.snapshot(id, await screen(id)); }
      catch (error) { r.dirty = true; broadcast({ event: 'warning', message: `Не удалось сохранить вывод: ${error.message}` }); }
    }
  } finally { saving = false; }
}
async function processTree(root) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,stat=,comm='], { maxBuffer: 4 * 1024 * 1024, timeout: 2000 });
  const rows = stdout.trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return m ? { pid: Number(m[1]), parent: Number(m[2]), state: m[3], command: m[4] } : null;
  }).filter(Boolean);
  const descendants = new Set([root]);
  let grew = true;
  while (grew) { grew = false; for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); grew = true; } }
  return rows.filter(row => descendants.has(row.pid));
}
function signal(pid, name) { try { process.kill(pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
async function launch(id) {
  if (runtimes.has(id) && !runtimes.get(id).exited) return store.get(id);
  let session = store.get(id);
  if (session.archived) throw new Error('Сначала верните сессию из архива');
  if (session.kind === 'codex' && session.lastStartedAt && !session.resumeId) throw new Error('Выберите сохранённый диалог через «Привязать диалог», чтобы продолжить именно его.');
  if (!fs.statSync(session.cwd).isDirectory()) throw new Error('Рабочая папка больше не существует');
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Harbor', TERM_PROGRAM_VERSION: '0.1.0', HARBOR_SESSION_ID: id };
  Object.assign(env, localeEnvironment(env, appleLocale));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID']) delete env[key];
  env.PATH = [...new Set([path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(env.PATH || '/usr/bin:/bin').split(':')])].join(':');
  if (session.kind === 'codex' && !session.resumeId) {
    const resumeId = await createCodexThread({ cwd: session.cwd, env, title: session.title });
    session = update(id, { resumeId });
  }
  const spec = launchSpec(session);
  const previous = store.screen(id), cols = previous.cols || 100, rows = previous.rows || 30;
  const terminal = new Terminal({ cols, rows, scrollback: settings.scrollback, allowProposedApi: true });
  const serialize = new SerializeAddon(); terminal.loadAddon(serialize);
  const shell = process.env.SHELL || '/bin/zsh';
  const args = session.kind === 'shell' ? (process.env.HARBOR_TEST ? ['-f'] : ['-l']) : ['-lic', `exec ${[spec.file, ...spec.args].map(quoteShell).join(' ')}`];
  let child;
  try { child = pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd: session.cwd, env }); }
  catch (error) { terminal.dispose(); throw new Error(`Не удалось запустить терминал: ${error.message}`); }
  const r = { child, terminal, serialize, dirty: true, exited: false, paused: false, tail: '', frozen: new Set(), pendingBytes: 0 };
  runtimes.get(id)?.terminal.dispose(); runtimes.set(id, r);
  terminal.onData(data => { if (!r.exited && !r.paused && ![...clients].some(c => c.subscription === id)) child.write(data); });
  terminal.parser.registerOscHandler(7, value => {
    try {
      const url = new URL(value);
      if (session.kind === 'shell' && url.protocol === 'file:' && (!url.hostname || url.hostname === os.hostname() || url.hostname === 'localhost')) {
        const cwd = decodeURIComponent(url.pathname);
        if (cwd !== store.get(id).cwd && fs.existsSync(cwd)) update(id, { cwd });
      }
    } catch {}
    return true;
  });
  // Startup command: typed once the shell has printed something, like a person would.
  let pendingCommand = session.kind === 'shell' && session.command ? session.command : null;
  child.onData(data => {
    if (pendingCommand) { const command = pendingCommand; pendingCommand = null; setTimeout(() => { if (!r.exited) child.write(command + '\r'); }, 150); }
    r.pendingBytes += data.length;
    if (r.pendingBytes > 2 * 1024 * 1024) child.pause();
    r.tail = (r.tail + data).slice(-8192);
    if (session.kind === 'codex') {
      const match = r.tail.match(/codex\s+resume\s+([a-f0-9]{8}-[a-f0-9-]{27,})/i);
      if (match && !store.get(id).resumeId) { try { update(id, { resumeId: match[1].slice(0, 36) }); } catch {} }
    }
    terminal.write(data, () => {
      r.pendingBytes -= data.length;
      if (r.pendingBytes < 512 * 1024 && !r.exited) child.resume();
      r.dirty = true;
      for (const client of clients) if (client.subscription === id) send(client, { event: 'output', id, data });
    });
  });
  child.onExit(async ({ exitCode }) => {
    try {
      r.exited = true;
      if (!stopping) update(id, { state: r.saving ? 'saved' : 'exited', pid: undefined, exitCode });
      store.snapshot(id, await screen(id));
      if (runtimes.get(id) === r) { runtimes.delete(id); terminal.dispose(); }
    } catch (error) { console.error(error.message); broadcast({ event: 'warning', message: error.message }); }
  });
  update(id, { state: 'running', pid: child.pid, exitCode: undefined, error: undefined, lastStartedAt: new Date().toISOString() });
  if (session.kind === 'claude' && !session.resumeId) update(id, { resumeId: session.id });
  for (const client of clients) if (client.subscription === id) send(client, { event: 'reset', id, cols, rows });
  return store.get(id);
}
async function stopSession(id) {
  const r = runtime(id); await checkpoint();
  const tree = await processTree(r.child.pid); r.saving = true;
  try {
    for (const p of tree) signal(p.pid, 'SIGCONT');
    for (const p of [...tree].reverse()) signal(p.pid, p.pid === r.child.pid && store.get(id).kind === 'shell' ? 'SIGHUP' : 'SIGTERM');
  } catch (error) {
    r.saving = false; r.paused = false; r.frozen.clear(); update(id, { state: 'running' });
    throw new Error(`Не удалось завершить все процессы: ${error.message}`);
  }
  for (let i = 0; i < 30 && !r.exited; i++) await delay(50);
  if (!r.exited) {
    r.saving = false; r.paused = false;
    update(id, { state: 'running' });
    throw new Error('Программа не завершилась по сигналу. Завершите её из терминала; принудительное убийство не выполнялось.');
  }
  return store.get(id);
}
async function handle(socket, method, params) {
  switch (method) {
    case 'ping': return { version: 2, pid: process.pid, features: ['startup-command', 'settings', 'delete'] };
    case 'settings': {
      if (params.set) {
        settings = writeSettings(directory, { ...settings, ...params.set });
        for (const r of runtimes.values()) if (!r.exited) r.terminal.options.scrollback = settings.scrollback;
      }
      return settings;
    }
    case 'list': return { sessions: store.list(), warning: store.persistenceError || store.warning };
    case 'create': {
      const existing = params.resumeId && store.list().find(s => s.kind === params.kind && s.resumeId === params.resumeId);
      if (existing) return existing;
      const session = store.create(params); changed();
      if (params.start !== false) {
        try { return await launch(session.id); }
        catch (error) { update(session.id, { state: 'exited', error: error.message }); throw error; }
      }
      return session;
    }
    case 'start': return launch(params.id);
    case 'attach': {
      store.get(params.id); socket.subscription = null;
      const view = await screen(params.id); socket.subscription = params.id;
      return { ...view, session: store.get(params.id) };
    }
    case 'detach': socket.subscription = null; return true;
    case 'input': {
      const r = runtime(params.id);
      if (r.paused) throw new Error('Сессия приостановлена');
      if (typeof params.data !== 'string' || params.data.length > 1024 * 1024) throw new Error('Слишком большой ввод');
      r.child.write(params.data); return true;
    }
    case 'resize': {
      const r = runtimes.get(params.id), cols = Number(params.cols), rows = Number(params.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) throw new Error('Некорректный размер терминала');
      if (r) { r.terminal.resize(cols, rows); if (!r.exited) r.child.resize(cols, rows); r.dirty = true; }
      return true;
    }
    case 'pause': {
      const r = runtime(params.id);
      if (r.paused) return store.get(params.id);
      try { r.frozen = await suspendTree(r.child.pid, processTree, signal); }
      catch (error) {
        r.frozen = error.frozen || new Set(); r.paused = r.frozen.size > 0;
        update(params.id, { state: r.paused ? 'paused' : 'running' });
        throw new Error(`Не удалось приостановить все процессы: ${error.message}. ${r.paused ? 'Часть процессов остановлена; нажмите «Продолжить».' : 'Изменения отменены.'}`);
      }
      r.paused = true; update(params.id, { state: 'paused' }); await checkpoint(); return store.get(params.id);
    }
    case 'resume': {
      const r = runtime(params.id), tree = await processTree(r.child.pid);
      for (const p of [...tree].reverse()) if (r.frozen.has(p.pid)) signal(p.pid, 'SIGCONT');
      r.frozen.clear(); r.paused = false; return update(params.id, { state: 'running' });
    }
    case 'stop': return stopSession(params.id);
    case 'update': {
      const patch = {};
      for (const key of ['title', 'pinned', 'archived', 'resumeId', 'command', 'autostart']) if (Object.hasOwn(params.patch || {}, key)) patch[key] = params.patch[key];
      if (patch.title !== undefined) { patch.title = String(patch.title).trim().slice(0, 160); if (!patch.title) throw new Error('Введите название'); }
      const live = runtimes.has(params.id) && !runtimes.get(params.id).exited;
      if (patch.archived && live) throw new Error('Сначала завершите процесс или оставьте сессию в фоне');
      if (patch.resumeId && live) throw new Error('Нельзя менять диалог работающего процесса');
      return update(params.id, patch);
    }
    case 'delete': {
      // Only archived cards with no process behind them; the CLI dialog itself stays on disk.
      const session = store.get(params.id);
      if (!session.archived) throw new Error('Удалить можно только сессию из архива');
      if (runtimes.has(params.id) && !runtimes.get(params.id).exited) throw new Error('Процесс ещё работает');
      runtimes.delete(params.id); store.remove(params.id); changed(); return true;
    }
    case 'checkpoint': await checkpoint(); return true;
    case 'scan': return scanConversations();
    default: throw new Error('Неизвестная операция');
  }
}
async function trackDirectories() {
  for (const [id, r] of runtimes) {
    if (r.exited || r.paused || store.get(id).kind !== 'shell') continue;
    try {
      const { stdout } = await execute('/usr/sbin/lsof', ['-a', '-p', String(r.child.pid), '-d', 'cwd', '-Fn'], { timeout: 1500 });
      const cwd = stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
      if (cwd && cwd !== store.get(id).cwd && fs.existsSync(cwd)) update(id, { cwd });
    } catch {}
  }
}
async function shutdown() {
  if (stopping) return;
  stopping = true; clearInterval(checkpointTimer); clearInterval(cwdTimer); await checkpoint();
  for (const r of runtimes.values()) if (!r.exited) {
    try { for (const p of (await processTree(r.child.pid)).reverse()) { signal(p.pid, 'SIGCONT'); signal(p.pid, 'SIGTERM'); } } catch {}
  }
  for (const client of clients) client.destroy();
  server?.close(); try { fs.unlinkSync(address); } catch {}
  setTimeout(() => process.exit(0), 120);
}
async function main() {
  if (verifySocketOwner(address)) {
    const alive = await new Promise(resolve => {
      const probe = net.createConnection(address);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', error => { probe.destroy(); resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'); });
    });
    if (alive) return;
    fs.unlinkSync(address);
  }
  server = net.createServer(socket => {
    clients.add(socket); socket.setEncoding('utf8');
    let buffer = '', queue = Promise.resolve();
    socket.on('error', () => {}); socket.on('close', () => clients.delete(socket));
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 2 * 1024 * 1024) return socket.destroy();
      let position;
      while ((position = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, position); buffer = buffer.slice(position + 1);
        queue = queue.then(async () => {
          let message;
          try {
            message = JSON.parse(line);
            if (!message || typeof message.method !== 'string') throw new Error('Некорректный запрос');
            const result = await handle(socket, message.method, message.params || {});
            send(socket, { requestId: message.requestId, result });
          } catch (error) { if (error.code === 'HARBOR_PERSISTENCE') changed(); send(socket, { requestId: message?.requestId, error: error.message }); }
        });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
  fs.chmodSync(address, 0o600); store = new SessionStore(directory);
  checkpointTimer = setInterval(() => checkpoint().catch(error => console.error(error)), 2000);
  cwdTimer = setInterval(() => trackDirectories().catch(() => {}), 4000);
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  // Opt-in only: shells marked "autostart" come back with their command after a reboot.
  for (const session of store.list()) {
    if (session.kind !== 'shell' || !session.autostart || !session.command || session.archived || session.state !== 'interrupted') continue;
    launch(session.id).catch(error => { try { update(session.id, { state: 'interrupted', error: error.message }); } catch {} });
  }
  console.log('Harbor session manager ready');
}
main().catch(error => { console.error(error); process.exit(1); });
