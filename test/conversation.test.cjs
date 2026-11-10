const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readConversation, parseMessage } = require('../src/conversation.cjs');

test('Claude separates human messages from answers and excludes tools and injected context', () => {
  assert.deepEqual(parseMessage('claude', { type: 'user', message: { content: 'Мой вопрос' } }), { role: 'user', text: 'Мой вопрос' });
  assert.deepEqual(parseMessage('claude', { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Ответ' }] } }), { role: 'assistant', text: 'Ответ' });
  assert.equal(parseMessage('claude', { type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } }), null);
  assert.equal(parseMessage('claude', { type: 'user', isMeta: true, message: { content: 'instructions' } }), null);
  assert.equal(parseMessage('claude', { type: 'assistant', isSidechain: true, message: { content: 'subagent' } }), null);
});

test('Codex renders conversational messages without exposing reasoning or treating tool output as a user', () => {
  const item = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  assert.equal(parseMessage('codex', item('user', 'Вопрос')).role, 'user');
  assert.equal(parseMessage('codex', item('assistant', 'Ответ')).role, 'assistant');
  assert.equal(parseMessage('codex', item('developer', 'Instructions')), null);
  assert.equal(parseMessage('codex', item('user', '<environment_context>injected</environment_context>')), null);
  assert.equal(parseMessage('codex', { type: 'response_item', payload: { type: 'function_call_output', output: 'secret' } }), null);
});

test('byte pagination retains each complete message exactly once, handles partial writes and preserves original files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-conversation-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.jsonl');
  const records = Array.from({ length: 80 }, (_, i) => ({ type: i % 2 ? 'assistant' : 'user', uuid: String(i), message: { content: i % 2 ? [{ type: 'text', text: 'Ответ ' + i }] : 'Вопрос ' + i } }));
  const original = records.map(JSON.stringify).join('\n') + '\n'; await fs.writeFile(file, original);
  const pages = []; let before;
  do { const page = await readConversation(file, 'claude', { before, limitBytes: 1024 }); pages.unshift(...page.messages); before = page.before; } while (before);
  assert.deepEqual(pages.map(m => m.id), records.map(m => m.uuid));
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const partial = JSON.stringify({ type: 'user', uuid: 'new', message: { content: 'Новый вопрос' } });
  await fs.appendFile(file, partial.slice(0, 40));
  assert.equal((await readConversation(file, 'claude')).messages.at(-1).id, '79');
  await fs.appendFile(file, partial.slice(40) + '\n');
  assert.equal((await readConversation(file, 'claude')).messages.at(-1).id, 'new');
  let page = await readConversation(file, 'claude');
  const additional = Array.from({ length: 150 }, (_, i) => ({ type: 'user', uuid: `extra-${i}`, message: { content: `Вопрос ${i}` } }));
  await fs.appendFile(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(3 * 1024 * 1024) }] } }) + '\n' + additional.map(JSON.stringify).join('\n') + '\n');
  const collected = [];
  do { page = await readConversation(file, 'claude', { after: page.after, revision: page.revision }); collected.push(...page.messages); } while (page.more);
  assert.deepEqual(collected.map(m => m.id), additional.map(m => m.uuid));
});
