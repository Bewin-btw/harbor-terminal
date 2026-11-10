const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { claudeUpdatePending, claudeActivity, codexEvent, codexScreenActivity, ActivityMonitor } = require('../src/activity.cjs');
const session = { id: '11111111-1111-4111-8111-111111111111', resumeId: '22222222-2222-4222-8222-222222222222', pid: 42, kind: 'claude', state: 'running', lastStartedAt: '2026-11-03T10:00:00Z' };
const registry = { pid: 42, sessionId: session.resumeId, startedAt: Date.parse(session.lastStartedAt) + 200, status: 'busy' };

test('Claude native state distinguishes work, waiting and idle; rejects a stale or foreign PID record', () => {
  assert.equal(claudeActivity(session, registry).state, 'working');
  assert.equal(claudeActivity(session, { ...registry, status: 'waiting', waitingFor: 'permission' }).state, 'attention');
  assert.equal(claudeActivity(session, { ...registry, status: 'idle' }).state, 'idle');
  assert.equal(claudeActivity(session, { ...registry, status: 'idle' }, true).state, 'completed');
  assert.equal(claudeActivity(session, { ...registry, sessionId: 'other' }), null);
  assert.equal(claudeActivity(session, { ...registry, startedAt: 1 }), null);
  assert.equal(claudeActivity(session, { ...registry, status: 'new-unsupported-state' }), null);
});

test('Codex follows actual turn events and correlates questions with tool responses', () => {
  const event = (type, rest = {}) => ({ type: 'event_msg', payload: { type, ...rest } });
  let state = codexEvent(null, event('task_started'));
  assert.equal(state.state, 'working');
  state = codexEvent(state, { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'a' } });
  assert.equal(state.state, 'attention');
  state = codexEvent(state, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'other' } });
  assert.equal(state.state, 'attention');
  state = codexEvent(state, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'a' } });
  assert.equal(state.state, 'working');
  state = codexEvent(state, event('task_complete'));
  assert.equal(state.state, 'completed');
  assert.equal(codexEvent(state, event('token_count')).state, 'completed');
  assert.equal(codexEvent(state, event('turn_aborted')).state, 'idle');
});

test('Codex approval detection requires an active confirmation footer, not prose mentioning approval', () => {
  assert.equal(codexScreenActivity('Example: Would you like to run this command?\nSome answer\n› ')?.state, undefined);
  assert.equal(codexScreenActivity('Would you like to run the following command?\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel')?.state, 'attention');
  assert.equal(codexScreenActivity('• Working (12s • esc to interrupt)\n\n› ')?.state, 'working');
});

test('monitor reads native Claude state without changing source files; paused/exited sessions never inherit activity', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-activity-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.claude/sessions'), { recursive: true });
  const file = path.join(home, '.claude/sessions/42.json');
  const original = JSON.stringify(registry); await fs.writeFile(file, original);
  const monitor = new ActivityMonitor({ home, directory: home });
  let result = await monitor.scan([session]); assert.equal(result[session.id].state, 'working');
  result = await monitor.scan([{ ...session, state: 'paused' }]); assert.equal(result[session.id], undefined);
  result = await monitor.scan([{ ...session, state: 'exited' }]); assert.equal(result[session.id], undefined);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('Codex journal handles partial writes, completed turns, restarts, and missing screen snapshots', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-codex-activity-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, '.codex/sessions/2026/11/03'); await fs.mkdir(root, { recursive: true });
  const file = path.join(root, `rollout-${session.resumeId}.jsonl`);
  const event = (type, seconds) => JSON.stringify({ timestamp: `2026-11-03T10:00:${seconds}Z`, type: 'event_msg', payload: { type } });
  await fs.writeFile(file, event('task_started', '01') + '\n');
  const monitor = new ActivityMonitor({ home, directory: home });
  const codex = { ...session, kind: 'codex' };
  assert.equal((await monitor.scan([codex]))[session.id].state, 'working');
  const complete = event('task_complete', '02'); await fs.appendFile(file, complete.slice(0, 40));
  assert.equal((await monitor.scan([codex]))[session.id].state, 'working');
  await fs.appendFile(file, complete.slice(40) + '\n');
  assert.equal((await monitor.scan([codex]))[session.id].state, 'completed');
  await fs.mkdir(path.join(home, 'screens')); await fs.writeFile(path.join(home, 'screens', `${session.id}.json`), '{broken');
  assert.equal((await monitor.scan([codex]))[session.id].state, 'completed');
  // Old work is not presented as running after opening the same thread anew.
  await fs.appendFile(file, event('task_started', '03') + '\n');
  const restarted = { ...codex, lastStartedAt: '2026-11-03T10:00:04Z' };
  assert.equal((await monitor.scan([restarted]))[session.id].state, 'unknown');
  await fs.appendFile(file, event('task_started', '05') + '\n');
  assert.equal((await monitor.scan([restarted]))[session.id].state, 'working');
  await fs.appendFile(file, event('task_complete', '06') + '\n');
  assert.equal((await monitor.scan([restarted]))[session.id].state, 'completed');
  await fs.appendFile(file, event('task_started', '07') + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(3 * 1024 * 1024) } }) + '\n');
  assert.equal((await monitor.scan([restarted]))[session.id].state, 'unknown', 'a skipped span must invalidate the earlier completion');
});

test('a Claude Code update waiting for restart is read from the footer only', () => {
  const footer = ['Готово.', '                   ✔ Update installed · /restart to apply', '────', '❯', '────', '⏵⏵ auto mode on', '', ''].join('\n');
  assert.equal(claudeUpdatePending(footer), true);
  assert.equal(claudeUpdatePending('✔ Update installed · Restart to update\n' + 'строка\n'.repeat(20)), false);
  assert.equal(claudeUpdatePending('❯ обычный экран\n⏵⏵ auto mode on'), false);
});
