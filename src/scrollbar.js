// A separate layout column: dragging never covers a terminal cell or sends
// mouse-reporting escape sequences to the foreground program.
export function connectScrollbar(terminal, track, thumb, native) {
  let drag = null, frame = null, wheelPixels = 0;
  function metrics() {
    const buffer = terminal.buffer.active;
    const external = native?.enabled() ? native.metrics() : null;
    const max = external ? external.max : buffer.type === 'alternate' ? 0 : buffer.baseY;
    const height = track.clientHeight;
    const size = Math.min(height, Math.max(32, height * terminal.rows / (max + terminal.rows)));
    return { max, height, size, travel: height - size, value: external ? external.value : Math.min(max, buffer.viewportY) };
  }
  function update() {
    const m = metrics(); thumb.style.height = `${m.size}px`; thumb.style.transform = `translateY(${m.max ? m.travel * m.value / m.max : 0}px)`;
    track.setAttribute('aria-valuemax', m.max); track.setAttribute('aria-valuenow', m.value);
    track.setAttribute('aria-valuetext', m.max ? `${Math.round(m.value / m.max * 100)}% истории` : 'Вся доступная история на экране');
    track.title = native?.enabled() ? 'Прокрутка истории CLI · положение ползунка приблизительное · Home / End — начало / конец' : 'Перетащи для прокрутки · Home / End — начало / конец';
    track.setAttribute('aria-disabled', String(!m.max)); track.classList.toggle('inactive', !m.max);
  }
  function schedule() { if (frame === null) frame = requestAnimationFrame(() => { frame = null; update(); }); }
  function seek(y, offset) { const m = metrics(); if (m.travel > 0) { const value = Math.round(Math.max(0, Math.min(1, (y - track.getBoundingClientRect().top - track.clientTop - offset) / m.travel)) * m.max); if (native?.enabled()) native.seek(value); else terminal.scrollToLine(value); } }
  function down(e) {
    if (e.button !== 0 || !metrics().max) return;
    e.preventDefault(); track.focus();
    const m = metrics(); drag = { id: e.pointerId, offset: e.target === thumb ? e.clientY - thumb.getBoundingClientRect().top : m.size / 2 };
    track.setPointerCapture(e.pointerId); track.classList.add('dragging'); seek(e.clientY, drag.offset);
  }
  function move(e) { if (drag?.id === e.pointerId) { e.preventDefault(); seek(e.clientY, drag.offset); } }
  function end(e) { if (drag?.id !== e.pointerId) return; drag = null; track.classList.remove('dragging'); if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId); }
  function key(e) {
    const keys = { ArrowUp: -1, ArrowDown: 1, PageUp: -terminal.rows, PageDown: terminal.rows };
    if (Object.hasOwn(keys, e.key)) { e.preventDefault(); if (native?.enabled()) native.scroll(keys[e.key]); else terminal.scrollLines(keys[e.key]); }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); if (native?.enabled()) native.boundary(e.key === 'End'); else terminal.scrollToLine(e.key === 'Home' ? 0 : metrics().max); }
  }
  function wheel(e) {
    if (native?.enabled()) { native.wheel(e); return; }
    e.preventDefault();
    const rowHeight = track.clientHeight / terminal.rows || 18;
    const pixels = e.deltaY * (e.deltaMode === 1 ? rowHeight : e.deltaMode === 2 ? track.clientHeight : 1);
    if (pixels && Math.sign(pixels) !== Math.sign(wheelPixels)) wheelPixels = 0;
    wheelPixels += pixels;
    const lines = Math.trunc(wheelPixels / rowHeight);
    if (lines) { wheelPixels -= lines * rowHeight; terminal.scrollLines(lines); }
  }
  const listeners = [['pointerdown', down], ['pointermove', move], ['pointerup', end], ['pointercancel', end], ['lostpointercapture', end], ['keydown', key], ['wheel', wheel]];
  for (const [name, fn] of listeners) track.addEventListener(name, fn, { passive: false });
  const subscriptions = [terminal.onScroll(schedule), terminal.onRender(schedule), terminal.onWriteParsed(schedule), terminal.onResize(schedule), terminal.buffer.onBufferChange(schedule)];
  const observer = new ResizeObserver(schedule); observer.observe(track); update();
  const dispose = () => { if (frame !== null) cancelAnimationFrame(frame); observer.disconnect(); subscriptions.forEach(s => s.dispose()); listeners.forEach(([name, fn]) => track.removeEventListener(name, fn)); track.classList.remove('dragging'); };
  dispose.update = schedule; return dispose;
}
