// End-to-end check of split view, project groups, git branches, startup commands,
// cross-session search, resume-all and the Dock badge. Uses an isolated data directory.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Client } = require('../src/rpc.cjs');
const { socketPath } = require('../src/core.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-features-'));
const project = path.join(directory, 'demo-repo');
fs.mkdirSync(path.join(project, 'nested'), { recursive: true });
execFileSync('/usr/bin/git', ['init', '-q', '-b', 'feature/split', project]);
const historyHome = path.join(directory, 'history'); fs.mkdirSync(historyHome);
const artifacts = path.join(__dirname, '../artifacts'); fs.mkdirSync(artifacts, { recursive: true });
const environment = { ...process.env, HARBOR_DATA_DIR: path.join(directory, 'data'), HARBOR_TEST: '1', HARBOR_HISTORY_HOME: historyHome };
delete environment.ELECTRON_RUN_AS_NODE;
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let application, manager;

async function launch() {
  application = await electron.launch({ args: [path.join(__dirname, '..')], env: environment });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#connection-label').filter({ hasText: 'Менеджер сессий подключён' }).waitFor();
  return page;
}
const menu = (name, id) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('harbor:event', { event: 'action', ...value }), { name, id });
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(60); }
  throw new Error(message);
}
async function screen(id) { return (await manager.request('attach', { id })).data; }

(async () => {
  try {
    let page = await launch();
    manager = new Client(socketPath(environment.HARBOR_DATA_DIR)); await manager.connect();
    const sessions = async () => (await manager.request('list')).sessions;

    // A shell with a startup command, created through the dialog.
    await page.locator('#new-session').click();
    await page.locator('#new-title').fill('Dev server');
    await page.locator('#new-cwd').fill(project);
    assert.equal(await page.locator('#shell-fields').isVisible(), true);
    await page.locator('#new-command').fill('printf "\\nSTARTED_%s\\n" BY_COMMAND');
    await page.locator('#create-button').click();
    const dev = (await sessions()).find(s => s.title === 'Dev server');
    assert.equal(dev.command, 'printf "\\nSTARTED_%s\\n" BY_COMMAND');
    await until(async () => (await screen(dev.id)).includes('STARTED_BY_COMMAND'), 'startup command did not run');

    // Git branch on the card and in the header.
    await page.locator('.session-row .branch').filter({ hasText: 'feature/split' }).waitFor({ timeout: 10000 });
    assert.match(await page.locator('#current-path').innerText(), /⎇ feature\/split/);

    // Shell here (⌘T) → same folder, new card.
    await menu('shell-here');
    await until(async () => (await sessions()).length === 2, 'shell-here did not create a session');
    const here = (await sessions()).find(s => s.id !== dev.id);
    assert.equal(here.cwd, project);

    // Split (⌘D) → a third shell opens on the right, typing goes to it.
    await menu('split-toggle');
    await page.locator('#side-pane').waitFor();
    await until(async () => (await sessions()).length === 3, 'split did not create a session');
    const right = (await sessions()).find(s => ![dev.id, here.id].includes(s.id));
    await page.locator('#side-terminal .xterm').waitFor();
    await delay(400);
    await page.locator('#side-terminal').click();
    await page.keyboard.type('printf "\\nRIGHT_%s\\n" PANE'); await page.keyboard.press('Enter');
    await until(async () => (await screen(right.id)).includes('RIGHT_PANE'), 'typing in the right pane failed');
    await until(async () => (await page.locator('#side-terminal .xterm-rows').innerText()).includes('RIGHT_PANE'), 'right pane does not render its output');
    assert.equal((await screen(here.id)).includes('RIGHT_PANE'), false);
    await page.locator('#terminal').click();
    await page.keyboard.type('printf "\\nLEFT_%s\\n" PANE'); await page.keyboard.press('Enter');
    await until(async () => (await screen(here.id)).includes('LEFT_PANE'), 'typing in the left pane failed');
    await page.screenshot({ path: path.join(artifacts, 'features-split.png') });

    // Project grouping: everything sits under demo-repo, collapsing hides rows.
    await page.locator('#group-toggle').click();
    await page.locator('.group-label').filter({ hasText: 'demo-repo' }).waitFor();
    assert.equal(await page.locator('.session-row').count(), 3);
    await page.screenshot({ path: path.join(artifacts, 'features-groups.png') });
    await page.locator('.group-label').click();
    assert.equal(await page.locator('.session-row').count(), 0);
    await page.locator('.group-label').click();

    // Search across sessions jumps to the session that printed the text.
    await menu('search-all');
    await page.locator('#search-all-input').fill('right_pa');
    await page.locator('.search-result').filter({ hasText: 'RIGHT_PANE' }).first().waitFor({ timeout: 8000 });
    await page.screenshot({ path: path.join(artifacts, 'features-search.png') });
    await page.locator('.search-result').first().click();
    await until(async () => (await page.evaluate(() => document.querySelector('.session-row.active')?.dataset.id)) === right.id, 'search did not select the session');
    assert.equal(await page.locator('#side-pane').isHidden(), true, 'opening the right session on the left closes the split');

    // Startup command dialog from the context menu action.
    await menu('command', here.id);
    await page.locator('#command-input').fill('echo hi');
    await page.locator('#command-autostart').check();
    await page.locator('#command-form button[type=submit]').click();
    await until(async () => (await sessions()).find(s => s.id === here.id).autostart === true, 'command not saved');

    // Scrollback setting.
    await menu('themes');
    await page.locator('#scrollback-select').selectOption('10000');
    await until(async () => (await manager.request('settings')).scrollback === 10000, 'scrollback not saved');
    await page.screenshot({ path: path.join(artifacts, 'features-settings.png') });
    await page.keyboard.press('Escape');

    // Dock badge stays empty without agent activity.
    assert.equal(await application.evaluate(({ app }) => app.dock.getBadge()), '');

    // Restart the manager: sessions become interrupted, "resume all" brings them back.
    const managerPid = (await manager.request('ping')).pid;
    manager.close();
    process.kill(managerPid, 'SIGTERM');
    await page.locator('#resume-all').waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(artifacts, 'features-resume.png') });
    manager = new Client(socketPath(environment.HARBOR_DATA_DIR)); await manager.connect();
    // Autostart shell came back by itself; the other two wait for the button.
    await until(async () => (await sessions()).find(s => s.id === here.id).state === 'running', 'autostart shell did not come back');
    assert.equal((await sessions()).filter(s => s.state === 'interrupted').length, 2);
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.locator('#resume-all').click();
    await until(async () => (await sessions()).every(s => s.state === 'running'), 'resume-all did not start everything');
    assert.equal(await page.locator('#resume-all').isHidden(), true);

    assert.deepEqual(errors, []);
    console.log('PASS: startup command, git branch, shell-here, split typing isolation, project groups, search-all, command dialog, scrollback, manager restart + autostart + resume-all.');
  } catch (error) {
    console.error(error); process.exitCode = 1;
    try { await (await application.firstWindow()).screenshot({ path: path.join(artifacts, 'features-failure.png') }); } catch {}
  } finally {
    try { manager?.close(); } catch {}
    await application?.close().catch(() => {});
    try { const c = new Client(socketPath(environment.HARBOR_DATA_DIR)); await c.connect(); const { pid } = await c.request('ping'); c.close(); process.kill(pid, 'SIGTERM'); } catch {}
    console.log(`Test data: ${directory}`);
  }
})();
