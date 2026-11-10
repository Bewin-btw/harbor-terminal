const { test } = require('node:test');
const assert = require('node:assert/strict');

test('native terminal colors real human messages and wrapped continuations, without labels or menu false positives', async () => {
  const { humanRows } = await import('../src/native-terminal.js');
  const messages = [{ role: 'user', text: 'Сделай скролл плавнее и выдели мои сообщения цветом' }];
  const rows = ['❯ Сделай скролл плавнее', '  и выдели мои сообщения цветом', '', '● Ответ агента', '❯ 1. Yes, proceed', '> Сделай скролл плавнее', '', '❯ ещё печатаю'];
  assert.deepEqual([...humanRows(rows, messages, 7)], [0, 1, 7]);
});
