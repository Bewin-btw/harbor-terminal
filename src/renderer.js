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
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message.replace(/^Error invoking remote method '[^']+': Error: /, ''); $('toast').className = error ? 'error' : ''; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 11000 : 5000); }
async function run(method, params = {}) { try { return await api.request(method, params); } catch (error) { toast(error.message, true); throw error; } }
function element(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
function visibleSessions() {
  const query = $('session-search').value.trim().toLowerCase();
  return orderedSessions().filter(s => Boolean(s.archived) === archived && `${s.title} ${s.cwd} ${names[s.kind]}`.toLowerCase().includes(query));
}
function renderList() {
  const list = $('session-list'); const focusedId = list.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null; list.replaceChildren(); const visible = visibleSessions();
  $('session-count').textContent = String(visible.length);
  $('archive-count').textContent = sessions.filter(s => s.archived).length || '';
  $('list-label').textContent = archived ? 'АРХИВ' : 'СЕССИИ';
  $('archive-toggle').classList.toggle('selected', archived);
  let lastPinned = null;
  for (const s of visible) {
    if (!archived && s.pinned !== lastPinned && (s.pinned || lastPinned === true)) list.append(element('div', 'section-label', s.pinned ? 'ЗАКРЕПЛЁННЫЕ' : 'ОСТАЛЬНЫЕ'));
    lastPinned = s.pinned;
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
    const meta = element('span', 'session-meta'); meta.append(element('span', `status-dot ${status.key}`), element('span', 'status-label', status.label), element('span', '', '·'), element('span', 'folder', s.cwd.split('/').filter(Boolean).pop() || '/'));
    copy.append(meta); row.append(copy); if (s.pinned) row.append(element('span', 'pinned-marker', '⌑'));
    row.onclick = () => selectSession(s.id).catch(() => {}); row.oncontextmenu = e => { e.preventDefault(); api.context(s); }; list.append(row);
  }
  if (focusedId) list.querySelector(`[data-id="${focusedId}"]`)?.focus();
  if (!visible.length) list.append(element('div', 'list-empty', $('session-search').value ? 'Сессии не найдены' : archived ? 'В архиве пока пусто' : 'Здесь появятся твои сессии.\nСоздай первую или добавь сохранённый диалог.'));
}
function renderHeader() {
  const s = current(); $('session-controls').hidden = !s;
  $('current-title').textContent = s?.title || 'Рабочее пространство'; $('current-path').textContent = s ? shortPath(s.cwd) : 'Все терминалы в одном месте';
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
  terminal = new Terminal({ cols, rows, fontFamily: '"SF Mono", Menlo, Monaco, monospace', fontSize, lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar', scrollback: 4000, smoothScrollDuration: 100, macOptionIsMeta: true, allowProposedApi: true, theme: terminalTheme(activeTheme) });
  fit = new FitAddon(); searchAddon = new SearchAddon(); terminal.loadAddon(fit); terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon((event, uri) => { if (event.metaKey || event.ctrlKey) api.openExternal(uri); }));
  terminal.open($('terminal'));
  let refreshScrollbar = () => {};
  if (['claude', 'codex'].includes(current()?.kind)) nativeTerminal = connectNativeTerminal(terminal, { api, session: current(), active: () => acceptingInput && !switching, changed: () => refreshScrollbar() });
  disposeScrollbar = connectScrollbar(terminal, $('terminal-scrollbar'), $('terminal-scroll-thumb'), nativeTerminal);
  refreshScrollbar = disposeScrollbar.update;
  terminal.onData(data => { if (acceptingInput && current()?.state === 'running') api.request('input', { id: selected, data }).catch(error => toast(error.message, true)); });
  terminal.onTitleChange(title => { $('current-title').title = title; });
  terminal.attachCustomKeyEventHandler(event => {
    if (event.metaKey && ['c', 'v', 'k', 'n', 'o', 'f'].includes(event.key.toLowerCase())) return false;
    return true;
  });
}
async function selectSession(id) {
  const token = ++epoch;
  const cols = terminal?.cols || 100, rows = terminal?.rows || 30;
  selected = id; acceptingInput = false; pendingOutput = []; switching = true;
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
  selectedKind = kind; $('new-title').value = ''; $('new-cwd').value = current()?.cwd || info.home; $('new-host').value = ''; $('new-port').value = '';
  updateKind(); $('new-dialog').showModal(); $('new-title').focus();
}
function updateKind() {
  document.querySelectorAll('[data-kind]').forEach(button => button.classList.toggle('selected', button.dataset.kind === selectedKind));
  $('ssh-fields').hidden = selectedKind !== 'ssh'; $('new-host').required = selectedKind === 'ssh';
  $('new-kind-note').textContent = { shell: 'Твоя обычная оболочка, команды и настройки.', claude: 'Новый диалог Claude Code. Сохраняем его ID для продолжения после перезапуска.', codex: 'Создадим новый диалог Codex и сохраним его ID для продолжения после перезапуска.', ssh: 'Для сохранения удалённой задачи после разрыва связи запускай её внутри tmux на сервере.' }[selectedKind];
  $('create-button').textContent = selectedKind === 'ssh' ? 'Подключиться ↗' : `Открыть ${names[selectedKind]} ↗`;
}
async function createSession(event) {
  event.preventDefault(); const button = $('create-button'); button.disabled = true;
  try {
    const raw = $('new-cwd').value.trim(); const cwd = raw === '~' ? info.home : raw.startsWith('~/') ? info.home + raw.slice(1) : raw;
    const s = await run('create', { kind: selectedKind, title: $('new-title').value.trim(), cwd, host: $('new-host').value.trim(), port: $('new-port').value ? Number($('new-port').value) : undefined });
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
      fontSize = name === 'font-reset' ? 13 : Math.min(24, Math.max(10, fontSize + (name === 'font-up' ? 1 : -1))); localStorage.setItem('fontSize', fontSize); if (terminal) { terminal.options.fontSize = fontSize; fitTerminal(); } return;
    case 'rename': if (s) { renamingId = s.id; $('rename-input').value = s.title; $('rename-dialog').showModal(); $('rename-input').select(); } return;
    case 'pin': if (s) await run('update', { id, patch: { pinned: !s.pinned } }); return;
    case 'archive': if (s) { await run('update', { id, patch: { archived: !s.archived } }); renderList(); renderHeader(); } return;
    case 'bind': return openImport(id);
    case 'stop': return stopCurrent(id);
  }
}
api.onEvent(message => {
  switch (message.event) {
    case 'activity': activities = message.statuses; if (!draggedId) renderList(); renderHeader(); break;
    case 'sessions': sessions = message.sessions; if (!draggedId) renderList(); renderHeader(); break;
    case 'output': if (message.id === selected) { if (switching) pendingOutput.push(message.data); else terminal?.write(message.data); } break;
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
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitTerminal, 80); }).observe($('terminal-shell'));
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
    if (session) await selectSession(session.id);
  } catch (error) { $('connection-label').textContent = 'Не удалось подключиться'; toast(error.message, true); }
})();
