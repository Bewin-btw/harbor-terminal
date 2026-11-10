const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const execute = require('node:util').promisify(require('node:child_process').execFile);

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const kinds = new Set(['shell', 'claude', 'codex', 'ssh']);
const states = new Set(['ready', 'running', 'paused', 'saved', 'exited', 'interrupted']);
const labels = { shell: 'Терминал', claude: 'Claude', codex: 'Codex', ssh: 'SSH' };

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  // Sync the containing directory as well as the file before reporting success.
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function launchSpec(session) {
  if (session.resumeId && !UUID.test(session.resumeId)) throw new Error('Некорректный ID диалога');
  switch (session.kind) {
    case 'shell': return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] };
    case 'claude': return { file: 'claude', args: session.resumeId ? ['--resume', session.resumeId] : ['--session-id', session.conversationId || session.id] };
    case 'codex': return { file: 'codex', args: session.resumeId ? ['resume', session.resumeId, '--no-daemon'] : ['--no-daemon'] };
    case 'ssh': {
      if (typeof session.host !== 'string' || !/^(?:[\w.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.:[\]_-]*$/.test(session.host)) {
        throw new Error('Укажите SSH-адрес вида user@host');
      }
      const explicitPort = session.port !== undefined && session.port !== null && session.port !== '';
      const port = Number(session.port);
      if (explicitPort && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Некорректный порт SSH');
      return { file: '/usr/bin/ssh', args: [...(explicitPort ? ['-p', String(port)] : []), session.host] };
    }
    default: throw new Error('Неизвестный тип сессии');
  }
}

// A single line typed into the user's own shell after it starts.
function startupCommand(value) {
  if (value === undefined || value === null) return undefined;
  const command = String(value).trim();
  if (!command) return undefined;
  if (command.length > 2000) throw new Error('Команда слишком длинная');
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(command)) throw new Error('Команда должна быть одной строкой');
  return command;
}

const scrollbackOptions = [4000, 10000, 20000];
function normalizeSettings(value = {}) {
  const scrollback = Number(value.scrollback);
  return { scrollback: scrollbackOptions.includes(scrollback) ? scrollback : 4000 };
}
function readSettings(directory) {
  try { return normalizeSettings(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'))); }
  catch { return normalizeSettings(); }
}
function writeSettings(directory, value) {
  const settings = normalizeSettings(value);
  atomicJSON(path.join(directory, 'settings.json'), settings);
  return settings;
}

// /tmp is shared between macOS users: refuse a socket someone else created.
function verifySocketOwner(address) {
  let stat;
  try { stat = fs.lstatSync(address); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isSocket() || stat.uid !== process.getuid()) {
    const error = new Error(`Сокет менеджера ${address} принадлежит другому пользователю или не является сокетом. Удалите его вручную.`);
    error.code = 'HARBOR_FOREIGN_SOCKET'; throw error;
  }
  return true;
}

function quoteShell(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

class SessionStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'sessions.json');
    this.warning = null;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.sessions = [];
    const decode = file => {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions) || parsed.sessions.some(s => !UUID.test(s.id) || !kinds.has(s.kind) || !states.has(s.state) || typeof s.cwd !== 'string')) {
        throw new Error('Некорректный формат хранилища');
      }
      return parsed.sessions;
    };
    if (fs.existsSync(this.file)) {
      try { this.sessions = decode(this.file); }
      catch (error) {
        const preserved = path.join(directory, `sessions.corrupt-${Date.now()}.json`);
        fs.renameSync(this.file, preserved);
        try {
          this.sessions = decode(`${this.file}.backup`);
          this.warning = 'Список сессий восстановлен из резервной копии. Повреждённый файл сохранён.';
        } catch {
          // Never turn a broken store into a seemingly empty, successful workspace.
          fs.renameSync(preserved, this.file);
          throw new Error(`Не удалось прочитать сохранённые сессии. Файлы сохранены в ${directory}`);
        }
      }
    }
    for (const session of this.sessions) {
      if (session.state === 'running' || session.state === 'paused') session.state = 'interrupted';
      delete session.pid;
      // Older versions titled imported dialogs with the whole first prompt.
      if (session.imported && session.kind !== 'shell' && typeof session.title === 'string' && session.title.length > 80) session.title = shortTitle(session.title);
    }
    this.save();
  }
  list() { return structuredClone(this.sessions); }
  get(id) {
    const session = this.sessions.find(s => s.id === id);
    if (!session) throw new Error('Сессия не найдена');
    return structuredClone(session);
  }
  create(input) {
    const kind = input.kind || 'shell';
    if (!kinds.has(kind)) throw new Error('Неизвестный тип сессии');
    const cwd = path.resolve(input.cwd || os.homedir());
    if (!fs.statSync(cwd).isDirectory()) throw new Error('Рабочая папка не найдена');
    const now = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(), kind, cwd,
      title: String(input.title || `${labels[kind]} · ${path.basename(cwd)}`).slice(0, 160),
      createdAt: now, updatedAt: now, state: 'ready', pinned: false, archived: false,
      host: kind === 'ssh' ? input.host : undefined,
      port: kind === 'ssh' && input.port !== undefined && input.port !== '' && input.port !== null ? Number(input.port) : undefined,
      resumeId: input.resumeId || undefined,
      imported: Boolean(input.resumeId),
      command: kind === 'shell' ? startupCommand(input.command) : undefined,
      autostart: kind === 'shell' && Boolean(input.autostart) && Boolean(startupCommand(input.command)),
    };
    launchSpec(session);
    this.sessions.push(session);
    this.save();
    return structuredClone(session);
  }
  update(id, patch) {
    const allowed = new Set(['title', 'cwd', 'state', 'pinned', 'archived', 'resumeId', 'pid', 'exitCode', 'lastStartedAt', 'updatedAt', 'error', 'command', 'autostart']);
    if (Object.keys(patch).some(k => !allowed.has(k))) throw new Error('Изменение этого поля запрещено');
    if (Object.hasOwn(patch, 'command') || Object.hasOwn(patch, 'autostart')) {
      const existing = this.sessions.find(s => s.id === id);
      if (existing && existing.kind !== 'shell') throw new Error('Команда при запуске доступна только для терминала');
      if (Object.hasOwn(patch, 'command')) patch.command = startupCommand(patch.command);
      if (Object.hasOwn(patch, 'autostart')) patch.autostart = Boolean(patch.autostart);
    }
    if (patch.state && !states.has(patch.state)) throw new Error('Некорректное состояние');
    if (patch.resumeId && !UUID.test(patch.resumeId)) throw new Error('Некорректный ID диалога');
    if (patch.cwd && (!path.isAbsolute(patch.cwd) || !fs.statSync(patch.cwd).isDirectory())) throw new Error('Папка не найдена');
    const i = this.sessions.findIndex(s => s.id === id);
    if (i < 0) throw new Error('Сессия не найдена');
    this.sessions[i] = { ...this.sessions[i], ...patch, updatedAt: new Date().toISOString() };
    this.save();
    return structuredClone(this.sessions[i]);
  }
  save() {
    try {
    if (fs.existsSync(this.file)) {
      fs.copyFileSync(this.file, `${this.file}.backup`);
      fs.chmodSync(`${this.file}.backup`, 0o600);
    }
    atomicJSON(this.file, { version: 1, sessions: this.sessions });
    this.persistenceError = null;
    } catch (cause) {
      const error = new Error(`Не удалось сохранить список сессий: ${cause.message}`, { cause });
      error.code = 'HARBOR_PERSISTENCE'; this.persistenceError = error.message; throw error;
    }
  }
  remove(id) {
    const i = this.sessions.findIndex(s => s.id === id);
    if (i < 0) throw new Error('Сессия не найдена');
    this.sessions.splice(i, 1); this.save();
    fs.rmSync(path.join(this.directory, 'screens', `${id}.json`), { force: true });
  }
  snapshot(id, screen) {
    this.get(id);
    atomicJSON(path.join(this.directory, 'screens', `${id}.json`), { cols: screen.cols, rows: screen.rows, data: screen.data, savedAt: new Date().toISOString() });
  }
  screen(id) {
    this.get(id);
    try { return JSON.parse(fs.readFileSync(path.join(this.directory, 'screens', `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { cols: 100, rows: 30, data: '' }; throw new Error('Сохранённый вывод повреждён; файл оставлен без изменений'); }
  }
}

function readableText(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 1200) : '';
}
// A first prompt makes a poor card title: keep its opening words.
function shortTitle(text, max = 60) {
  text = readableText(text);
  if (text.length <= max) return text;
  let cut = text.slice(0, max), space = cut.lastIndexOf(' ');
  if (space >= max / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s,.;:!?—–-]+$/, '') + '…';
}
function promptText(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(p => ['text', 'input_text'].includes(p.type)).map(p => p.text || '').join('\n') : '';
  if (/^\s*(?:# AGENTS\.md instructions|<(?:(?:environment_context|system-reminder|local-command|command-name|task-notification|ide_opened_file|ide_selection|permissions instructions|skills_instructions)\b))/.test(text)) return '';
  if (/^\s*\/[\w-]+(?:\s|$)/.test(text)) return '';
  return readableText(text);
}

async function scanConversations(home = os.homedir(), options = {}) {
  const result = [];
  const claudePrompts = new Map();
  let history;
  try {
    history = await fs.promises.open(path.join(home, '.claude/history.jsonl'), 'r');
    const { size } = await history.stat(), start = Math.max(0, size - 8 * 1024 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
    const { bytesRead } = await history.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8', 0, bytesRead);
    for (const line of (start ? text.slice(text.indexOf('\n') + 1) : text).split('\n')) {
      try {
        const record = JSON.parse(line), prompt = promptText(record.display);
        if (UUID.test(record.sessionId || '') && prompt && !claudePrompts.has(record.sessionId)) claudePrompts.set(record.sessionId, { prompt, cwd: record.project });
      } catch {}
    }
  } catch {} finally { await history?.close(); }
  const codexHome = options.codexHome || (home === os.homedir() && process.env.CODEX_HOME) || path.join(home, '.codex');
  try {
    const databases = (await fs.promises.readdir(codexHome)).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (databases.length) {
      const database = path.join(codexHome, databases[0]);
      const schema = await execute('/usr/bin/sqlite3', ['-readonly', '-json', database, 'PRAGMA table_info(threads)'], { timeout: 5000 });
      const columns = new Set(JSON.parse(schema.stdout || '[]').map(column => column.name));
      const optional = ['name', 'first_user_message'].filter(column => columns.has(column)).map(column => `substr(${column}, 1, 1200) AS ${column}`);
      const { stdout } = await execute('/usr/bin/sqlite3', ['-readonly', '-json', database, `SELECT id, cwd, substr(title, 1, 1200) AS title, updated_at, created_at${optional.length ? ', ' + optional.join(', ') : ''} FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 300`], { maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
      for (const record of JSON.parse(stdout || '[]')) {
        if (UUID.test(record.id) && typeof record.cwd === 'string') result.push({ kind: 'codex', resumeId: record.id, cwd: record.cwd, title: readableText(record.name) || shortTitle(readableText(record.title) || promptText(record.first_user_message)) || `Диалог без названия · ${record.id.slice(0, 8)}`, preview: promptText(record.first_user_message), date: new Date(record.updated_at * 1000).toISOString(), modified: record.updated_at * 1000 });
      }
    }
  } catch { /* Older installations use JSONL only. Leave the CLI's database untouched. */ }
  const files = [];
  async function walk(dir, kind, depth) {
    if (depth < 0 || files.length > 12000) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'subagents') await walk(file, kind, depth - 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
        const stat = await fs.promises.stat(file).catch(() => null);
        if (stat && (!options.since || stat.mtimeMs >= options.since)) files.push({ file, kind, modified: stat.mtimeMs });
      }
    }
  }
  await walk(path.join(home, '.claude', 'projects'), 'claude', 1);
  await walk(path.join(codexHome, 'sessions'), 'codex', 3);
  files.sort((a, b) => b.modified - a.modified);
  for (const item of files.slice(0, options.limit || 300)) {
    let handle;
    try {
      handle = await fs.promises.open(item.file, 'r');
      const buffer = Buffer.alloc(512 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      let records = buffer.toString('utf8', 0, bytesRead).split('\n');
      const { size } = await handle.stat();
      if (size > buffer.length) {
        const tail = await handle.read(buffer, 0, buffer.length, size - buffer.length);
        const text = buffer.toString('utf8', 0, tail.bytesRead);
        records = records.concat(text.slice(text.indexOf('\n') + 1).split('\n'));
      }
      let metadata, customTitle = '', generatedTitle = '', summary = '', preview = '';
      for (const line of records) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (item.kind === 'claude' && record.sessionId && record.sessionId !== path.basename(item.file, '.jsonl')) continue;
        if (item.kind === 'codex' && record.type === 'session_meta') {
          metadata = { resumeId: record.payload.id, cwd: record.payload.cwd };
        }
        if (item.kind === 'claude' && record.sessionId && record.cwd && !record.isSidechain) {
          metadata = { resumeId: record.sessionId, cwd: record.cwd };
        }
        if (item.kind === 'claude') {
          if (record.type === 'custom-title') customTitle = readableText(record.customTitle);
          if (record.type === 'ai-title') generatedTitle = readableText(record.aiTitle);
          if (record.type === 'summary') summary = readableText(record.summary);
          if (!preview && record.type === 'user' && !record.isMeta && !record.isSidechain && !record.isCompactSummary && !record.isVisibleInTranscriptOnly) preview = promptText(record.message?.content);
        } else if (!preview) {
          if (record.type === 'event_msg' && record.payload?.type === 'user_message') preview = promptText(record.payload.message);
          if (record.type === 'response_item' && record.payload?.role === 'user') preview = promptText(record.payload.content);
        }
      }
      if (item.kind === 'claude') {
        const id = path.basename(item.file, '.jsonl'), entry = claudePrompts.get(id);
        if (entry) { if (!preview) preview = entry.prompt; if (!metadata && entry.cwd) metadata = { resumeId: id, cwd: entry.cwd }; }
      }
      if (metadata && UUID.test(metadata.resumeId) && typeof metadata.cwd === 'string' && !result.some(s => s.resumeId === metadata.resumeId)) {
        result.push({ ...metadata, kind: item.kind, title: customTitle || shortTitle(generatedTitle || summary || preview) || `Диалог без названия · ${metadata.resumeId.slice(0, 8)}`, preview, date: new Date(item.modified).toISOString(), modified: item.modified });
      }
    } catch { /* A CLI may rotate its files while we scan. */ }
    finally { if (handle) await handle.close(); }
  }
  return result.sort((a, b) => (Date.parse(b.date) || b.modified) - (Date.parse(a.date) || a.modified));
}

function socketPath(directory) {
  return path.join('/tmp', `harbor-${process.getuid()}-${crypto.createHash('sha256').update(directory).digest('hex').slice(0, 16)}.sock`);
}

// Plain text of a serialized xterm screen. The serializer encodes runs of blanks as
// cursor-forward (ESC[nC), so those become spaces before the rest of the escapes go.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;
function screenText(data) {
  return String(data)
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(Number(n) || 1, 1000)))
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map(line => line.replace(/[\u0000-\u001f\u007f]/g, ''));
}

module.exports = { shortTitle, screenText, SessionStore, launchSpec, scanConversations, atomicJSON, quoteShell, socketPath, verifySocketOwner, readSettings, writeSettings, normalizeSettings, scrollbackOptions, startupCommand, UUID };
