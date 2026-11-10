const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('../src/rpc.cjs');
const { socketPath } = require('../src/core.cjs');
const { createCodexThread } = require('../src/codex.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect(directory) {
  for (let i = 0; i < 100; i++) {
    const client = new Client(socketPath(directory));
    try { await client.connect(); return client; } catch { client.close(); await delay(40); }
  }
  throw new Error('Daemon did not start');
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-integration-'));
  let daemon;
  let logs = '';
  const start = async () => {
    daemon = spawn(process.execPath, [path.join(__dirname, '../src/daemon.cjs'), directory], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout.on('data', data => { logs += data; });
    daemon.stderr.on('data', data => { logs += data; });
    try { return await connect(directory); } catch (error) { throw new Error(`${error.message}: ${logs}`); }
  };
  t.after(async () => {
    if (daemon?.exitCode === null) { daemon.kill('SIGTERM'); await delay(200); }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, start, stop: async (signal = 'SIGTERM') => { daemon.kill(signal); await new Promise(resolve => daemon.once('exit', resolve)); } };
}
async function untilOutput(client, id, expected) {
  for (let i = 0; i < 80; i++) {
    const view = await client.request('attach', { id });
    if (view.data.includes(expected)) return view;
    await delay(50);
  }
  throw new Error(`Missing terminal output: ${expected}`);
}

test('PTY and shell variables survive a complete client disconnect', async t => {
  const f = await fixture(t);
  let client = await f.start(); t.after(() => client.close());
  const s = await client.request('create', { kind: 'shell', cwd: f.directory });
  await client.request('input', { id: s.id, data: 'export HARBOR_VALUE=still_here; printf "\\nFIRST_READY\\n"\r' });
  await untilOutput(client, s.id, 'FIRST_READY');
  const pid = (await client.request('list')).sessions[0].pid;
  client.close();
  client = await connect(f.directory);
  assert.equal((await client.request('list')).sessions[0].pid, pid);
  await client.request('input', { id: s.id, data: 'printf "\\nRECONNECTED_%s\\n" "$HARBOR_VALUE"\r' });
  await untilOutput(client, s.id, 'RECONNECTED_still_here');
});

test('pausing stops a foreground child and resuming continues the same process', async t => {
  const f = await fixture(t); const client = await f.start(); t.after(() => client.close());
  const s = await client.request('create', { kind: 'shell', cwd: f.directory });
  const counter = path.join(f.directory, 'counter');
  await client.request('input', { id: s.id, data: `python3 -u -c 'import time; f=open("${counter}","a"); exec("while True:\\n f.write(\\\"x\\\"); f.flush(); time.sleep(.05)")'\r` });
  for (let i = 0; i < 80 && (!fs.existsSync(counter) || fs.statSync(counter).size < 2); i++) await delay(50);
  assert.ok(fs.existsSync(counter), 'foreground child started');
  await client.request('pause', { id: s.id });
  const size = fs.statSync(counter).size;
  await delay(250);
  assert.equal(fs.statSync(counter).size, size);
  assert.equal((await client.request('list')).sessions[0].state, 'paused');
  await client.request('resume', { id: s.id });
  await delay(200);
  assert.ok(fs.statSync(counter).size > size);
});

test('daemon restart restores screen and metadata, never automatically reruns commands', async t => {
  const f = await fixture(t); let client = await f.start(); t.after(() => client.close());
  const s = await client.request('create', { kind: 'shell', title: 'Recovery', cwd: f.directory });
  await client.request('input', { id: s.id, data: 'printf "\\nPERSISTED_%s\\n" "OUTPUT"\r' });
  await untilOutput(client, s.id, 'PERSISTED_OUTPUT');
  await client.request('checkpoint');
  client.close(); await f.stop(); client = await f.start();
  const restored = (await client.request('list')).sessions[0];
  assert.equal(restored.title, 'Recovery');
  assert.equal(restored.state, 'interrupted');
  assert.equal(restored.pid, undefined);
  const screen = await client.request('attach', { id: s.id });
  assert.ok(screen.data.includes('PERSISTED_OUTPUT'));
  await assert.rejects(client.request('input', { id: s.id, data: 'touch unexpected\r' }));
  assert.equal(fs.existsSync(path.join(f.directory, 'unexpected')), false);
});

test('saved imports stay stopped until explicitly resumed and duplicate imports reuse the card', async t => {
  const f = await fixture(t); const client = await f.start(); t.after(() => client.close());
  const imported = { kind: 'codex', cwd: f.directory, resumeId: '11111111-1111-4111-8111-111111111111', start: false };
  const first = await client.request('create', imported);
  const second = await client.request('create', imported);
  assert.equal(first.id, second.id);
  assert.equal((await client.request('list')).sessions.length, 1);
  assert.equal(first.state, 'ready');
  assert.equal(first.pid, undefined);
});

test('Codex gets an exact durable conversation ID before the interactive process starts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const id = await createCodexThread({ cwd: directory, env: { ...process.env, CODEX_HOME: directory }, title: 'Harbor integration' });
  assert.match(id, /^[a-f0-9-]{36}$/i);
  function files(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(root, e.name)) : [path.join(root, e.name)]); }
  const session = files(path.join(directory, 'sessions')).find(file => file.includes(id));
  assert.ok(session, 'Codex persisted its own session before Harbor received the ID');
  assert.ok(fs.readFileSync(session, 'utf8').includes(id));
});

test('unplanned manager death recovers a checkpoint and preserves the paused card honestly', async t => {
  const f = await fixture(t); let client = await f.start(); t.after(() => client.close());
  const s = await client.request('create', { kind: 'shell', cwd: f.directory, title: 'Crash recovery' });
  await client.request('input', { id: s.id, data: 'printf "\\nCRASH_%s\\n" "CHECKPOINT"\r' });
  await untilOutput(client, s.id, 'CRASH_CHECKPOINT');
  await client.request('pause', { id: s.id });
  client.close(); await f.stop('SIGKILL'); client = await f.start();
  const recovered = (await client.request('list')).sessions[0];
  assert.equal(recovered.state, 'interrupted');
  assert.ok((await client.request('attach', { id: s.id })).data.includes('CRASH_CHECKPOINT'));
  assert.equal(recovered.pid, undefined);
});

test('a disk write failure during process exit cannot kill other sessions', async t => {
  const f = await fixture(t); const client = await f.start(); t.after(() => client.close());
  const first = await client.request('create', { kind: 'shell', cwd: f.directory });
  const second = await client.request('create', { kind: 'shell', cwd: f.directory });
  const backup = path.join(f.directory, 'sessions.json.backup');
  fs.unlinkSync(backup); fs.mkdirSync(backup);
  try {
    await client.request('input', { id: first.id, data: 'exit\r' });
    await delay(250);
    await client.request('ping');
    assert.equal((await client.request('list')).sessions.find(s => s.id === second.id).pid, second.pid);
    assert.equal((await client.request('list')).sessions.find(s => s.id === first.id).state, 'exited');
  } finally { fs.rmdirSync(backup); }
});

test('explicit stop closes an interactive shell and keeps its screen', async t => {
  const f = await fixture(t); const client = await f.start(); t.after(() => client.close());
  const s = await client.request('create', { kind: 'shell', cwd: f.directory });
  await client.request('input', { id: s.id, data: 'printf "\\nSTOP_%s\\n" "SAVED"\r' });
  await untilOutput(client, s.id, 'STOP_SAVED');
  await client.request('stop', { id: s.id });
  assert.equal((await client.request('list')).sessions[0].state, 'saved');
  assert.ok((await client.request('attach', { id: s.id })).data.includes('STOP_SAVED'));
});

test('a startup command runs on open, and autostart brings the shell back after a restart', async t => {
  const f = await fixture(t); let client = await f.start(); t.after(() => client.close());
  const marker = path.join(f.directory, 'started');
  const s = await client.request('create', { kind: 'shell', cwd: f.directory, command: `echo run >> ${marker}; printf "\\nSTARTUP_%s\\n" OK` });
  await untilOutput(client, s.id, 'STARTUP_OK');
  await client.request('update', { id: s.id, patch: { autostart: true } });
  client.close(); await f.stop(); client = await f.start();
  for (let i = 0; i < 80 && fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length < 2; i++) await delay(50);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 2);
  assert.equal((await client.request('list')).sessions[0].state, 'running');
});

test('scrollback setting is persisted by the manager and applied to new sessions', async t => {
  const f = await fixture(t); let client = await f.start(); t.after(() => client.close());
  assert.deepEqual(await client.request('settings'), { scrollback: 4000 });
  assert.deepEqual(await client.request('settings', { set: { scrollback: 20000 } }), { scrollback: 20000 });
  client.close(); await f.stop(); client = await f.start();
  assert.deepEqual(await client.request('settings'), { scrollback: 20000 });
  const s = await client.request('create', { kind: 'shell', cwd: f.directory });
  await client.request('input', { id: s.id, data: 'i=0; while [ $i -lt 6000 ]; do echo line$i; i=$((i+1)); done; printf "\\nDONE_%s\\n" LINES\r' });
  const view = await untilOutput(client, s.id, 'DONE_LINES');
  assert.ok(view.data.includes('line100\r\n'), 'lines beyond the old 4000 limit are kept');
});

test('only archived, stopped sessions can be deleted, and their saved screen goes with them', async t => {
  const f = await fixture(t); const client = await f.start(); t.after(() => client.close());
  const s = await client.request('create', { kind: 'shell', cwd: f.directory });
  await client.request('input', { id: s.id, data: 'printf "\\nKEEP_%s\\n" ME\r' });
  await untilOutput(client, s.id, 'KEEP_ME');
  await assert.rejects(client.request('delete', { id: s.id }), /только сессию из архива/);
  await client.request('stop', { id: s.id });
  await client.request('update', { id: s.id, patch: { archived: true } });
  const screen = path.join(f.directory, 'screens', `${s.id}.json`);
  assert.equal(fs.existsSync(screen), true);
  assert.equal(await client.request('delete', { id: s.id }), true);
  assert.equal((await client.request('list')).sessions.some(item => item.id === s.id), false);
  assert.equal(fs.existsSync(screen), false);
});
