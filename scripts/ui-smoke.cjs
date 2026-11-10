const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { Client } = require('../src/rpc.cjs');
const { socketPath } = require('../src/core.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-ui-'));
const historyHome = path.join(directory, 'history');
const claudeHistory = path.join(historyHome, '.claude/projects/demo');
const codexHistory = path.join(historyHome, '.codex/sessions/2026/11/03');
fs.mkdirSync(claudeHistory, { recursive: true }); fs.mkdirSync(codexHistory, { recursive: true });
fs.writeFileSync(path.join(claudeHistory, '11111111-1111-4111-8111-111111111111.jsonl'), [
  { type: 'user', sessionId: '11111111-1111-4111-8111-111111111111', cwd: directory, message: { content: 'Сделай названия сессий понятнее' } },
  { type: 'custom-title', sessionId: '11111111-1111-4111-8111-111111111111', customTitle: 'Harbor: импорт диалогов и читаемые названия сессий' },
].map(JSON.stringify).join('\n') + '\n');
fs.writeFileSync(path.join(codexHistory, 'sample.jsonl'), [
  { type: 'session_meta', payload: { id: '22222222-2222-4222-8222-222222222222', cwd: directory } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'Исправить восстановление терминала после перезагрузки' } },
].map(JSON.stringify).join('\n') + '\n');
const artifacts = path.join(__dirname, '../artifacts'); fs.mkdirSync(artifacts, { recursive: true });
let application, manager, managerPid;
const errors = [];
const appArgument = process.argv.indexOf('--app');
const executablePath = appArgument >= 0 ? process.argv[appArgument + 1] : process.env.HARBOR_APP_PATH;
const environment = { ...process.env, HARBOR_DATA_DIR: directory, HARBOR_TEST: '1', HARBOR_HISTORY_HOME: historyHome }; delete environment.ELECTRON_RUN_AS_NODE;
async function launch() {
  application = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.join(__dirname, '..')] }), env: environment });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#connection-label').filter({ hasText: 'Менеджер сессий подключён' }).waitFor();
  return page;
}
async function screenContains(page, marker) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const s = (await manager.request('list')).sessions.find(s => s.title === 'Smoke terminal');
    if ((await manager.request('attach', { id: s.id })).data.includes(marker)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Missing terminal marker: ${marker}`);
}
(async () => {
  try {
    let page = await launch();
    manager = new Client(socketPath(directory)); await manager.connect(); managerPid = (await manager.request('ping')).pid;
    await page.screenshot({ path: path.join(artifacts, 'welcome.png') });
    await page.locator('#import-sessions').click();
    await page.locator('.import-row').filter({ hasText: 'Harbor: импорт диалогов' }).waitFor();
    assert.equal(await page.locator('.provider-label.claude').innerText(), 'Claude');
    assert.equal(await page.locator('.provider-label.codex').innerText(), 'Codex');
    assert.equal(await page.locator('.import-preview').innerText(), 'Сделай названия сессий понятнее');
    await page.screenshot({ path: path.join(artifacts, 'import-titles.png') });
    await page.locator('#import-search').fill('понятнее');
    assert.equal(await page.locator('.import-row').count(), 1);
    assert.ok((await page.locator('.import-row').getAttribute('title')).includes('Harbor: импорт диалогов'));
    await page.locator('#import-dialog .close-dialog').click();
    await page.getByRole('button', { name: /Новая сессия/ }).click();
    await page.locator('#new-title').fill('Smoke terminal'); await page.locator('#new-cwd').fill(directory);
    await page.locator('#create-button').click();
    await page.locator('#current-title').filter({ hasText: 'Smoke terminal' }).waitFor();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('export HARBOR_SMOKE=preserved; printf "\\nUI_%s\\n" "READY"'); await page.keyboard.press('Enter');
    await screenContains(page, 'UI_READY');
    const before = await page.evaluate(async () => (await window.harbor.request('list')).sessions[0]);
    // Deterministically widen the snapshot-delivery window. Typing must remain
    // attached to the target session even before its old screen has arrived.
    await application.evaluate(({ app }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { Client } = load('./src/rpc.cjs');
      const original = Client.prototype.request;
      Client.prototype.request = function(method, params) {
        const result = original.call(this, method, params);
        return method === 'attach' ? result.then(value => new Promise(resolve => setTimeout(() => resolve(value), 350))) : result;
      };
    });
    // A second session must not overwrite or restart the first terminal.
    await page.locator('#new-session').click(); await page.locator('#new-title').fill('Second terminal'); await page.locator('#create-button').click();
    await page.locator('#current-title').filter({ hasText: 'Second terminal' }).waitFor();
    await page.locator('.session-row').filter({ hasText: 'Smoke terminal' }).click();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('printf "\\nSWITCH_%s\\n" "$HARBOR_SMOKE"'); await page.keyboard.press('Enter');
    await screenContains(page, 'SWITCH_preserved');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('SWITCH_preserved'), null, { timeout: 5000 });
    // A draggable gutter is outside the terminal, including at the narrow window size.
    await page.keyboard.type('for i in {1..180}; do printf "scroll-line-%s\\n" "$i"; done'); await page.keyboard.press('Enter');
    await screenContains(page, 'scroll-line-180');
    await page.waitForFunction(() => Number(document.querySelector('#terminal-scrollbar').getAttribute('aria-valuemax')) > 100);
    const track = page.locator('#terminal-scrollbar');
    const thumb = await page.locator('#terminal-scroll-thumb').boundingBox(); const gutter = await track.boundingBox();
    const content = await page.locator('#terminal').boundingBox(); assert.ok(content.x + content.width <= gutter.x);
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2); await page.mouse.down();
    await page.mouse.move(gutter.x + gutter.width / 2, gutter.y, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#terminal-scrollbar').getAttribute('aria-valuenow') === '0');
    await track.press('End');
    await page.waitForFunction(() => { const el = document.querySelector('#terminal-scrollbar'); return el.getAttribute('aria-valuenow') === el.getAttribute('aria-valuemax'); });
    await page.locator('#theme-button').click(); assert.equal(await page.locator('.theme-option').count(), 6);
    await page.locator('[data-theme-option="paper"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'paper');
    await page.screenshot({ path: path.join(artifacts, 'themes-paper.png') });
    await page.locator('#theme-dialog .close-dialog').click();
    await page.locator('.session-row:not(.active)').first().hover();
    assert.equal(await page.locator('.session-row:not(.active)').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(230, 233, 226)');
    assert.equal(await page.locator('.xterm-scrollable-element').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(250, 249, 246)');
    assert.equal(await page.locator('.xterm-viewport').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(250, 249, 246)');
    // Physical drag, keyboard reorder, and persistence use the same ordering.
    const firstRow = page.locator('.session-row').filter({ hasText: 'Smoke terminal' });
    const secondRow = page.locator('.session-row').filter({ hasText: 'Second terminal' });
    await secondRow.dragTo(firstRow, { targetPosition: { x: 30, y: 5 } });
    await page.waitForFunction(() => document.querySelector('.session-row .session-name').textContent === 'Second terminal');
    await secondRow.focus(); await secondRow.press('Alt+ArrowDown');
    await page.waitForFunction(() => document.querySelector('.session-row .session-name').textContent === 'Smoke terminal');
    await secondRow.focus(); await secondRow.press('Alt+ArrowUp');
    await page.waitForFunction(() => document.querySelector('.session-row .session-name').textContent === 'Second terminal');
    await page.screenshot({ path: path.join(artifacts, 'terminal.png') });
    await page.locator('#session-search').fill('Second'); assert.equal(await page.locator('.session-row').count(), 1);
    await page.locator('#session-search').fill('');
    await page.locator('#pin-button').click(); await page.waitForFunction(async () => (await window.harbor.request('list')).sessions[0].pinned);
    await page.locator('#pin-button').click(); await page.waitForFunction(async () => !(await window.harbor.request('list')).sessions[0].pinned);
    // Close the entire GUI process. Its detached manager and PTYs must survive.
    await application.close(); application = null;
    assert.equal((await manager.request('list')).sessions[0].pid, before.pid);
    page = await launch();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'paper');
    assert.equal(await page.locator('.session-row .session-name').first().innerText(), 'Second terminal');
    await page.locator('#current-title').filter({ hasText: 'Smoke terminal' }).waitFor();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('printf "\\nREOPEN_%s\\n" "$HARBOR_SMOKE"'); await page.keyboard.press('Enter');
    await screenContains(page, 'REOPEN_preserved');
    // A context-menu action on B must not stop the currently displayed A.
    const second = (await manager.request('list')).sessions.find(s => s.title === 'Second terminal');
    await manager.request('input', { id: second.id, data: 'exec /bin/cat\r' });
    await new Promise(resolve => setTimeout(resolve, 100));
    await application.evaluate(({ BrowserWindow, dialog }, id) => {
      dialog.showMessageBox = async () => ({ response: 1 });
      BrowserWindow.getAllWindows()[0].webContents.send('harbor:event', { event: 'action', name: 'stop', id });
    }, second.id);
    await page.waitForFunction(async id => (await window.harbor.request('list')).sessions.find(s => s.id === id).state === 'saved', second.id, { timeout: 5000 });
    assert.equal((await manager.request('list')).sessions.find(s => s.id === before.id).pid, before.pid);
    await page.screenshot({ path: path.join(artifacts, 'reconnected.png') });
    assert.deepEqual(errors, []);
    // Status rendering does not confuse a completed response with an exited process.
    await application.evaluate(({ BrowserWindow }, id) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.send('harbor:event', { event: 'sessions', sessions: [{ id, title: 'Claude status fixture', kind: 'claude', state: 'running', cwd: '/tmp', createdAt: new Date().toISOString() }] }); w.webContents.send('harbor:event', { event: 'activity', statuses: { [id]: { state: 'attention', source: 'claude-native' } } }); }, before.id);
    await page.locator('#current-state').filter({ hasText: 'Требуется действие' }).waitFor();
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('harbor:event', { event: 'activity', statuses: { [id]: { state: 'completed', source: 'claude-native' } } }), before.id);
    await page.locator('#current-state').filter({ hasText: 'Ответ завершён' }).waitFor();
    assert.equal(await page.locator('#pause-button').isEnabled(), true);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 520));
    await page.waitForFunction(() => window.innerWidth <= 820);
    const smallContent = await page.locator('#terminal').boundingBox(), smallGutter = await page.locator('#terminal-scrollbar').boundingBox();
    assert.ok(smallContent.x + smallContent.width <= smallGutter.x);
    assert.ok(await page.locator('#current-state').isVisible());
    await page.screenshot({ path: path.join(artifacts, 'narrow-status.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: GUI creation, real typing, switching, search, pinning, complete app exit/relaunch, same shell PID and variables, gutter drag, themes, reordered sessions, activity badges, no renderer errors.');
  } finally {
    if (application) await application.close();
    if (managerPid) { try { process.kill(managerPid, 'SIGTERM'); } catch {} }
    manager?.close();
    // Retain test data on failures for diagnosis; it is isolated from user history.
    console.log('Test data:', directory);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
