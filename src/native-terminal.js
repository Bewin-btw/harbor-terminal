const clean = text => text.replace(/\s+/g, ' ').trim();

// Match actual saved human messages rather than recoloring every CLI prompt or
// menu entry that happens to start with a chevron.
export function humanRows(lines, messages, cursorRow = -1) {
  const result = new Set();
  const humans = messages.filter(m => m.role === 'user').map(m => clean(m.text));
  for (let row = 0; row < lines.length; row++) {
    const match = lines[row].match(/^\s*[❯›]\s*(.*)$/u); if (!match) continue;
    const text = clean(match[1]);
    if (row === cursorRow && row >= lines.length - 8) result.add(row);
    if (!text) continue;
    const message = humans.find(m => m === text || m.startsWith(text + ' ') || m.startsWith(text));
    if (!message) continue;
    result.add(row); let rest = message.slice(text.length).trimStart();
    for (let next = row + 1; rest && next < lines.length; next++) {
      const part = clean(lines[next]);
      if (!part) continue;
      if (!rest.startsWith(part)) break;
      result.add(next); rest = rest.slice(part.length).trimStart();
    }
  }
  return result;
}

export function connectNativeTerminal(terminal, { api, session, active, changed }) {
  // Supported Claude/Codex use SGR mouse encoding. SerializeAddon preserves
  // tracking1003 but omits encoding1006 on attach, so absence is not disable.
  // Honor an explicit ?1006l received from the live process.
  let messages = [], revision, after, before, busy = false, disposed = false, sgr = null;
  let estimatedTop = 0, requestedTop = null, queue = 0, timer, renderFrame, wheelPixels = 0;
  let layout = [], total = terminal.rows * 8, atEnd = true, lastCommand = 0;
  const send = data => { if (active() && session.state === 'running') api.request('input', { id: session.id, data }).catch(() => {}); };
  const supported = () => terminal.buffer.active.type === 'alternate' && ['claude', 'codex'].includes(session.kind) && session.state === 'running';
  function rebuild() {
    let top = 0;
    layout = messages.map(m => {
      const rows = m.text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / Math.max(20, terminal.cols - 4))), 0) + 3;
      const entry = { ...m, text: clean(m.text), top, rows }; top += rows; return entry;
    });
    total = Math.max(terminal.rows * 2, top);
    if (atEnd) estimatedTop = Math.max(0, total - terminal.rows);
  }
  function visibleLines() {
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) || '');
  }
  function decorate() {
    if (disposed) return;
    const lines = visibleLines();
    const buffer = terminal.buffer.active;
    const marked = humanRows(lines, messages, buffer.viewportY === buffer.baseY ? buffer.cursorY : -1);
    const rows = terminal.element?.querySelector('.xterm-rows')?.children;
    if (rows) for (let y = 0; y < rows.length; y++) rows[y].classList.toggle('harbor-human-line', marked.has(y));
    // The CLI does not publish its scroll extent. Re-anchor the approximate
    // thumb to visible saved text; only Home/End represent exact boundaries.
    if (supported() && !queue && Date.now() - lastCommand > 150 && !atEnd) {
      for (let y = 0; y < Math.max(1, lines.length - 6); y++) {
        const text = clean(lines[y].replace(/^\s*[❯›>●•]\s*/u, ''));
        if (text.length < 18) continue;
        const entry = layout.find(m => m.text.includes(text));
        if (!entry) continue;
        estimatedTop = Math.max(0, Math.min(max(), entry.top + Math.floor(entry.text.indexOf(text) / Math.max(20, terminal.cols - 4)) - y)); break;
      }
    }
    changed();
  }
  function schedule() { if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = null; decorate(); }); }
  const max = () => Math.max(1, total - terminal.rows);
  function pump() {
    timer = null; if (disposed || !active() || !supported()) { queue = 0; return; }
    const amount = Math.sign(queue) * Math.min(Math.abs(queue), 12); if (!amount) return;
    queue -= amount; lastCommand = Date.now();
    if (sgr !== false && terminal.modes.mouseTrackingMode !== 'none') {
      // A modest batch per frame avoids xterm's one-event-per-wheel loss and
      // avoids flooding a fullscreen CLI with hundreds of input messages.
      send(`\x1b[<${amount < 0 ? 64 : 65};3;3M`.repeat(Math.abs(amount)));
    } else send(amount < 0 ? '\x1b[5~' : '\x1b[6~');
    if (queue) timer = setTimeout(pump, 20); else requestedTop = null;
  }
  function scroll(lines) {
    if (!supported() || !lines) return;
    atEnd = false;
    estimatedTop = Math.max(0, Math.min(max(), estimatedTop + lines));
    queue = Math.max(-800, Math.min(800, queue + Math.trunc(lines)));
    if (!timer) timer = setTimeout(pump, 0); changed();
  }
  function boundary(bottom) {
    clearTimeout(timer); timer = null; queue = 0; requestedTop = null;
    atEnd = bottom; estimatedTop = bottom ? max() : 0; lastCommand = Date.now();
    send(bottom ? '\x1b[1;5F' : '\x1b[1;5H');
    changed();
  }
  function seek(value) {
    const target = Math.max(0, Math.min(max(), value));
    if (target <= 0) return boundary(false);
    if (target >= max()) return boundary(true);
    const delta = target - (requestedTop ?? estimatedTop); requestedTop = target; scroll(Math.round(delta));
  }
  function wheel(event) {
    if (!supported()) return true;
    const height = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect().height / terminal.rows || 16;
    const pixels = event.deltaY * (event.deltaMode === 1 ? height : event.deltaMode === 2 ? height * terminal.rows : 1);
    if (pixels && Math.sign(pixels) !== Math.sign(wheelPixels)) wheelPixels = 0;
    wheelPixels += pixels;
    const lines = Math.trunc(wheelPixels / height);
    if (lines) { wheelPixels -= lines * height; scroll(lines); }
    event.preventDefault(); return false;
  }
  terminal.attachCustomWheelEventHandler(wheel);
  const subscriptions = [
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => { if (params.includes(1006)) sgr = true; return false; }),
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => { if (params.includes(1006)) sgr = false; return false; }),
    terminal.onRender(schedule), terminal.onWriteParsed(schedule), terminal.onScroll(schedule),
    terminal.onResize(() => { rebuild(); schedule(); }),
  ];
  async function poll(older = false) {
    if (busy || disposed) return; busy = true;
    try {
      const page = await api.request('conversation', { id: session.id, ...(older ? { before } : { after, revision }) });
      if (disposed || page.unchanged) return;
      const existing = new Set(messages.map(m => m.id)); const incoming = page.messages.filter(m => !existing.has(m.id));
      if (page.reset) messages = page.messages;
      else if (older) messages.unshift(...incoming); else messages.push(...incoming);
      if (after === undefined || older) before = page.before;
      if (!older) { after = page.after; revision = page.revision; }
      rebuild(); schedule();
      // Index older pages without touching the terminal or sending input.
      if (before && messages.length < 2000) setTimeout(() => poll(true), 50);
      else if (page.more) setTimeout(() => poll(), 20);
    } catch {} finally { busy = false; }
  }
  const pollTimer = setInterval(() => poll(), 1500); poll(); rebuild();
  return {
    enabled: supported,
    metrics: () => ({ max: max(), value: Math.min(max(), estimatedTop), rows: terminal.rows }),
    scroll, seek, boundary, wheel,
    updateSession(value) { session = value; if (!supported()) { queue = 0; clearTimeout(timer); timer = null; } },
    dispose() { disposed = true; clearInterval(pollTimer); clearTimeout(timer); if (renderFrame) cancelAnimationFrame(renderFrame); subscriptions.forEach(s => s.dispose()); terminal.attachCustomWheelEventHandler(() => true); },
  };
}
