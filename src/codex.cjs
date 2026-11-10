const { spawn } = require('node:child_process');
const { UUID } = require('./core.cjs');

// Create only an empty persistent thread. No turn/start, prompt, or model request.
async function createCodexThread({ cwd, env, title }) {
  const child = spawn(env.SHELL || '/bin/zsh', ['-lic', 'exec codex app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', sequence = 0;
  function fail(error) { for (const p of pending.values()) p.reject(error); pending.clear(); }
  child.on('error', error => fail(error));
  child.on('exit', () => fail(new Error('Codex завершился до создания диалога')));
  child.stdin.on('error', error => fail(error));
  child.stderr.on('data', () => {}); // Diagnostics can contain private paths; do not relay them into the UI.
  child.stdout.on('data', data => {
    buffer += data;
    if (buffer.length > 8 * 1024 * 1024) { fail(new Error('Некорректный ответ Codex')); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result); }
      else if (message.id !== undefined && message.method) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Harbor only creates an empty local thread' } }) + '\n');
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timer = setTimeout(() => { fail(new Error('Codex не создал диалог за 20 секунд. Проверьте вход в CLI и настройки MCP.')); child.kill(); }, 20000);
  try {
    await rpc('initialize', { clientInfo: { name: 'harbor_terminal', version: '0.1.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const result = await rpc('thread/start', { cwd, ephemeral: false });
    const id = result?.thread?.id;
    if (!UUID.test(id || '')) throw new Error('Codex вернул неизвестный формат ID диалога');
    await rpc('thread/read', { threadId: id });
    // Thread naming is optional on older CLI versions; persistence is not.
    try { if (title) await rpc('thread/name/set', { threadId: id, name: title }); } catch {}
    return id;
  } finally {
    clearTimeout(timer); child.stdin.end();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timeout = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 500);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
}
module.exports = { createCodexThread };
