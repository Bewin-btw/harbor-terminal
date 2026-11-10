const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { SessionStore, socketPath } = require('../src/core.cjs');
const { Client } = require('../src/rpc.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-native-ui-'));
const home = path.join(directory, 'home'), root = path.join(home, '.claude/projects/demo'); fs.mkdirSync(root, { recursive: true });
const resumeId = '11111111-1111-4111-8111-111111111111';
const messages = Array.from({ length: 160 }, (_, i) => ({ type: i % 10 ? 'assistant' : 'user', uuid: String(i), message: { content: i % 10 ? [{ type: 'text', text: `Ответ агента строка ${i}` }] : `Мой вопрос ${i}` } }));
fs.writeFileSync(path.join(root, resumeId + '.jsonl'), messages.map(JSON.stringify).join('\n') + '\n');
const store = new SessionStore(directory); const session = store.create({ kind: 'claude', title: 'Native Claude terminal', cwd: directory, resumeId });
const program = path.join(directory, 'fullscreen.py'), shell = path.join(directory, 'test-shell');
fs.writeFileSync(program, `import os,sys,tty,re,signal,json
tty.setraw(0)
top=120
typed=''
def draw(*args):
 global top
 cols,rows=os.get_terminal_size(1)
 top=max(0,min(top,160-max(1,rows-4)))
 out='\\x1b[2J\\x1b[H'
 for i in range(top,min(160,top+rows-4)):
  out+=('❯ Мой вопрос '+str(i) if i%10==0 else '● Ответ агента строка '+str(i))+'\\r\\n'
 out+='\\x1b['+str(rows-1)+';1H❯ '+typed
 sys.stdout.write(out);sys.stdout.flush()
signal.signal(signal.SIGWINCH,draw)
sys.stdout.write('\\x1b[?1049h\\x1b[?1003h\\x1b[?1006h');sys.stdout.flush();draw()
pending=''
while True:
 data=os.read(0,4096).decode('utf-8',errors='replace')
 if not data:break
 pending+=data
 while pending:
  match=re.match(r'\\x1b\\[<(64|65);\\d+;\\d+M',pending)
  if match:
   top+=-1 if match[1]=='64' else 1;pending=pending[match.end():];continue
  if pending.startswith('\\x1b[1;5H'):top=0;pending=pending[6:];continue
  if pending.startswith('\\x1b[1;5F'):top=160;pending=pending[6:];continue
  if pending.startswith('\\x1b[5~'):top-=10;pending=pending[4:];continue
  if pending.startswith('\\x1b[6~'):top+=10;pending=pending[4:];continue
  if pending.startswith('\\x1b'):
   if len(pending)<20:break
   pending=pending[1:];continue
  typed+=pending[0];pending=pending[1:]
 draw()
`);
fs.writeFileSync(shell, `#!/bin/sh\nexec /usr/bin/python3 '${program.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
const env = { ...process.env, SHELL: shell, HARBOR_DATA_DIR: directory, HARBOR_HISTORY_HOME: home, HARBOR_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let app, manager, managerPid;
(async () => {
  try {
    const index = process.argv.indexOf('--app');
    app = await electron.launch({ ...(index >= 0 ? { executablePath: process.argv[index + 1], args: [] } : { args: [path.join(__dirname, '..')] }), env });
    const page = await app.firstWindow(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.locator('#connection-label').filter({ hasText: 'Менеджер сессий подключён' }).waitFor();
    manager = new Client(socketPath(directory)); await manager.connect(); managerPid = (await manager.request('ping')).pid;
    const started = await manager.request('start', { id: session.id });
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('Мой вопрос'));
    const track = page.locator('#terminal-scrollbar'), thumb = page.locator('#terminal-scroll-thumb');
    await page.waitForFunction(() => document.querySelector('#terminal-scrollbar').getAttribute('aria-disabled') === 'false');
    assert.equal(await page.locator('#conversation-pane').count(), 0);
    await page.waitForFunction(() => document.querySelectorAll('.harbor-human-line').length > 0);
    // Reattach to the same running PTY: SerializeAddon omits SGR encoding1006.
    await page.locator(`[data-id="${session.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('Мой вопрос'));
    const h = await thumb.boundingBox(), t = await track.boundingBox(), content = await page.locator('#terminal').boundingBox();
    assert.ok(h.height >= 32 && h.width > 0); assert.ok(content.x + content.width <= t.x);
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down(); await page.mouse.move(t.x + t.width / 2, t.y, { steps: 15 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.xterm-rows').firstElementChild.textContent.includes('Мой вопрос 0'));
    await page.waitForFunction(() => document.querySelector('.xterm-rows').firstElementChild.classList.contains('harbor-human-line'));
    assert.equal(await page.locator('.xterm-rows>div').nth(1).evaluate(el => el.classList.contains('harbor-human-line')), false);
    const userColor = await page.locator('.harbor-human-line span').first().evaluate(el => getComputedStyle(el).color);
    const answerColor = await page.locator('.xterm-rows>div').nth(1).locator('span').first().evaluate(el => getComputedStyle(el).color);
    assert.notEqual(userColor, answerColor);
    // Large wheel input must produce more than a single native mouse report.
    await page.mouse.move(content.x + 80, content.y + 70); await page.mouse.wheel(0, 96);
    await page.waitForFunction(() => /строка [4-9]/.test(document.querySelector('.xterm-rows').firstElementChild.textContent), null, { timeout: 3000 });
    await track.focus(); await track.press('End');
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('строка 159'));
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('NATIVE_INPUT_OK');
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('NATIVE_INPUT_OK'));
    assert.equal((await manager.request('list')).sessions[0].pid, started.pid);
    await page.screenshot({ path: path.join(__dirname, '../artifacts/native-terminal.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: full alternate-screen PTY, visible gutter, native drag/Home/End/wheel, colored user rows without labels, typing and same PID.');
  } finally { if (app) await app.close(); if (managerPid) try { process.kill(managerPid, 'SIGTERM'); } catch {} manager?.close(); console.log('Test data:', directory); }
})().catch(e => { console.error(e); process.exitCode = 1; });
