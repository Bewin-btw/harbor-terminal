import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import './styles.css';
import { themes, terminalTheme } from './themes.js';
import { connectScrollbar } from './scrollbar.js';
import { connectNativeTerminal } from './native-terminal.js';
const api = window.harbor;
const $ = id => document.getElementById(id);
const icons = { shell: '›_', claude: '✳', codex: '◇', ssh: '↗' };
const names = { shell: 'Терминал', claude: 'Claude', codex: 'Codex', ssh: 'SSH' };
const states = { running: 'Работает', paused: 'На паузе', interrupted: 'Прервана', exited: 'Завершена', ready: 'Готова к открытию', saved: 'Сохранена' };
let sessions = [], selected = null, archived = false, selectedKind = 'shell', info;
let terminal, fit, searchAddon, epoch = 0, acceptingInput = false, pendingOutput = [], conversations = [], bindingId = null, renamingId = null;
let toastTimer, resizeTimer, switching = false, disposeScrollbar;
let activities = {}, draggedId = null;
let nativeTerminal;
let gitInfo = {}, side = null, scrollback = 4000;
let grouped = localStorage.getItem('groupByProject') === '1';
let collapsedGroups; try { collapsedGroups = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]')); } catch { collapsedGroups = new Set(); }
const terminalOptions = () => ({ fontFamily: '"SF Mono", Menlo, Monaco, monospace', fontSize, lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar', scrollback, smoothScrollDuration: 100, macOptionIsMeta: true, allowProposedApi: true, theme: terminalTheme(activeTheme) });
const appShortcut = event => !(event.metaKey && ['c', 'v', 'k', 'n', 'o', 'f', 't', 'd'].includes(event.key.toLowerCase()));
const projectOf = s => gitInfo[s.id]?.root || s.cwd;
const baseName = p => p.split('/').filter(Boolean).pop() || '/';
let sessionOrder; try { sessionOrder = JSON.parse(localStorage.getItem('sessionOrder') || '[]'); } catch { sessionOrder = []; }
if (!Array.isArray(sessionOrder)) sessionOrder = [];
let activeTheme = themes.find(t => t.id === localStorage.getItem('theme')) || themes[0];
const activityLabels = { working: 'Работает', attention: 'Требуется действие', completed: 'Ответ завершён', idle: 'Ждёт сообщения', unknown: 'Сессия открыта' };
function statusOf(s) {
  if (s.state !== 'running' || !['claude', 'codex'].includes(s.kind)) return { key: s.state, label: states[s.state], detail: 'Состояние процесса' };
  const status = activities[s.id] || { state: 'unknown' };
  const sources = { 'claude-native': 'Статус Claude Code', 'codex-journal': 'По событиям локального журнала Codex', 'codex-screen': 'По текущему экрану Codex; распознавание зависит от версии CLI' };
  return { key: status.state, label: activityLabels[status.state] || activityLabels.unknown, detail: sources[status.source] || 'CLI пока не сообщил состояние ответа' };
}
function applyTheme(theme) {
  activeTheme = theme; document.documentElement.dataset.theme = theme.id; document.documentElement.style.colorScheme = theme.light ? 'light' : 'dark';
  for (const [key, value] of Object.entries(theme.colors)) document.documentElement.style.setProperty('--' + key, value);
  localStorage.setItem('theme', theme.id); $('theme-name').textContent = theme.name;
  if (terminal) terminal.options.theme = terminalTheme(theme);
  if (side) side.terminal.options.theme = terminalTheme(theme);
  for (const option of document.querySelectorAll('[data-theme-option]')) option.setAttribute('aria-pressed', String(option.dataset.themeOption === theme.id));
}
function openThemes() {
  const options = $('theme-options'); options.replaceChildren();
  for (const theme of themes) {
    const button = element('button', 'theme-option'); button.dataset.themeOption = theme.id; button.setAttribute('aria-pressed', String(theme.id === activeTheme.id));
    const preview = element('span', 'theme-preview'); preview.style.background = theme.colors.bg; preview.style.color = theme.colors.text;
    preview.append(element('span', '', '›_'));
    for (const key of ['accent', 'claude', 'codex']) { const dot = element('i'); dot.style.background = theme.colors[key]; preview.append(dot); }
    button.append(preview, element('strong', '', theme.name), element('small', '', theme.description)); button.onclick = () => applyTheme(theme); options.append(button);
  }
  $('theme-dialog').showModal();
}
function orderedSessions() {
  const ranks = new Map(sessionOrder.map((id, index) => [id, index]));
  return [...sessions].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || a.createdAt.localeCompare(b.createdAt));
}
async function moveSession(id, targetId, after = false) {
  if (id === targetId) return;
  const moving = sessions.find(s => s.id === id), target = sessions.find(s => s.id === targetId);
  if (!moving || !target) return;
  if (Boolean(moving.pinned) !== Boolean(target.pinned)) await run('update', { id, patch: { pinned: Boolean(target.pinned) } });
  const order = orderedSessions().map(s => s.id).filter(item => item !== id);
  order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, id); sessionOrder = order;
  localStorage.setItem('sessionOrder', JSON.stringify(order)); renderList();
  $('session-list').querySelector(`[data-id="${id}"]`)?.focus();
}
let fontSize = Math.min(24, Math.max(10, Number(localStorage.getItem('fontSize')) || 13));
const current = () => sessions.find(s => s.id === selected);
const live = s => s && ['running', 'paused'].includes(s.state);
const shortPath = p => info && p.startsWith(info.home) ? '~' + p.slice(info.home.length) : p;
function toast(message, error = false) {
  message = message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  if (/Изменение этого поля запрещено|Неизвестная операция/.test(message)) message += ' — менеджер сессий запущен из старой версии. Harbor → «Перезапустить менеджер сессий…».';
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 11000 : 5000); }
async function run(method, params = {}) { try { return await api.request(method, params); } catch (error) { toast(error.message, true); throw error; } }
function element(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
function matchingSessions() {
  const query = $('session-search').value.trim().toLowerCase();
  return orderedSessions().filter(s => Boolean(s.archived) === archived && `${s.title} ${s.cwd} ${names[s.kind]} ${gitInfo[s.id]?.branch || ''}`.toLowerCase().includes(query));
}
const searching = () => Boolean($('session-search').value.trim());
const isCollapsed = key => collapsedGroups.has(key) && !searching();
// Sidebar layout: rows are sessions, section labels or project headers, in display order.
function sidebarRows() {
  const list = matchingSessions(), rows = [];
  if (archived) return list;
  if (!grouped) {
    let lastPinned = null;
    for (const s of list) {
      if (s.pinned !== lastPinned && (s.pinned || lastPinned === true)) rows.push({ label: s.pinned ? 'ЗАКРЕПЛЁННЫЕ' : 'ОСТАЛЬНЫЕ' });
      lastPinned = s.pinned; rows.push(s);
    }
    return rows;
  }
  const pinned = list.filter(s => s.pinned), projects = new Map();
  if (pinned.length) rows.push({ label: 'ЗАКРЕПЛЁННЫЕ' }, ...pinned);
  for (const s of list) if (!s.pinned) { const key = projectOf(s); if (!projects.has(key)) projects.set(key, []); projects.get(key).push(s); }
  for (const [key, items] of projects) { rows.push({ group: key, sessions: items }); if (!isCollapsed(key)) rows.push(...items); }
  return rows;
}
function visibleSessions() { return sidebarRows().filter(row => row.id); }
function groupHeader({ group, sessions: items }) {
  const collapsed = isCollapsed(group);
  const header = element('button', 'group-label'); header.setAttribute('aria-expanded', String(!collapsed)); header.title = shortPath(group);
  header.append(element('span', 'chevron', collapsed ? '▸' : '▾'), element('span', 'group-name', baseName(group)), element('span', 'group-count', String(items.length)));
  if (collapsed && items.some(s => s.state === 'running' && ['attention', 'completed'].includes(activities[s.id]?.state))) header.append(element('span', 'status-dot attention'));
  header.onclick = () => { if (collapsedGroups.has(group)) collapsedGroups.delete(group); else collapsedGroups.add(group); localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups])); renderList(); };
  return header;
}
function renderList() {
  const list = $('session-list'); const focusedId = list.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null; list.replaceChildren();
  const rows = sidebarRows(), visible = rows.filter(row => row.id);
  $('group-toggle').setAttribute('aria-pressed', String(grouped)); $('group-toggle').hidden = archived;
  $('clean-archive').hidden = !archived || !sessions.some(s => s.archived && !live(s));
  const interrupted = resumable().length; $('resume-all').hidden = !interrupted || archived; $('resume-count').textContent = interrupted || '';
  $('session-count').textContent = String(matchingSessions().length);
  $('archive-count').textContent = sessions.filter(s => s.archived).length || '';
  $('list-label').textContent = archived ? 'АРХИВ' : 'СЕССИИ';
  $('archive-toggle').classList.toggle('selected', archived);
  for (const s of rows) {
    if (s.label) { list.append(element('div', 'section-label', s.label)); continue; }
    if (s.group) { list.append(groupHeader(s)); continue; }
    const status = statusOf(s);
    const row = element('button', `session-row${selected === s.id ? ' active' : ''}`); row.dataset.id = s.id; row.setAttribute('aria-label', `${s.title}, ${status.label}`); row.setAttribute('aria-current', selected === s.id ? 'true' : 'false');
    row.title = `${s.title} · ${status.label}\n${status.detail}\nПеретащи для изменения порядка · Option+↑ / ↓`;
    row.draggable = true; row.append(element('span', 'drag-handle', '⠿'));
    row.ondragstart = event => { draggedId = s.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', s.id); row.classList.add('drag-source'); };
    row.ondragover = event => { if (!draggedId || draggedId === s.id) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.toggle('drop-after', event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2); row.classList.add('drop-target'); };
    row.ondragleave = () => row.classList.remove('drop-target', 'drop-after');
    row.ondrop = event => { event.preventDefault(); const id = draggedId; draggedId = null; moveSession(id, s.id, row.classList.contains('drop-after')).catch(() => {}); };
    row.ondragend = () => { draggedId = null; renderList(); };
    row.onkeydown = event => { if (!event.altKey || event.metaKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; const target = visible[visible.findIndex(item => item.id === s.id) + direction]; if (target) moveSession(s.id, target.id, direction > 0).catch(() => {}); };
    row.append(element('span', `kind-icon ${s.kind}`, icons[s.kind]));
    const copy = element('span', 'session-copy'); copy.append(element('span', 'session-name', s.title));
    const meta = element('span', 'session-meta'); meta.append(element('span', `status-dot ${status.key}`), element('span', 'status-label', status.label), element('span', '', '·'), element('span', 'folder', baseName(s.cwd)));
    if (gitInfo[s.id]?.branch) meta.append(element('span', 'branch', '⎇ ' + gitInfo[s.id].branch));
    copy.append(meta); row.append(copy);
    if (s.state === 'running' && activities[s.id]?.update) { const mark = element('span', 'update-marker', '↻'); mark.title = 'Claude Code обновился. Правый клик → «Перезапустить с тем же диалогом»'; row.append(mark); }
    if (s.pinned) row.append(element('span', 'pinned-marker', '⌑'));
    row.onclick = () => selectSession(s.id).catch(() => {}); row.oncontextmenu = e => { e.preventDefault(); api.context(s); }; list.append(row);
  }
  if (focusedId) list.querySelector(`[data-id="${focusedId}"]`)?.focus();
  if (!rows.length) list.append(element('div', 'list-empty', $('session-search').value ? 'Сессии не найдены' : archived ? 'В архиве пока пусто' : 'Здесь появятся твои сессии.\nСоздай первую или добавь сохранённый диалог.'));
}
function renderHeader() {
  const s = current(); $('session-controls').hidden = !s;
  $('current-title').textContent = s?.title || 'Рабочее пространство'; $('current-path').textContent = s ? shortPath(s.cwd) + (gitInfo[s.id]?.branch ? `  ·  ⎇ ${gitInfo[s.id].branch}` : '') : 'Все терминалы в одном месте';
  $('current-icon').textContent = s ? icons[s.kind] : '⌘'; $('current-icon').className = `kind-icon ${s?.kind || ''}`;
  if (!s) { $('session-banner').hidden = true; return; }
  const status = statusOf(s); $('current-state').textContent = status.label; $('current-state').className = `state-tag ${status.key}`; $('current-state').title = status.detail;
  $('pin-button').classList.toggle('selected', s.pinned); $('pin-button').title = s.pinned ? 'Открепить' : 'Закрепить';
  $('pause-button').textContent = s.state === 'paused' ? '▷ Продолжить' : 'Ⅱ Пауза'; $('pause-button').disabled = !live(s);
  $('footer-left').textContent = `${names[s.kind]}${s.pid ? ' · PID ' + s.pid : ''}${s.resumeId ? ' · диалог ' + s.resumeId.slice(0, 8) : ''}`;
  $('footer-left').title = s.resumeId || '';
  if (terminal) terminal.options.disableStdin = s.state !== 'running';
  nativeTerminal?.updateSession(s);
  $('session-banner').hidden = s.state === 'running';
  const messages = {
    paused: ['Сессия на паузе', 'Локальные процессы остановлены. Память сохраняется; сетевые соединения могут истечь.', 'Продолжить'],
    interrupted: ['Работа была прервана', s.kind === 'claude' || s.kind === 'codex' ? 'Сохранённый диалог можно продолжить. Незавершённые команды и запросы не восстанавливаются.' : 'Ниже сохранённый вывод. Предыдущий процесс завершился; команды не будут повторены.', s.resumeId ? 'Продолжить диалог' : 'Открыть заново'],
    exited: ['Процесс завершён' + (s.exitCode !== undefined ? ` · код ${s.exitCode}` : ''), s.error || 'Вывод сохранён. Можно снова открыть сессию или отправить её в архив.', s.resumeId ? 'Продолжить диалог' : 'Открыть заново'],
    saved: ['Сессия сохранена', 'Процесс завершён и больше не занимает ресурсы. Ниже сохранённый вывод.', s.resumeId ? 'Продолжить диалог' : 'Открыть заново'],
    ready: ['Диалог готов к открытию', 'Перед продолжением заверши его старый экземпляр, если он ещё работает в другом терминале.', 'Продолжить диалог'],
  };
  if (messages[s.state]) { const [title, detail, action] = messages[s.state]; $('banner-title').textContent = title; $('banner-detail').textContent = detail; $('banner-action').textContent = s.archived ? 'Вернуть из архива' : (s.kind === 'codex' && s.lastStartedAt && !s.resumeId ? 'Выбрать диалог' : action); }
}
function fitTerminal() {
  if (!terminal || !selected || $('terminal-shell').hidden || switching) return;
  try { fit.fit(); api.request('resize', { id: selected, cols: terminal.cols, rows: terminal.rows }).catch(() => {}); } catch {}
}
function makeTerminal(cols, rows) {
  disposeScrollbar?.(); nativeTerminal?.dispose(); nativeTerminal = null; terminal?.dispose(); $('terminal').replaceChildren();
  terminal = new Terminal({ cols, rows, ...terminalOptions() });
  fit = new FitAddon(); searchAddon = new SearchAddon(); terminal.loadAddon(fit); terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon((event, uri) => { if (event.metaKey || event.ctrlKey) api.openExternal(uri); }));
  terminal.open($('terminal'));
  let refreshScrollbar = () => {};
  if (['claude', 'codex'].includes(current()?.kind)) nativeTerminal = connectNativeTerminal(terminal, { api, session: current(), active: () => acceptingInput && !switching, changed: () => refreshScrollbar() });
  disposeScrollbar = connectScrollbar(terminal, $('terminal-scrollbar'), $('terminal-scroll-thumb'), nativeTerminal);
  refreshScrollbar = disposeScrollbar.update;
  terminal.onData(data => { if (acceptingInput && current()?.state === 'running') api.request('input', { id: selected, data }).catch(error => toast(error.message, true)); });
  terminal.onTitleChange(title => { $('current-title').title = title; });
  terminal.attachCustomKeyEventHandler(appShortcut);
}
async function selectSession(id) {
  const token = ++epoch;
  const cols = terminal?.cols || 100, rows = terminal?.rows || 30;
  if (side?.id === id) closeSide();
  selected = id; acceptingInput = false; pendingOutput = []; switching = true;
  api.request('viewing', { id }).catch(() => {});
  localStorage.setItem('selectedSession', id); renderList(); renderHeader();
  $('welcome').hidden = true; $('terminal-shell').hidden = false; $('find-bar').hidden = true;
  // Install and focus the target terminal synchronously. Keys typed while the
  // snapshot is in flight go to the target PTY instead of a soon-disposed view.
  makeTerminal(cols, rows); acceptingInput = true;
  if (!document.querySelector('dialog[open]')) terminal.focus();
  try {
    const view = await run('attach', { id }); if (token !== epoch) return;
    terminal.resize(view.cols || 100, view.rows || 30);
    await new Promise(resolve => terminal.write(view.data || '', resolve)); if (token !== epoch) return;
    for (const chunk of pendingOutput) terminal.write(chunk); pendingOutput = [];
    acceptingInput = true; switching = false; renderHeader(); fitTerminal();
    if (!document.querySelector('dialog[open]')) terminal.focus();
  } catch { if (token === epoch) { switching = false; acceptingInput = false; } }
}
function openNew(kind = 'shell') {
  selectedKind = kind; $('new-title').value = ''; $('new-cwd').value = current()?.cwd || info.home; $('new-host').value = ''; $('new-port').value = ''; $('new-command').value = '';
  updateKind(); $('new-dialog').showModal(); $('new-title').focus();
}
function updateKind() {
  document.querySelectorAll('[data-kind]').forEach(button => button.classList.toggle('selected', button.dataset.kind === selectedKind));
  $('ssh-fields').hidden = selectedKind !== 'ssh'; $('shell-fields').hidden = selectedKind !== 'shell'; $('new-host').required = selectedKind === 'ssh';
  $('new-kind-note').textContent = { shell: 'Твоя обычная оболочка, команды и настройки.', claude: 'Новый диалог Claude Code. Сохраняем его ID для продолжения после перезапуска.', codex: 'Создадим новый диалог Codex и сохраним его ID для продолжения после перезапуска.', ssh: 'Для сохранения удалённой задачи после разрыва связи запускай её внутри tmux на сервере.' }[selectedKind];
  $('create-button').textContent = selectedKind === 'ssh' ? 'Подключиться ↗' : `Открыть ${names[selectedKind]} ↗`;
}
async function createSession(event) {
  event.preventDefault(); const button = $('create-button'); button.disabled = true;
  try {
    const raw = $('new-cwd').value.trim(); const cwd = raw === '~' ? info.home : raw.startsWith('~/') ? info.home + raw.slice(1) : raw;
    const s = await run('create', { kind: selectedKind, title: $('new-title').value.trim(), cwd, host: $('new-host').value.trim(), port: $('new-port').value ? Number($('new-port').value) : undefined, ...(selectedKind === 'shell' && $('new-command').value.trim() ? { command: $('new-command').value.trim() } : {}) });
    if (!sessions.some(item => item.id === s.id)) sessions.push(s);
    archived = false; $('session-search').value = ''; $('new-dialog').close(); await selectSession(s.id);
  } finally { button.disabled = false; }
}
async function openImport(bind = null) {
  bindingId = bind; $('import-heading').textContent = bind ? 'Привязать диалог к сессии' : 'Продолжить начатое';
  $('import-search').value = ''; $('import-list').replaceChildren(element('div', 'list-empty', 'Ищем сохранённые диалоги…'));
  $('import-dialog').showModal(); $('import-search').focus();
  try { conversations = await run('scan'); renderImports(); } catch { $('import-list').replaceChildren(element('div', 'list-empty', 'Не удалось прочитать историю. Закрой окно и попробуй снова.')); }
}
function renderImports() {
  const list = $('import-list'); list.replaceChildren(); const query = $('import-search').value.toLowerCase();
  const target = sessions.find(s => s.id === bindingId);
  const visible = conversations.filter(c => (!target || c.kind === target.kind) && `${c.title} ${c.preview || ''} ${c.cwd} ${c.resumeId} ${c.kind}`.toLowerCase().includes(query));
  for (const c of visible) {
    const button = element('button', 'import-row'); button.append(element('span', `kind-icon ${c.kind}`, icons[c.kind]));
    button.title = `${names[c.kind]} — ${c.title}\n${c.preview && c.preview !== c.title ? c.preview + '\n' : ''}${c.cwd}\nID: ${c.resumeId}`;
    button.setAttribute('aria-label', `${names[c.kind]}: ${c.title}`);
    const copy = element('span', 'import-copy'); copy.append(element('strong', '', c.title));
    if (c.preview && c.preview !== c.title) copy.append(element('span', 'import-preview', c.preview));
    const meta = element('span', 'import-meta');
    meta.append(element('span', `provider-label ${c.kind}`, names[c.kind]), element('small', '', `${shortPath(c.cwd)} · ${c.resumeId.slice(0, 8)}`));
    copy.append(meta); button.append(copy);
    const date = new Date(c.date || c.modified);
    const dateLabel = element('span', 'import-date', date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }));
    dateLabel.append(element('span', 'import-time', date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })));
    dateLabel.title = `Последняя активность: ${date.toLocaleString('ru-RU')}`;
    button.append(dateLabel);
    button.onclick = async () => {
      button.disabled = true;
      try {
        let session;
        if (bindingId) session = await run('update', { id: bindingId, patch: { resumeId: c.resumeId } });
        else session = await run('create', { kind: c.kind, title: c.title, cwd: c.cwd, resumeId: c.resumeId, start: false });
        if (!sessions.some(s => s.id === session.id)) sessions.push(session);
        $('import-dialog').close(); archived = Boolean(session.archived); $('session-search').value = ''; await selectSession(session.id);
        toast(bindingId ? 'Диалог привязан. Теперь можно продолжить.' : 'Диалог добавлен. Нажми «Продолжить диалог», когда будешь готов.');
      } catch {} finally { button.disabled = false; }
    };
    list.append(button);
  }
  if (!visible.length) list.append(element('div', 'list-empty', query ? 'Совпадений нет' : 'Сохранённые диалоги не найдены. Здесь появятся локальные сессии Claude Code и Codex.'));
}
async function pauseOrResume() {
  const s = current(); if (!s || !live(s)) return;
  if (s.state === 'paused') { await run('resume', { id: s.id }); terminal?.focus(); return; }
  const confirmed = await api.confirm({ title: 'Приостановить сессию?', detail: 'Локальные процессы этой сессии остановятся. Сетевой запрос Claude/Codex или SSH-соединение может истечь по таймауту. Удалённые задачи на сервере продолжат работать. Пауза не освобождает память и не переживает перезагрузку.', action: 'Приостановить' });
  if (confirmed) await run('pause', { id: s.id });
}
async function startCurrent() {
  const s = current(); if (!s) return;
  if (s.archived) { await run('update', { id: s.id, patch: { archived: false } }); archived = false; renderList(); return; }
  if (s.state === 'paused') return pauseOrResume();
  if (s.kind === 'codex' && s.lastStartedAt && !s.resumeId) return openImport(s.id);
  if (s.imported && !s.lastStartedAt) {
    const confirmed = await api.confirm({ title: 'Продолжить сохранённый диалог?', detail: 'Убедись, что этот диалог уже завершён в старом терминале. Одновременная работа двух экземпляров с одной историей может привести к конфликтам.', action: 'Продолжить диалог' });
    if (!confirmed) return;
  }
  await run('start', { id: s.id }); await selectSession(s.id);
}
async function stopCurrent(id) {
  const s = sessions.find(session => session.id === id); if (!live(s)) return;
  const confirmed = await api.confirm({ title: `Завершить «${s.title}»?`, detail: 'Сначала дождись завершения ответа агента или команды. Процесс и его дочерние задачи получат сигнал завершения. Незаконченные операции могут быть прерваны. Для Claude/Codex предпочтительно штатно выйти через /exit или Ctrl+D.', action: 'Завершить процесс' });
  if (confirmed) await run('stop', { id: s.id });
}
async function action(name, id = selected) {
  const s = sessions.find(item => item.id === id);
  switch (name) {
    case 'themes': return openThemes();
    case 'new': return openNew();
    case 'import': return openImport();
    case 'search': $('session-search').focus(); $('session-search').select(); return;
    case 'find': if (terminal) { $('find-bar').hidden = false; $('find-input').focus(); $('find-input').select(); } return;
    case 'copy': {
      const focused = document.activeElement;
      const text = focused instanceof HTMLInputElement ? focused.value.slice(focused.selectionStart, focused.selectionEnd) : window.getSelection()?.toString() || terminal?.getSelection();
      if (text) await api.copy(text); return;
    }
    case 'paste': {
      const text = await api.paste(); const focused = document.activeElement;
      if (focused instanceof HTMLInputElement) { focused.setRangeText(text, focused.selectionStart, focused.selectionEnd, 'end'); focused.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (terminal && current()?.state === 'running') terminal.paste(text);
      return;
    }
    case 'font-up': case 'font-down': case 'font-reset':
      fontSize = name === 'font-reset' ? 13 : Math.min(24, Math.max(10, fontSize + (name === 'font-up' ? 1 : -1))); localStorage.setItem('fontSize', fontSize); if (terminal) { terminal.options.fontSize = fontSize; fitTerminal(); } if (side) { side.terminal.options.fontSize = fontSize; fitSide(); } return;
    case 'rename': if (s) { renamingId = s.id; $('rename-input').value = s.title; $('rename-dialog').showModal(); $('rename-input').select(); } return;
    case 'pin': if (s) await run('update', { id, patch: { pinned: !s.pinned } }); return;
    case 'archive': if (s) { await run('update', { id, patch: { archived: !s.archived } }); renderList(); renderHeader(); } return;
    case 'bind': return openImport(id);
    case 'stop': return stopCurrent(id);
    case 'select': if (s) { archived = Boolean(s.archived); $('session-search').value = ''; collapsedGroups.delete(projectOf(s)); await selectSession(id); } return;
    case 'shell-here': return shellHere(s || current());
    case 'split': if (s) return openSide(s.id); return;
    case 'split-toggle': {
      if (side) return closeSide();
      const base = current(); if (!base) return openNew();
      const created = await createShell(base); return openSide(created.id);
    }
    case 'command': if (s) { commandId = s.id; $('command-input').value = s.command || ''; $('command-autostart').checked = Boolean(s.autostart); $('command-dialog').showModal(); $('command-input').focus(); } return;
    case 'resume-all': return resumeAll();
    case 'restart': if (s && live(s)) {
      const confirmed = await api.confirm({ title: `Перезапустить «${s.title}»?`, detail: 'Claude Code закроется и сразу откроется снова с этим же диалогом, уже в новой версии. Если он сейчас что-то делает, дождись конца ответа: незавершённый шаг не продолжится.', action: 'Перезапустить' });
      if (!confirmed) return;
      await run('stop', { id }); await run('start', { id }); if (id === selected) await selectSession(id);
    } return;
    case 'delete': if (s) return deleteSessions([s]); return;
    case 'clean-archive': return deleteSessions(sessions.filter(item => item.archived && !live(item)));
    case 'search-all': return openSearchAll();
  }
}

// ---- Shell next to an agent, in the same folder
async function createShell(base) {
  // A shell idle at its prompt in the same folder is reused instead of piling up copies.
  try {
    const id = await api.request('idle-shell', { cwd: base.cwd, exclude: [base.id, selected, side?.id].filter(Boolean) });
    const found = id && sessions.find(item => item.id === id);
    if (found) return { ...found, reused: true };
  } catch {}
  const s = await run('create', { kind: 'shell', cwd: base.cwd, title: `Терминал · ${baseName(base.cwd)}` });
  if (!sessions.some(item => item.id === s.id)) sessions.push(s);
  return s;
}
async function shellHere(base) {
  if (!base) return openNew();
  const s = await createShell(base); archived = false; $('session-search').value = ''; await selectSession(s.id);
  if (s.reused) toast('Открыл свободный терминал в этой папке');
}

// ---- Startup command
let commandId = null;
$('command-form').onsubmit = async event => {
  event.preventDefault();
  const command = $('command-input').value.trim();
  try {
    await run('update', { id: commandId, patch: { command, autostart: Boolean(command) && $('command-autostart').checked } });
    $('command-dialog').close(); toast(command ? 'Команда сохранена. Сработает при следующем открытии сессии.' : 'Команда при запуске убрана.');
  } catch {}
};

// ---- Delete archived cards. Only Harbor's card and saved screen go; the CLI dialog stays.
async function deleteSessions(list) {
  list = list.filter(s => s.archived && !live(s));
  if (!list.length) return toast('В архиве нечего удалять');
  const agents = list.filter(s => ['claude', 'codex'].includes(s.kind)).length;
  const confirmed = await api.confirm({
    title: list.length === 1 ? `Удалить «${list[0].title}»?` : `Удалить из архива все сессии (${list.length})?`,
    detail: `Пропадут карточки и сохранённый вывод терминала, вернуть их нельзя.${agents ? ' Сами диалоги Claude/Codex останутся в их истории, их можно снова открыть через «Импорт диалогов».' : ''}`,
    action: 'Удалить',
  });
  if (!confirmed) return;
  let failed = 0;
  for (const s of list) { try { await api.request('delete', { id: s.id }); } catch (error) { failed++; if (failed === 1) toast(error.message, true); } }
  if (!failed) toast(list.length === 1 ? 'Удалено' : `Удалено: ${list.length}`);
  if (list.some(s => s.id === selected)) {
    const next = sessions.find(s => Boolean(s.archived) === archived && !list.some(item => item.id === s.id)) || sessions.find(s => !s.archived && !list.some(item => item.id === s.id));
    if (next) await selectSession(next.id);
  }
}

// ---- Resume everything that a reboot interrupted
function resumable() { return sessions.filter(s => !s.archived && s.state === 'interrupted' && !(s.kind === 'codex' && !s.resumeId)); }
async function resumeAll() {
  const list = resumable();
  if (!list.length) return toast('Прерванных сессий нет');
  const agents = list.filter(s => ['claude', 'codex'].includes(s.kind)).length;
  const noun = list.length % 10 === 1 && list.length % 100 !== 11 ? 'сессию' : [2, 3, 4].includes(list.length % 10) && ![12, 13, 14].includes(list.length % 100) ? 'сессии' : 'сессий';
  const confirmed = await api.confirm({ title: `Возобновить ${list.length} ${noun}?`, detail: `${agents ? `Claude/Codex (${agents}) продолжат сохранённые диалоги — убедись, что они не открыты в другом терминале. ` : ''}Терминалы откроются заново в своих папках; повторится только заданная «команда при запуске». SSH подключится снова.`, action: 'Возобновить' });
  if (!confirmed) return;
  let failed = 0;
  for (const s of list) { try { await api.request('start', { id: s.id }); } catch { failed++; } }
  toast(failed ? `Возобновлено ${list.length - failed} из ${list.length}. Остальные открой по одной — там будет причина.` : `Возобновлено: ${list.length}`, Boolean(failed));
  if (selected && list.some(s => s.id === selected)) await selectSession(selected);
}

// ---- Split pane: a second, independent view of another session
function fitSide() {
  if (!side?.ready || $('side-pane').hidden) return;
  try { side.fit.fit(); api.request('resize', { id: side.id, cols: side.terminal.cols, rows: side.terminal.rows }).catch(() => {}); } catch {}
}
function closeSide(remember = true) {
  if (!side) return;
  const old = side; side = null; old.terminal.dispose(); $('side-terminal').replaceChildren(); $('side-pane').hidden = true;
  api.request('side-detach').catch(() => {});
  if (remember) localStorage.removeItem('sideSession');
  setTimeout(fitTerminal, 0); terminal?.focus();
}
async function openSide(id) {
  const s = sessions.find(item => item.id === id); if (!s) return;
  if (id === selected) return toast('Эта сессия уже открыта слева');
  closeSide(false);
  $('side-pane').hidden = false; $('side-icon').textContent = icons[s.kind]; $('side-icon').className = `kind-icon ${s.kind}`;
  const term = new Terminal({ cols: 80, rows: 24, ...terminalOptions() });
  const sideFit = new FitAddon(); term.loadAddon(sideFit);
  term.loadAddon(new WebLinksAddon((event, uri) => { if (event.metaKey || event.ctrlKey) api.openExternal(uri); }));
  term.open($('side-terminal'));
  const state = side = { id, terminal: term, fit: sideFit, pending: [], ready: false };
  localStorage.setItem('sideSession', id); renderSide();
  term.onData(data => { if (state.ready && sessions.find(item => item.id === id)?.state === 'running') api.request('input', { id, data }).catch(error => toast(error.message, true)); });
  term.attachCustomKeyEventHandler(appShortcut);
  term.textarea?.addEventListener('focus', () => api.request('viewing', { id }).catch(() => {}));
  term.textarea?.addEventListener('blur', () => api.request('viewing', { id: selected }).catch(() => {}));
  setTimeout(fitTerminal, 0);
  try {
    const view = await run('side-attach', { id }); if (side !== state) return;
    term.resize(view.cols || 100, view.rows || 30);
    await new Promise(resolve => term.write(view.data || '', resolve)); if (side !== state) return;
    for (const chunk of state.pending) term.write(chunk);
    state.pending = []; state.ready = true;
    renderSide(); fitSide(); term.focus();
  } catch { if (side === state) closeSide(); }
}
function renderSide() {
  if (!side) return;
  const s = sessions.find(item => item.id === side.id);
  if (!s) return closeSide();
  $('side-title').textContent = s.state === 'running' ? s.title : `${s.title} · ${(states[s.state] || '').toLowerCase()}`;
  side.terminal.options.disableStdin = s.state !== 'running';
}
$('side-close').onclick = () => closeSide();
$('side-swap').onclick = () => { const id = side?.id; if (id) selectSession(id).catch(() => {}); };

// ---- Drag files into a terminal: paste their escaped paths, like Terminal.app
const escapePath = p => p.replace(/[^\p{L}\p{N}_\-.,:/@+=%~]/gu, '\\$&');
const hasFiles = event => Boolean(event.dataTransfer?.types.includes('Files'));
$('terminal-shell').addEventListener('dragover', event => {
  if (!hasFiles(event)) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; $('drop-hint').hidden = false;
});
$('terminal-shell').addEventListener('dragleave', event => { if (!$('terminal-shell').contains(event.relatedTarget)) $('drop-hint').hidden = true; });
$('terminal-shell').addEventListener('drop', event => {
  $('drop-hint').hidden = true;
  if (!hasFiles(event)) return;
  event.preventDefault();
  const toSide = event.target instanceof Element && Boolean(event.target.closest('#side-pane'));
  const id = toSide ? side?.id : selected, s = sessions.find(item => item.id === id);
  if (!s || s.state !== 'running') return toast('Сессия не запущена — путь некуда вставить', true);
  const paths = [...event.dataTransfer.files].map(file => { try { return api.pathForFile(file); } catch { return ''; } }).filter(Boolean);
  if (paths.length) api.request('input', { id, data: paths.map(escapePath).join(' ') + ' ' }).catch(error => toast(error.message, true));
  (toSide ? side?.terminal : terminal)?.focus();
});
document.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
document.addEventListener('drop', event => { if (hasFiles(event)) event.preventDefault(); });

// ---- Search across every session's saved output
let searchTimer, searchToken = 0;
function openSearchAll() {
  $('search-all-dialog').showModal(); $('search-all-input').select(); $('search-all-input').focus();
  if (!$('search-all-input').value) $('search-all-list').replaceChildren(element('div', 'list-empty', 'Введи хотя бы два символа'));
}
function highlighted(line, query) {
  const span = element('span', 'search-line'), lower = line.toLowerCase(), needle = query.toLowerCase();
  let position = 0, index;
  while ((index = lower.indexOf(needle, position)) >= 0) {
    span.append(line.slice(position, index), element('mark', '', line.slice(index, index + needle.length))); position = index + needle.length;
  }
  span.append(line.slice(position)); return span;
}
async function runSearchAll() {
  const query = $('search-all-input').value.trim(), token = ++searchToken, list = $('search-all-list');
  if (query.length < 2) return list.replaceChildren(element('div', 'list-empty', 'Введи хотя бы два символа'));
  let results;
  try { results = await run('search-all', { query }); } catch { return; }
  if (token !== searchToken) return;
  list.replaceChildren();
  for (const result of results) {
    const button = element('button', 'import-row search-result'); button.append(element('span', `kind-icon ${result.kind}`, icons[result.kind]));
    const copy = element('span', 'import-copy'); copy.append(element('strong', '', result.title + (result.archived ? ' · архив' : '')));
    for (const line of result.lines) copy.append(highlighted(line, query));
    button.append(copy);
    button.onclick = async () => {
      $('search-all-dialog').close(); await action('select', result.id);
      $('find-bar').hidden = false; $('find-input').value = query; searchAddon?.findPrevious(query); $('find-input').focus();
    };
    list.append(button);
  }
  if (!results.length) list.append(element('div', 'list-empty', 'Ничего не нашлось'));
}
$('search-all-input').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearchAll, 250); };
$('search-all-button').onclick = openSearchAll;

// ---- Settings shared with the session manager
$('scrollback-select').onchange = async () => {
  try {
    const value = await run('settings', { set: { scrollback: Number($('scrollback-select').value) } });
    scrollback = value.scrollback; $('scrollback-select').value = String(scrollback);
    if (terminal) terminal.options.scrollback = scrollback;
    if (side) side.terminal.options.scrollback = scrollback;
  } catch { $('scrollback-select').value = String(scrollback); }
};
$('group-toggle').onclick = () => { grouped = !grouped; localStorage.setItem('groupByProject', grouped ? '1' : '0'); renderList(); };
$('resume-all').onclick = () => resumeAll().catch(() => {});
$('clean-archive').onclick = () => deleteSessions(sessions.filter(s => s.archived && !live(s))).catch(() => {});

api.onEvent(message => {
  switch (message.event) {
    case 'activity': activities = message.statuses; if (!draggedId) renderList(); renderHeader(); break;
    case 'sessions': sessions = message.sessions; if (!draggedId) renderList(); renderHeader(); renderSide(); break;
    case 'git': gitInfo = message.git; if (!draggedId) renderList(); renderHeader(); break;
    case 'output': if (message.id === selected) { if (switching) pendingOutput.push(message.data); else terminal?.write(message.data); } break;
    case 'side-output': if (side && message.id === side.id) { if (side.ready) side.terminal.write(message.data); else side.pending.push(message.data); } break;
    case 'side-reset': if (side && message.id === side.id && side.ready) side.terminal.reset(); break;
    case 'side-lost': if (side) { const id = side.id; closeSide(false); setTimeout(() => openSide(id).catch(() => {}), 1000); } break;
    case 'reset': if (message.id === selected && !switching) { terminal?.reset(); } break;
    case 'warning': toast(message.message, true); break;
    case 'connection':
      $('connection-dot').classList.toggle('online', message.connected); $('connection-label').textContent = message.connected ? 'Менеджер сессий подключён' : 'Переподключение…';
      if (!message.connected) acceptingInput = false;
      else run('list').then(data => { sessions = data.sessions; renderList(); if (selected) selectSession(selected).catch(() => {}); });
      break;
    case 'action': action(message.name, message.id || selected).catch(error => toast(error.message, true)); break;
  }
});
for (const id of ['new-session', 'welcome-new']) $(id).onclick = () => openNew();
for (const id of ['import-sessions', 'welcome-import']) $(id).onclick = () => openImport();
$('theme-button').onclick = openThemes; applyTheme(activeTheme);
$('session-search').oninput = renderList; $('import-search').oninput = renderImports;
$('new-form').onsubmit = event => createSession(event).catch(() => {});
document.querySelectorAll('[data-kind]').forEach(button => { button.onclick = () => { selectedKind = button.dataset.kind; updateKind(); }; });
$('choose-folder').onclick = async () => { const folder = await api.chooseFolder(); if (folder) $('new-cwd').value = folder; };
$('archive-toggle').onclick = () => { archived = !archived; renderList(); };
$('pin-button').onclick = () => action('pin').catch(() => {});
$('pause-button').onclick = () => pauseOrResume().catch(() => {});
$('banner-action').onclick = async () => { $('banner-action').disabled = true; try { await startCurrent(); } catch {} finally { $('banner-action').disabled = false; } };
$('more-button').onclick = () => { if (current()) api.context(current()); };
$('help-button').onclick = () => $('help-dialog').showModal(); $('open-data').onclick = () => api.dataFolder();
$('rename-form').onsubmit = async event => { event.preventDefault(); try { await run('update', { id: renamingId, patch: { title: $('rename-input').value } }); $('rename-dialog').close(); } catch {} };
document.querySelectorAll('.close-dialog').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
document.querySelectorAll('dialog').forEach(dialog => { dialog.addEventListener('close', () => terminal?.focus()); });
$('find-input').oninput = () => searchAddon?.findNext($('find-input').value, { incremental: true });
$('find-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); searchAddon?.[event.shiftKey ? 'findPrevious' : 'findNext']($('find-input').value); } if (event.key === 'Escape') $('find-close').click(); };
$('find-prev').onclick = () => searchAddon?.findPrevious($('find-input').value); $('find-next').onclick = () => searchAddon?.findNext($('find-input').value);
$('find-close').onclick = () => { $('find-bar').hidden = true; searchAddon?.clearDecorations(); terminal?.focus(); };
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { fitTerminal(); fitSide(); }, 80); }).observe($('terminal-shell'));
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  if (event.metaKey && /^[1-9]$/.test(event.key)) { const s = visibleSessions()[Number(event.key) - 1]; if (s) { event.preventDefault(); selectSession(s.id).catch(() => {}); } }
  if (event.metaKey && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { const list = visibleSessions(); const index = list.findIndex(s => s.id === selected); const next = list[(index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]; if (next) { event.preventDefault(); selectSession(next.id).catch(() => {}); } }
});
(async () => {
  try {
    info = await api.info(); $('app-version').textContent = info.version; const data = await run('list'); sessions = data.sessions; activities = await run('activity'); renderList();
    $('connection-dot').classList.add('online'); $('connection-label').textContent = 'Менеджер сессий подключён';
    if (data.warning) toast(data.warning, true);
    const last = localStorage.getItem('selectedSession'); const session = sessions.find(s => s.id === last && !s.archived) || sessions.find(s => !s.archived);
    try { scrollback = (await api.request('settings')).scrollback || 4000; }
    catch { setTimeout(() => toast('Менеджер сессий запущен из прошлой версии. Команды при запуске и размер истории заработают после Harbor → «Перезапустить менеджер сессий…» (работающие процессы завершатся).', true), 1500); }
    $('scrollback-select').value = String(scrollback);
    if (session) await selectSession(session.id);
    const sideId = localStorage.getItem('sideSession');
    if (sideId && sideId !== selected && sessions.some(s => s.id === sideId && !s.archived)) openSide(sideId).catch(() => {});
  } catch (error) { $('connection-label').textContent = 'Не удалось подключиться'; toast(error.message, true); }
})();
