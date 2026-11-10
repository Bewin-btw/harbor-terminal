// Read-only adapters. CLI formats are versioned independently: unknown data
// yields an unknown status, never a fabricated completion after an idle timer.
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const { Terminal } = require('@xterm/headless');
const UUID = /^[a-f0-9-]{36}$/i;
const result = (state, source) => ({ state, source });

function claudeActivity(session, registry, completed = false) {
  if (registry?.pid !== session.pid || registry.sessionId !== session.resumeId ||
      !Number.isFinite(registry.startedAt) || registry.startedAt < Date.parse(session.lastStartedAt) - 2000) return null;
  const state = { busy: 'working', waiting: 'attention', idle: completed ? 'completed' : 'idle' }[registry.status];
  return state ? result(state, 'claude-native') : null;
}

function codexEvent(previous, record) {
  const value = record.payload || {};
  if (record.type === 'event_msg') {
    if (value.type === 'task_started') return result('working', 'codex-journal');
    if (value.type === 'task_complete') return result('completed', 'codex-journal');
    if (value.type === 'turn_aborted') return result('idle', 'codex-journal');
  }
  if (record.type === 'response_item') {
    if (value.type === 'function_call' && value.name?.split('.').pop() === 'request_user_input') {
      return { ...result('attention', 'codex-journal'), callId: value.call_id };
    }
    if (value.type === 'function_call_output' && previous?.callId && previous.callId === value.call_id) return result('working', 'codex-journal');
  }
  return previous;
}

function codexScreenActivity(text) {
  // Only the current visible footer, never scrollback or arbitrary transcript text.
  const footer = text.split('\n').slice(-12).join('\n');
  if (/press (?:enter|return) to (?:confirm|submit)/i.test(footer) &&
      /(?:[›❯>]\s*)?1\.\s+(?:Yes|Allow|Approve)/i.test(footer) && /\b2\.\s+/i.test(footer)) return result('attention', 'codex-screen');
  if (/^\s*[•●✦].*\besc to interrupt\)?\s*$/im.test(footer)) return result('working', 'codex-screen');
  return null;
}

// Claude Code installs updates in the background and asks for a restart in its footer.
function claudeUpdatePending(text) {
  return /update installed\s*·\s*\/?restart/i.test(text.split('\n').filter(line => line.trim()).slice(-8).join('\n'));
}

class ActivityMonitor {
  constructor({ home, directory }) { this.home = home; this.directory = directory; this.paths = new Map(); this.journals = new Map(); this.screens = new Map(); }
  async locate(session) {
    const key = `${session.kind}:${session.resumeId}`;
    const cached = this.paths.get(key);
    if (cached && (cached.file || Date.now() - cached.at < 15000)) return cached.file;
    let file = null;
    if (session.kind === 'claude') {
      const root = path.join(this.home, '.claude/projects');
      for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name, `${session.resumeId}.jsonl`);
        if (await fs.stat(candidate).then(s => s.isFile()).catch(() => false)) { file = candidate; break; }
      }
    } else {
      const root = path.join(this.home, '.codex');
      const databases = (await fs.readdir(root).catch(() => [])).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      if (databases[0]) {
        try {
          const { stdout } = await execute('/usr/bin/sqlite3', ['-readonly', '-json', path.join(root, databases[0]), `SELECT rollout_path FROM threads WHERE id='${session.resumeId}' LIMIT 1`], { timeout: 1000, maxBuffer: 16384 });
          file = JSON.parse(stdout)[0]?.rollout_path || null;
        } catch {}
      }
      // Older CLI versions have no SQLite index. Scan directory names, not contents.
      if (!file) {
        const walk = async (dir, depth) => {
          for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (e.isFile() && e.name.endsWith(`${session.resumeId}.jsonl`)) return path.join(dir, e.name);
            if (e.isDirectory() && depth > 0) { const found = await walk(path.join(dir, e.name), depth - 1); if (found) return found; }
          }
          return null;
        };
        file = await walk(path.join(root, 'sessions'), 3);
      }
    }
    this.paths.set(key, { file, at: Date.now() }); return file;
  }
  async journal(session) {
    const file = await this.locate(session); if (!file) return null;
    const stat = await fs.stat(file).catch(() => null); if (!stat) { this.paths.delete(`${session.kind}:${session.resumeId}`); return null; }
    const key = session.id;
    let cache = this.journals.get(key);
    if (!cache || cache.file !== file || cache.started !== session.lastStartedAt || stat.size < cache.offset) cache = { file, started: session.lastStartedAt, offset: 0, partial: '', activity: null };
    if (cache.offset === stat.size) return cache.activity;
    const limit = 2 * 1024 * 1024, start = Math.max(cache.offset, stat.size - limit);
    const handle = await fs.open(file, 'r');
    let buffer;
    try { buffer = Buffer.alloc(stat.size - start); const read = await handle.read(buffer, 0, buffer.length, start); buffer = buffer.subarray(0, read.bytesRead); }
    finally { await handle.close(); }
    let text = buffer.toString('utf8');
    if (start > cache.offset) {
      // A skipped span may contain a new turn or its completion. Neither the
      // previous phase nor its unfinished JSON can survive that evidence gap.
      cache.activity = null; cache.partial = '';
      text = text.slice(text.indexOf('\n') + 1);
    }
    else text = cache.partial + text;
    const lines = text.split('\n'); cache.partial = lines.pop().slice(-limit); cache.offset = start + buffer.length;
    for (const line of lines) {
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (session.kind === 'claude') {
        if (record.isSidechain || record.sessionId && record.sessionId !== session.resumeId) continue;
        if (record.type === 'system' && record.subtype === 'turn_duration' || record.type === 'assistant' && record.message?.stop_reason === 'end_turn' && record.message?.content?.some(c => c.type === 'text')) cache.activity = result('completed', 'claude-journal');
        else if (['user', 'assistant'].includes(record.type) && !record.isMeta) cache.activity = result('working', 'claude-journal');
      } else {
        // An unfinished turn from before this process started cannot prove work now.
        if (Date.parse(record.timestamp) < Date.parse(session.lastStartedAt)) continue;
        cache.activity = codexEvent(cache.activity, record);
      }
    }
    this.journals.set(key, cache); return cache.activity;
  }
  async screen(session) {
    const file = path.join(this.directory, 'screens', `${session.id}.json`);
    const stat = await fs.stat(file).catch(() => null); if (!stat || stat.size > 8 * 1024 * 1024) return null;
    const cached = this.screens.get(session.id);
    if (cached?.mtime === stat.mtimeMs && cached.started === session.lastStartedAt) return cached.activity;
    const screen = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Date.parse(screen.savedAt) < Date.parse(session.lastStartedAt)) return null;
    if (!Number.isInteger(screen.cols) || !Number.isInteger(screen.rows) || screen.cols < 2 || screen.cols > 500 || screen.rows < 2 || screen.rows > 300 || typeof screen.data !== 'string') return null;
    const terminal = new Terminal({ cols: screen.cols, rows: screen.rows, scrollback: 0, allowProposedApi: true });
    let activity;
    try {
      await new Promise(resolve => terminal.write(screen.data, resolve));
      const b = terminal.buffer.active, lines = [];
      for (let y = b.baseY; y < b.baseY + terminal.rows; y++) lines.push(b.getLine(y)?.translateToString(true) || '');
      const text = lines.join('\n');
      activity = session.kind === 'claude' ? (claudeUpdatePending(text) ? { update: true } : null) : codexScreenActivity(text);
    } finally { terminal.dispose(); }
    this.screens.set(session.id, { mtime: stat.mtimeMs, started: session.lastStartedAt, activity }); return activity;
  }
  async scan(sessions) {
    const statuses = {};
    const active = sessions.filter(s => s.state === 'running' && ['claude', 'codex'].includes(s.kind) && UUID.test(s.id) && UUID.test(s.resumeId));
    // Bound work and memory to currently running sessions.
    const ids = new Set(active.map(s => s.id));
    for (const map of [this.journals, this.screens]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    for (const s of active) {
      try {
        const journal = await this.journal(s);
        if (s.kind === 'claude') {
          const registry = await fs.readFile(path.join(this.home, '.claude/sessions', `${Number(s.pid)}.json`), 'utf8').then(JSON.parse).catch(() => null);
          const native = claudeActivity(s, registry, journal?.state === 'completed');
          statuses[s.id] = native || result('unknown', 'unavailable');
          if ((await this.screen(s).catch(() => null))?.update) statuses[s.id] = { ...statuses[s.id], update: true };
        } else statuses[s.id] = await this.screen(s).catch(() => null) || journal || result('unknown', 'unavailable');
      } catch { statuses[s.id] = result('unknown', 'unavailable'); }
    }
    return statuses;
  }
}
module.exports = { claudeUpdatePending, claudeActivity, codexEvent, codexScreenActivity, ActivityMonitor };
