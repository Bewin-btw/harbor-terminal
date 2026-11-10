const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SessionStore, launchSpec, scanConversations, screenText, shortTitle } = require('../src/core.cjs');
const { suspendTree } = require('../src/process-control.cjs');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a daemon restart preserves cards but never pretends that their processes survived', t => {
  const dir = temporary(t);
  const store = new SessionStore(dir);
  const session = store.create({ title: 'Claude backend', kind: 'claude', cwd: dir });
  store.update(session.id, { state: 'paused', pinned: true, resumeId: '11111111-1111-4111-8111-111111111111' });
  store.save();
  const recovered = new SessionStore(dir).list()[0];
  assert.equal(recovered.title, 'Claude backend');
  assert.equal(recovered.pinned, true);
  assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.resumeId, '11111111-1111-4111-8111-111111111111');
});

test('metadata and private history use restrictive permissions and atomic files', t => {
  const dir = temporary(t);
  const store = new SessionStore(dir);
  const s = store.create({ title: 'terminal', kind: 'shell', cwd: dir });
  store.snapshot(s.id, { cols: 100, rows: 30, data: 'private output' });
  assert.equal(fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'screens', `${s.id}.json`)).mode & 0o777, 0o600);
  assert.equal(store.screen(s.id).data, 'private output');
});

test('damaged primary metadata recovers the backup without silently replacing history', t => {
  const dir = temporary(t);
  const store = new SessionStore(dir);
  const s = store.create({ title: 'keep me', kind: 'shell', cwd: dir });
  store.update(s.id, { pinned: true });
  fs.writeFileSync(path.join(dir, 'sessions.json'), '{broken');
  const recovered = new SessionStore(dir);
  assert.equal(recovered.list()[0].title, 'keep me');
  assert.ok(recovered.warning);
  assert.ok(fs.readdirSync(dir).some(n => n.startsWith('sessions.corrupt-')));
});

test('resume IDs and SSH arguments cannot turn into shell commands', () => {
  assert.throws(() => launchSpec({ kind: 'claude', resumeId: 'x; touch /tmp/bad' }));
  assert.throws(() => launchSpec({ kind: 'ssh', host: '-oProxyCommand=evil' }));
  assert.throws(() => launchSpec({ kind: 'ssh', host: 'host; evil' }));
  const spec = launchSpec({ kind: 'codex', resumeId: '11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(spec, { file: 'codex', args: ['resume', '11111111-1111-4111-8111-111111111111', '--no-daemon'] });
  assert.deepEqual(launchSpec({ kind: 'ssh', host: 'dev@example.org', port: 2222 }), { file: '/usr/bin/ssh', args: ['-p', '2222', 'dev@example.org'] });
  assert.deepEqual(launchSpec({ kind: 'ssh', host: 'my-server-alias' }), { file: '/usr/bin/ssh', args: ['my-server-alias'] });
  assert.throws(() => launchSpec({ kind: 'ssh', host: 'localhost', port: 0 }));
});

test('invalid locations and names never overwrite a valid workspace', t => {
  const dir = temporary(t);
  const store = new SessionStore(dir);
  assert.throws(() => store.create({ cwd: '/does-not-exist-harbor', kind: 'shell' }));
  const s = store.create({ cwd: dir, kind: 'shell' });
  assert.throws(() => store.update(s.id, { id: '../escape' }));
  assert.equal(store.list().length, 1);
});

test('imports saved Claude and Codex conversations without modifying their files', async t => {
  const dir = temporary(t);
  const claudeDir = path.join(dir, '.claude', 'projects', '-project');
  const codexDir = path.join(dir, '.codex', 'sessions', '2026', '11', '02');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  const id1 = '11111111-1111-4111-8111-111111111111';
  const id2 = '22222222-2222-4222-8222-222222222222';
  const a = path.join(claudeDir, `${id1}.jsonl`);
  const b = path.join(codexDir, `rollout-${id2}.jsonl`);
  fs.writeFileSync(a, JSON.stringify({ type: 'user', sessionId: id1, cwd: dir, timestamp: '2026-11-02T10:00:00Z' }) + '\n');
  fs.writeFileSync(b, JSON.stringify({ type: 'session_meta', payload: { id: id2, cwd: dir, timestamp: '2026-11-02T11:00:00Z' } }) + '\n');
  fs.utimesSync(a, new Date('2026-11-02T10:00:00Z'), new Date('2026-11-02T10:00:00Z'));
  fs.utimesSync(b, new Date('2026-11-02T11:00:00Z'), new Date('2026-11-02T11:00:00Z'));
  const before = fs.readFileSync(a, 'utf8');
  const results = await scanConversations(dir);
  assert.equal(results.length, 2);
  assert.equal(results[0].kind, 'codex');
  assert.equal(results[1].resumeId, id1);
  assert.equal(results[1].cwd, dir);
  assert.equal(fs.readFileSync(a, 'utf8'), before);
});

test('imports Codex conversations stored in the current SQLite history format', async t => {
  const dir = temporary(t), codex = path.join(dir, '.codex');
  fs.mkdirSync(codex);
  const database = path.join(codex, 'state_5.sqlite');
  execFileSync('/usr/bin/sqlite3', [database, "CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT, updated_at INTEGER, created_at INTEGER, archived INTEGER); INSERT INTO threads VALUES ('33333333-3333-4333-8333-333333333333', '/tmp', 'Saved database session', 1793640000, 1793640000, 0);"]);
  const results = await scanConversations(dir, { codexHome: codex });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Saved database session');
  assert.equal(results[0].resumeId, '33333333-3333-4333-8333-333333333333');
});

test('failed pause resumes only processes it stopped, preserving pre-existing stopped jobs', async () => {
  const stopped = new Set([13]);
  const describe = async () => [10, 11, 12, 13].map(pid => ({ pid, state: stopped.has(pid) ? 'T' : 'S' }));
  const signal = (pid, kind) => {
    if (pid === 12 && kind === 'SIGSTOP') throw new Error('permission denied');
    if (kind === 'SIGSTOP') stopped.add(pid); else stopped.delete(pid);
  };
  await assert.rejects(suspendTree(10, describe, signal), /permission denied/);
  assert.deepEqual([...stopped], [13]);
});

test('Claude import prefers the latest custom title and shows the real first prompt', async t => {
  const dir = temporary(t), project = path.join(dir, '.claude/projects/project');
  fs.mkdirSync(project, { recursive: true });
  const id = '44444444-4444-4444-8444-444444444444';
  const file = path.join(project, `${id}.jsonl`);
  const records = [
    { type: 'ai-title', sessionId: id, aiTitle: 'Generated title' },
    { type: 'user', sessionId: id, cwd: dir, isMeta: true, message: { content: '<system-reminder>Internal context</system-reminder>' } },
    { type: 'user', sessionId: id, cwd: dir, message: { content: [{ type: 'tool_result', content: 'ignore me' }] } },
    { type: 'user', sessionId: id, cwd: dir, message: { content: [{ type: 'text', text: 'Исправь импорт сессий в терминале' }] } },
    { type: 'custom-title', sessionId: id, customTitle: 'Old name' },
    { type: 'assistant', message: { content: 'x'.repeat(700000) } },
    { type: 'custom-title', sessionId: id, customTitle: 'Harbor: понятные названия' },
  ];
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const [session] = await scanConversations(dir);
  assert.equal(session.title, 'Harbor: понятные названия');
  assert.equal(session.preview, 'Исправь импорт сессий в терминале');
  assert.ok(Math.abs(Date.parse(session.date) - fs.statSync(file).mtimeMs) < 2);
});

test('unnamed Claude and legacy Codex sessions use user text, never project context', async t => {
  const dir = temporary(t);
  const claude = path.join(dir, '.claude/projects/project'), codex = path.join(dir, '.codex/sessions/2026/11/03');
  fs.mkdirSync(claude, { recursive: true }); fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(claude, '55555555-5555-4555-8555-555555555555.jsonl'), JSON.stringify({ type: 'user', sessionId: '55555555-5555-4555-8555-555555555555', cwd: dir, message: { content: 'Настрой подключение SSH' } }) + '\n');
  fs.writeFileSync(path.join(codex, 'session.jsonl'), [
    { type: 'session_meta', payload: { id: '66666666-6666-4666-8666-666666666666', cwd: dir } },
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp\nInternal rules' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Почини сохранение после перезагрузки' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const sessions = await scanConversations(dir);
  assert.equal(sessions.find(s => s.kind === 'claude').title, 'Настрой подключение SSH');
  assert.equal(sessions.find(s => s.kind === 'codex').title, 'Почини сохранение после перезагрузки');
});

test('Codex explicit name takes priority over generated title, with prompt as preview', async t => {
  const dir = temporary(t), codex = path.join(dir, '.codex'); fs.mkdirSync(codex);
  execFileSync('/usr/bin/sqlite3', [path.join(codex, 'state_5.sqlite'), "CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, updated_at INTEGER, created_at INTEGER, archived INTEGER); INSERT INTO threads VALUES ('77777777-7777-4777-8777-777777777777', '/tmp', 'Generated', 'My terminal project', 'Fix terminal titles', 1793640000, 1793640000, 0);"]);
  const [session] = await scanConversations(dir);
  assert.equal(session.title, 'My terminal project');
  assert.equal(session.preview, 'Fix terminal titles');
  execFileSync('/usr/bin/sqlite3', [path.join(codex, 'state_5.sqlite'), "UPDATE threads SET first_user_message = printf('%.*c', 6000000, 'x')"]);
  const withLargePrompt = await scanConversations(dir);
  assert.equal(withLargePrompt.length, 1, 'large prompts must not make the whole SQLite import disappear');
  assert.equal(withLargePrompt[0].title, 'My terminal project');
});

test('Claude history supplies a readable prompt when the transcript only has tool output', async t => {
  const dir = temporary(t), project = path.join(dir, '.claude/projects/demo'); fs.mkdirSync(project, { recursive: true });
  const id = '88888888-8888-4888-8888-888888888888';
  fs.writeFileSync(path.join(project, id + '.jsonl'), JSON.stringify({ type: 'user', sessionId: id, cwd: dir, message: { content: [{ type: 'tool_result', content: 'tool output' }] } }) + '\n');
  fs.writeFileSync(path.join(dir, '.claude/history.jsonl'), JSON.stringify({ sessionId: id, project: dir, display: 'Помоги настроить приложение' }) + '\n');
  const [session] = await scanConversations(dir);
  assert.equal(session.title, 'Помоги настроить приложение');
});

test('startup commands are single-line, shell-only and cleared by an empty value', t => {
  const { startupCommand } = require('../src/core.cjs');
  const dir = temporary(t);
  const store = new SessionStore(dir);
  assert.equal(startupCommand('  npm run dev  '), 'npm run dev');
  assert.equal(startupCommand(''), undefined);
  assert.throws(() => startupCommand('ls\nrm -rf ~'), /одной строкой/);
  const shell = store.create({ kind: 'shell', cwd: dir, command: 'npm run dev', autostart: true });
  assert.equal(shell.command, 'npm run dev');
  assert.equal(shell.autostart, true);
  assert.equal(store.update(shell.id, { command: '', autostart: false }).command, undefined);
  const agent = store.create({ kind: 'claude', cwd: dir, command: 'ignored', autostart: true });
  assert.equal(agent.command, undefined);
  assert.equal(agent.autostart, false);
  assert.throws(() => store.update(agent.id, { command: 'ls' }), /только для терминала/);
});

test('settings fall back to safe values and persist with private permissions', t => {
  const { readSettings, writeSettings } = require('../src/core.cjs');
  const dir = temporary(t);
  assert.deepEqual(readSettings(dir), { scrollback: 4000 });
  assert.deepEqual(writeSettings(dir, { scrollback: 10000 }), { scrollback: 10000 });
  assert.deepEqual(readSettings(dir), { scrollback: 10000 });
  assert.deepEqual(writeSettings(dir, { scrollback: 999999 }), { scrollback: 4000 });
  assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
});

test('a socket path that is not our own socket is refused', t => {
  const { verifySocketOwner } = require('../src/core.cjs');
  const dir = temporary(t);
  assert.equal(verifySocketOwner(path.join(dir, 'missing.sock')), false);
  const file = path.join(dir, 'plain.sock'); fs.writeFileSync(file, '');
  assert.throws(() => verifySocketOwner(file), error => error.code === 'HARBOR_FOREIGN_SOCKET');
});

test('screen text keeps the spaces the serializer encodes as cursor moves', () => {
  const data = '\x1b[1mтип\x1b[1Cлеса\x1b[0m\x1b[3Cсам по\x1b[Cсебе\r\n\x1b]0;title\x07\x1b[2C│ ok';
  assert.deepEqual(screenText(data), ['тип леса   сам по себе', '  │ ok']);
});

test('long first prompts become short card titles, short ones stay as they are', () => {
  assert.equal(shortTitle('чек модельки'), 'чек модельки');
  const long = 'мне для решения рабочих тасков нужно написать программу, которая будет делать скриншот экрана где будет показано где мой курсор';
  const title = shortTitle(long);
  assert.ok(title.length <= 61 && title.endsWith('…'), title);
  assert.equal(title, 'мне для решения рабочих тасков нужно написать программу…');
});

test('imported cards with a whole prompt as title get shortened on load, renamed ones are kept', t => {
  const dir = temporary(t);
  const long = 'x '.repeat(60) + 'конец';
  const base = { cwd: dir, state: 'saved', createdAt: 'a', updatedAt: 'a' };
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [
    { ...base, id: '11111111-1111-4111-8111-111111111111', kind: 'codex', imported: true, title: long },
    { ...base, id: '22222222-2222-4222-8222-222222222222', kind: 'claude', imported: true, title: 'своё название' },
  ] }));
  const store = new SessionStore(dir);
  const [codex, claude] = store.list();
  assert.ok(codex.title.length <= 61 && codex.title.endsWith('…'));
  assert.equal(claude.title, 'своё название');
});

test('removing a session drops its card and saved screen', t => {
  const dir = temporary(t); const store = new SessionStore(dir);
  const s = store.create({ kind: 'shell', cwd: dir });
  store.snapshot(s.id, { cols: 10, rows: 2, data: 'hi' });
  store.remove(s.id);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(path.join(dir, 'screens', `${s.id}.json`)), false);
});
