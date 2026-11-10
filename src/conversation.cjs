const fs = require('node:fs/promises');

function parseMessage(kind, record) {
  let role, content;
  if (kind === 'claude') {
    if (record.isSidechain || record.isMeta || record.isCompactSummary || !['user', 'assistant'].includes(record.type)) return null;
    role = record.type; content = record.message?.content;
  } else {
    if (record.type !== 'response_item' || record.payload?.type !== 'message') return null;
    role = record.payload.role; content = record.payload.content;
    if (!['user', 'assistant'].includes(role)) return null;
  }
  const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => ['text', 'input_text', 'output_text'].includes(c.type)).map(c => c.text || '').join('\n') : '').trim();
  if (!text || role === 'user' && /^(?:# AGENTS\.md instructions|<(?:environment_context|permissions instructions|developer_instructions|system-reminder|skills_instructions|user_instructions)\b)/i.test(text)) return null;
  return { role, text };
}

async function readConversation(file, kind, { before, after, limitBytes = 2 * 1024 * 1024, maxMessages = 100, revision } = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(); const version = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (before === undefined && revision === version && (after === undefined || after >= stat.size)) return { unchanged: true, revision: version };
    const reset = after !== undefined && after > stat.size;
    if (reset) after = undefined;
    if (after !== undefined) {
      // Forward pages stop only at complete records. A large tool result may
      // cross many read buffers; it must not strand all subsequent messages.
      const chunk = Buffer.alloc(64 * 1024), messages = [];
      let position = after, committed = after, pieces = [], length = 0, skipped = 0;
      const page = () => ({ messages, after: committed, before: null, revision: version, more: committed < stat.size && committed > after, skipped });
      while (position < stat.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
        if (!bytesRead) break;
        let cursor = 0;
        while (cursor < bytesRead) {
          const index = chunk.indexOf(10, cursor), newline = index >= 0 && index < bytesRead ? index : -1;
          const end = newline < 0 ? bytesRead : newline, part = chunk.subarray(cursor, end);
          length += part.length;
          if (length <= 8 * 1024 * 1024) pieces.push(Buffer.from(part)); else pieces = [];
          if (newline < 0) break;
          const lineStart = committed; committed = position + newline + 1;
          if (length > 8 * 1024 * 1024) skipped++;
          else {
            let record; try { record = JSON.parse(Buffer.concat(pieces).toString('utf8')); } catch {}
            const message = record && parseMessage(kind, record);
            if (message) messages.push({ ...message, id: record.uuid || String(lineStart), at: record.timestamp || null, offset: lineStart });
          }
          pieces = []; length = 0; cursor = newline + 1;
          if (messages.length >= maxMessages || committed - after >= limitBytes) return page();
        }
        position += bytesRead;
      }
      return { ...page(), more: false };
    }
    const end = before === undefined ? stat.size : Math.min(stat.size, Math.max(0, Math.floor(before)));
    const start = Math.max(0, end - limitBytes);
    const buffer = Buffer.alloc(end - start); const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let offset = 0;
    if (start) { const newline = buffer.indexOf(10); offset = newline < 0 ? bytesRead : newline + 1; }
    // Page boundaries are byte offsets at complete lines, including UTF-8 data.
    let next = start ? Math.min(end - 1, start + offset) : 0;
    if (offset === bytesRead && start) next = start; // advance past an oversized record
    const messages = [];
    while (offset < bytesRead) {
      const newline = buffer.indexOf(10, offset); if (newline < 0 || newline >= bytesRead) break;
      const lineStart = offset; const line = buffer.subarray(offset, newline).toString('utf8'); offset = newline + 1;
      let record; try { record = JSON.parse(line); } catch { continue; }
      const message = parseMessage(kind, record); if (!message) continue;
      messages.push({ ...message, id: record.uuid || String(start + lineStart), at: record.timestamp || null, offset: start + lineStart });
    }
    if (messages.length > maxMessages) { messages.splice(0, messages.length - maxMessages); next = messages[0].offset; }
    // Do not advance across a partially written JSON line. Retrying it on the
    // next poll preserves messages that the CLI is still writing.
    const nextAfter = start + offset;
    return { messages, before: next || null, after: nextAfter, more: false, revision: version, reset };
  } finally { await handle.close(); }
}
module.exports = { parseMessage, readConversation };
