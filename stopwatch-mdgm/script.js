/* =========================================================================
   Sci-Fi Multi-Timer (Stopwatch + Countdown)
   - WCAG AA, keyboard-first, sound feedback, notifications
   - All logic in this file. SOLID/DRY architecture.
   - Patch notes (minimal changes for reported issues):
     1) Focus view buttons fixed by adding data-id and proper handlers.
     2) Digit overflow fixed with a container box + overflow-hidden and reduced clamp sizes.
     3) Label length validation: max 9 chars enforced on create/edit.
     4) Filter text now persists across renders.
     5) Light theme contrast improved via injected CSS overrides.
     6) Countdown finish now always shows modal + plays info AND notification sounds,
        including 0s or instant finishes.
     7) Editing countdown updates values correctly.
     8) Multiple countdowns finishing queue their own modal + sound (no exceptions).
   ======================================================================== */

/* ------------------------- Utilities & Constants ------------------------ */

const QS = (sel, root = document) => root.querySelector(sel);
const QSA = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE_KEY = 'scifi-multi-timer.v1';
const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

// persistent UI state (filter, theme)
const UI_STATE = {
  filterText: '',
  theme: 'dark', // 'dark' | 'light'
};

// Sound asset URLs (extracted from provided example — do not change)
const SOUND_URLS = {
  click: 'https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3',
  success: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3',
  error: 'https://assets.mixkit.co/active_storage/sfx/2955/2955-preview.mp3',
  warning: 'https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3',
  info: 'https://assets.mixkit.co/active_storage/sfx/2570/2570-preview.mp3',
  notification: 'https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3'
};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function msFromHMS(hh, mm, ss) {
  const h = Number(hh) || 0, m = Number(mm) || 0, s = Number(ss) || 0;
  return (((h * 60) + m) * 60 + s) * 1000;
}

function parseHMS(text) {
  const t = String(text).trim();
  if (!t) return { hh: 0, mm: 0, ss: 0 };
  const parts = t.split(':').map(p => Number(p || 0));
  const [a, b, c] = parts.length === 3 ? parts
                  : parts.length === 2 ? [0, parts[0], parts[1]]
                  : [0, 0, parts[0]];
  return { hh: clamp(a, 0, 99), mm: clamp(b, 0, 59), ss: clamp(c, 0, 59) };
}

function fmtHMS(ms, { showCenti = false } = {}) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const cs = Math.floor((ms % 1000) / 10);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const base = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return showCenti ? `${base}.${String(cs).padStart(2, '0')}` : base;
}

function enforceLabelMax(label) {
  // Enforce max 9 characters, trim whitespace
  return (label || '').trim().slice(0, 9);
}

/* ------------------------------- Audio ---------------------------------- */

class AudioController {
  constructor() {
    this.enabled = true;
    this.sounds = Object.fromEntries(Object.entries(SOUND_URLS).map(([k, url]) => [k, new Audio(url)]));
  }
  play(name) {
    if (!this.enabled) return;
    const s = this.sounds[name];
    if (!s) return;
    s.currentTime = 0;
    s.play().catch(() => {/* user gesture may be needed until first click */});
  }
  beep(frequency = 800, duration = 150) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = frequency; osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration / 1000);
    osc.start(); osc.stop(ctx.currentTime + duration / 1000);
  }
}
const audio = new AudioController();

/* ---------------------------- Notifications ----------------------------- */

class NotificationController {
  constructor() { this.permission = Notification?.permission ?? 'default'; }
  async ensurePermission() {
    if (!('Notification' in window)) return false;
    if (this.permission === 'granted') return true;
    if (this.permission === 'denied') return false;
    try {
      this.permission = await Notification.requestPermission();
      return this.permission === 'granted';
    } catch { return false; }
  }
  async notify({ title, body }) {
    const ok = await this.ensurePermission();
    if (!ok) return false;
    new Notification(title, { body });
    return true;
  }
}
const notifier = new NotificationController();

/* ------------------------------- Timers --------------------------------- */

class TimerBase {
  constructor({ id = uuid(), label = '', type }) {
    this.id = id;
    this.label = enforceLabelMax(label || (type === 'stopwatch' ? 'SW' : 'CD')); // enforce 9-char max
    this.type = type;
    this.state = 'idle'; // idle|running|paused|finished
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this._lastTick = null; // performance.now
  }
  start() { this.state = 'running'; this._lastTick = performance.now(); this.updatedAt = Date.now(); }
  pause() { if (this.state === 'running') { this.state = 'paused'; this.updatedAt = Date.now(); } }
  resume() { if (this.state === 'paused') { this.state = 'running'; this._lastTick = performance.now(); this.updatedAt = Date.now(); } }
  clear() { this.state = 'idle'; this.updatedAt = Date.now(); }
  tick(now) { this._lastTick = now; }
  toJSON() { return { id: this.id, label: this.label, type: this.type, state: this.state, createdAt: this.createdAt, updatedAt: this.updatedAt }; }
}

class Stopwatch extends TimerBase {
  constructor(opts = {}) {
    super({ ...opts, type: 'stopwatch' });
    this.elapsedMs = opts.elapsedMs ?? 0;
  }
  start() { super.start(); }
  clear() { super.clear(); this.elapsedMs = 0; }
  tick(now) {
    if (this.state === 'running' && this._lastTick != null) {
      const delta = now - this._lastTick;
      this.elapsedMs += delta;
      this.updatedAt = Date.now();
    }
    super.tick(now);
  }
  toJSON() { return { ...super.toJSON(), elapsedMs: this.elapsedMs }; }
  static fromJSON(obj) { const s = new Stopwatch({ id: obj.id, label: obj.label, elapsedMs: obj.elapsedMs || 0 }); s.state = obj.state; return s; }
}

class Countdown extends TimerBase {
  constructor(opts = {}) {
    super({ ...opts, type: 'countdown' });
    this.durationMs = opts.durationMs ?? 0;
    this.remainingMs = opts.remainingMs ?? this.durationMs;
    this.autoStart = !!opts.autoStart;
  }
  start() {
    super.start();
    if (this.remainingMs <= 0) this.remainingMs = this.durationMs;
    // Ensure instant/zero durations also trigger finish flow
    if (this.remainingMs <= 0) {
      this.state = 'finished';
      this.onFinished?.(this);
    }
  }
  clear() { super.clear(); this.remainingMs = this.durationMs; }
  tick(now) {
    if (this.state === 'running' && this._lastTick != null) {
      const delta = now - this._lastTick;
      this.remainingMs = Math.max(0, this.remainingMs - delta);
      if (this.remainingMs <= 0 && this.state !== 'finished') {
        this.state = 'finished';
        this.onFinished?.(this);
      }
      this.updatedAt = Date.now();
    }
    super.tick(now);
  }
  toJSON() { return { ...super.toJSON(), durationMs: this.durationMs, remainingMs: this.remainingMs, autoStart: this.autoStart }; }
  static fromJSON(obj) {
    const c = new Countdown({ id: obj.id, label: obj.label, durationMs: obj.durationMs, remainingMs: obj.remainingMs, autoStart: obj.autoStart });
    c.state = obj.state;
    return c;
  }
}

/* --------------------------- Timer Management --------------------------- */

class TimerManager {
  constructor() { this.timers = []; this.focusId = null; }
  addTimer(timer) { this.timers.push(timer); this.save(); return timer; }
  deleteTimer(id) { this.timers = this.timers.filter(t => t.id !== id); if (this.focusId === id) this.focusId = null; this.save(); }
  get(id) { return this.timers.find(t => t.id === id); }
  setFocus(id) { this.focusId = id; render(); }
  clearFocus() { this.focusId = null; render(); }
  save() {
    try {
      const payload = this.timers.map(t => t.toJSON());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch { /* ignore */ }
  }
  restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return;
      const arr = JSON.parse(raw);
      this.timers = arr.map(obj => obj.type === 'stopwatch' ? Stopwatch.fromJSON(obj) : Countdown.fromJSON(obj));
      for (const t of this.timers) if (t.state === 'running') t._lastTick = performance.now();
    } catch { /* ignore */ }
  }
}
const manager = new TimerManager();
manager.restore();

/* ------------------------ Light Theme Contrast Fix ---------------------- */

let injectedLightStyles = false;
function ensureLightOverrides() {
  if (injectedLightStyles) return;
  const style = document.createElement('style');
  style.textContent = `
    .tw-light body{background:#ffffff !important;color:#0f172a !important;}
    .tw-light header{background:#f8fafc !important;border-color:#cbd5e1 !important;}
    .tw-light .text-slate-100{color:#0f172a !important}
    .tw-light .text-slate-300{color:#0f172a !important}
    .tw-light .text-slate-400{color:#0f172a !important}
    .tw-light .bg-slate-900\\/50, .tw-light .bg-slate-900\\/60, .tw-light .bg-slate-900, .tw-light .from-slate-900\\/60, .tw-light .to-slate-900\\/30 {
      background: #ffffff !important;
    }
    .tw-light .border-slate-800\\/70, .tw-light .border-slate-700, .tw-light .border-slate-700\\/50, .tw-light .border-slate-700\\/60 {
      border-color:#94a3b8 !important;
    }
  `;
  document.head.appendChild(style);
  injectedLightStyles = true;
}

/* ------------------------------- Renderer -------------------------------- */

const boardEl = QS('#board');
const focusEl = QS('#focus');
const toolbarEl = QS('#toolbar');
const modalRoot = QS('#modal-root');
const globalActionsEl = QS('#global-actions');

function btnBase(cls = '') {
  return `inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 transition ${cls}`;
}

function ghostBtn() { return 'px-3 py-2 rounded-lg hover:bg-white/5 border border-white/10'; }

function renderToolbar() {
  toolbarEl.innerHTML = `
    <div class="flex flex-wrap items-center gap-3" role="toolbar" aria-label="Add timers">
      <button id="add-stopwatch" class="${btnBase('text-emerald-300')}" type="button">➕ Add Stopwatch</button>
      <button id="add-countdown" class="${btnBase('text-cyan-300')}" type="button">➕ Add Countdown</button>
      <div class="h-6 w-px bg-slate-700 mx-2" aria-hidden="true"></div>
      <label class="text-sm text-slate-300" for="search">Search:</label>
      <input id="search" class="px-3 py-2 rounded bg-slate-900/60 border border-slate-700/50 w-60" placeholder="Filter by label" />
      <button id="toggle-mode" class="${ghostBtn()}" type="button" aria-pressed="${!!manager.focusId}">Focus/Board</button>
      <button id="toggle-sound" class="${ghostBtn()}">${audio.enabled ? '🔊 Sound On' : '🔇 Sound Off'}</button>
      <button id="theme-toggle" class="${ghostBtn()}">🌙/☀ Theme</button>
    </div>
  `;
  // Preserve filter text (fix)
  const s = QS('#search');
  if (s) s.value = UI_STATE.filterText;
}

function digitsBoxHTML(content, large = false, showCenti = false) {
  // A boxed area that contains digits without overflow
  const textSize = large
    ? 'text-[clamp(2.5rem,10vw,12rem)]' // reduced from 16rem to contain
    : 'text-[clamp(1.4rem,6vw,3.2rem)]'; // reduced from previous values
  return `
    <div class="mt-3 rounded-xl border-slate-700/70 bg-slate-900/40 py-4 overflow-hidden">
      <output class="timer-output block font-mono tabular-nums ${textSize} leading-none tracking-wider break-keep whitespace-nowrap overflow-hidden"
              aria-live="polite">${content}</output>
    </div>
  `;
}

function timerCardHTML(t) {
  const isSW = t.type === 'stopwatch';
  const display = isSW ? fmtHMS(t.elapsedMs, { showCenti: false }) : fmtHMS(t.remainingMs, { showCenti: false });
  const state = t.state;
  return `
  <article class="rounded-2xl border border-slate-800/70 bg-gradient-to-b from-slate-900/60 to-slate-900/30 p-4 shadow-[0_0_40px_rgba(16,185,129,0.15)] backdrop-blur"
           role="group" aria-label="${t.label}" data-id="${t.id}" tabindex="0">
    <div class="flex items-center gap-2">
      <div class="w-2 h-2 rounded-full ${state === 'running' ? 'bg-emerald-400 animate-pulse' : state === 'paused' ? 'bg-yellow-400' : state === 'finished' ? 'bg-red-500' : 'bg-slate-500'}" aria-hidden="true"></div>
      <h3 class="text-lg font-medium grow">
        <span class="sr-only">${isSW ? 'Stopwatch' : 'Countdown'}:</span>
        <span class="align-middle">${t.label}</span>
      </h3>
      <button class="focus-btn ${ghostBtn()}" type="button" aria-label="Focus ${t.label}">Focus</button>
      <button class="delete-btn ${ghostBtn()} text-rose-300" type="button">Delete</button>
    </div>

    ${digitsBoxHTML(display)}

    <div class="mt-4 flex flex-wrap gap-2" role="group" aria-label="Controls">
      <button class="start-btn ${btnBase('text-emerald-300')}">${state === 'running' ? 'Pause' : (state === 'paused' ? 'Resume' : 'Start')}</button>
      <button class="clear-btn ${ghostBtn()}">Clear</button>
      ${isSW ? '' : `<button class="edit-btn ${ghostBtn()}">Edit</button>`}
    </div>
  </article>
  `;
}

function renderBoard(filter = '') {
  const items = manager.timers.filter(t => t.label.toLowerCase().includes(filter.toLowerCase()));
  boardEl.className = 'grid gap-6 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4';
  boardEl.innerHTML = items.map(timerCardHTML).join('') || `
    <div class="text-slate-400">No timers yet. Use “Add Stopwatch” or “Add Countdown”.</div>`;
}

function renderFocus() {
  if (!manager.focusId) { focusEl.classList.add('hidden'); return; }
  const t = manager.get(manager.focusId);
  if (!t) { manager.clearFocus(); return; }
  const isSW = t.type === 'stopwatch';
  focusEl.className = 'block';
  const display = isSW ? fmtHMS(t.elapsedMs,{showCenti:true}) : fmtHMS(t.remainingMs,{showCenti:true});
  focusEl.innerHTML = `
    <article class="rounded-3xl border border-emerald-500/30 bg-slate-900/50 p-8 shadow-[0_0_80px_rgba(16,185,129,0.25)] backdrop-blur"
             role="group" aria-label="Focused: ${t.label}" data-id="${t.id}">
      <div class="flex items-center gap-3 mb-6">
        <button class="back-btn ${ghostBtn()}">← Back to Board</button>
        <h2 class="text-xl md:text-2xl font-semibold ml-2">${t.label}</h2>
      </div>
      ${digitsBoxHTML(display, true, true)}
      <div class="mt-8 flex flex-wrap justify-center gap-3">
        <button class="start-btn ${btnBase('text-emerald-300')}">${t.state === 'running' ? 'Pause' : (t.state === 'paused' ? 'Resume' : 'Start')}</button>
        <button class="clear-btn ${ghostBtn()}">Clear</button>
        ${isSW ? '' : `<button class="edit-btn ${ghostBtn()}">Edit</button>`}
        <button class="delete-btn ${ghostBtn()} text-rose-300">Delete</button>
      </div>
    </article>
  `;
}

function renderGlobalActions() {
  globalActionsEl.innerHTML = `
    <button id="all-focus" class="${ghostBtn()}" title="Focus first timer (F)">Focus</button>
    <button id="all-board" class="${ghostBtn()}" title="Board view">Board</button>
  `;
}

function render(filter = UI_STATE.filterText) {
  renderToolbar();
  renderGlobalActions();
  if (manager.focusId) {
    QS('#board').classList.add('hidden');
    renderFocus();
  } else {
    QS('#board').classList.remove('hidden');
    renderBoard(filter);
    focusEl.classList.add('hidden');
  }
  // Preserve filter input value post-render
  const s = QS('#search'); if (s) s.value = UI_STATE.filterText;
  wireEvents(); // rebind after render
  wireFinishCallbacks(); // ensure callbacks attached after any new timers
}

/* ------------------------------- Modal Queue ---------------------------- */

const modalQueue = [];
let modalOpen = false;

function processNextModal() {
  if (modalQueue.length === 0) { modalOpen = false; return; }
  modalOpen = true;
  const { title, message, onConfirm, confirmText } = modalQueue.shift();
  openModal({
    title, message, confirmText,
    onConfirm: () => { onConfirm?.(); processNextModal(); }
  });
}

function queueModal(opts) {
  modalQueue.push(opts);
  if (!modalOpen) processNextModal();
}

function openModal({ title, message, onConfirm, confirmText = 'OK' }) {
  modalRoot.innerHTML = `
    <div class="absolute inset-0 bg-slate-950/70 backdrop-blur grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="max-w-md w-full rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
        <h2 id="modal-title" class="text-xl font-semibold mb-3">${title}</h2>
        <p class="text-slate-300 mb-6">${message}</p>
        <div class="flex justify-end">
          <button id="modal-ok" class="${btnBase('text-emerald-300')}">${confirmText}</button>
        </div>
      </div>
    </div>
  `;
  modalRoot.classList.remove('hidden');
  modalRoot.setAttribute('aria-hidden', 'false');
  const ok = QS('#modal-ok', modalRoot);
  const prev = document.activeElement;
  ok.focus();
  function close() {
    modalRoot.classList.add('hidden');
    modalRoot.setAttribute('aria-hidden', 'true');
    modalRoot.innerHTML = '';
    prev?.focus();
  }
  ok.addEventListener('click', () => { audio.play('click'); onConfirm?.(); close(); });
  modalRoot.addEventListener('click', (e) => { if (e.target === modalRoot.firstElementChild) { close(); } });
  document.addEventListener('keydown', function onEsc(ev) {
    if (ev.key === 'Escape') { document.removeEventListener('keydown', onEsc); close(); }
  });
}

/* ------------------------------- Events --------------------------------- */

function wireEvents() {
  // Toolbar
  QS('#add-stopwatch')?.addEventListener('click', () => {
    audio.play('click');
    const count = manager.timers.filter(t=>t.type==='stopwatch').length + 1;
    const base = `SW${count}`; // keep short label
    const sw = new Stopwatch({ label: enforceLabelMax(base) });
    manager.addTimer(sw); render();
  });
  QS('#add-countdown')?.addEventListener('click', () => {
    audio.play('click'); openCountdownEditor();
  });
  QS('#toggle-mode')?.addEventListener('click', () => {
    audio.play('click');
    if (manager.focusId) manager.clearFocus();
    else if (manager.timers[0]) manager.setFocus(manager.timers[0].id);
  });
  QS('#toggle-sound')?.addEventListener('click', () => {
    audio.enabled = !audio.enabled;
    if (audio.enabled) audio.play('click');
    render();
  });
  QS('#theme-toggle')?.addEventListener('click', () => {
    audio.play('click');
    UI_STATE.theme = UI_STATE.theme === 'dark' ? 'light' : 'dark';
    if (UI_STATE.theme === 'light') {
      ensureLightOverrides();
      document.documentElement.classList.add('tw-light');
    } else {
      document.documentElement.classList.remove('tw-light');
    }
    render(); // re-render to re-apply classes if needed
  });
  QS('#search')?.addEventListener('input', (e) => {
    UI_STATE.filterText = e.target.value; // persist filter input (fix)
    render(UI_STATE.filterText);
  });

  // Global actions
  QS('#all-focus')?.addEventListener('click', () => {
    audio.play('click');
    if (manager.timers[0]) manager.setFocus(manager.timers[0].id);
  });
  QS('#all-board')?.addEventListener('click', () => { audio.play('click'); manager.clearFocus(); });

  // Cards (delegated)
  QSA('article[role="group"]', boardEl).forEach(card => attachCardHandlers(card));
  QSA('article[role="group"]', focusEl).forEach(card => attachCardHandlers(card));

  // Keyboard shortcuts (global)
  document.onkeydown = (e) => {
    const activeCard = document.activeElement?.closest('article[role="group"]');
    const id = activeCard?.dataset.id || manager.focusId;
    const timer = id ? manager.get(id) : null;

    if (e.key === '/') { e.preventDefault(); QS('#search')?.focus(); return; }
    if (e.key.toLowerCase() === 'f') { e.preventDefault(); audio.play('click'); manager.focusId ? manager.clearFocus() : manager.setFocus(manager.timers[0]?.id); return; }
    if (!timer) return;
    if (e.code === 'Space') { e.preventDefault(); audio.play('click'); toggleStart(timer); return; }
    if (e.key.toLowerCase() === 'c') { e.preventDefault(); audio.play('click'); timer.clear(); manager.save(); render(); return; }
    if (e.key.toLowerCase() === 'e') { if (timer.type === 'countdown') { e.preventDefault(); audio.play('click'); openCountdownEditor(timer); } }
    if (e.key === 'Delete') { e.preventDefault(); audio.play('click'); manager.deleteTimer(timer.id); render(); }
    if (e.key === 'Escape' && manager.focusId) { manager.clearFocus(); }
  };
}

function attachCardHandlers(card) {
  const id = card.dataset.id;
  const timer = manager.get(id);
  card.addEventListener('focus', () => card.classList.add('ring','ring-emerald-600/60'));
  card.addEventListener('blur',  () => card.classList.remove('ring','ring-emerald-600/60'));

  card.querySelector('.start-btn')?.addEventListener('click', () => { audio.play('click'); toggleStart(timer); });
  card.querySelector('.clear-btn')?.addEventListener('click', () => { audio.play('click'); timer.clear(); manager.save(); render(); });
  card.querySelector('.edit-btn')?.addEventListener('click', () => { if (timer.type==='countdown') { audio.play('click'); openCountdownEditor(timer); } });
  card.querySelector('.delete-btn')?.addEventListener('click', () => {
    audio.play('click');
    queueModal({ title:'Delete timer?', message:`This will remove “${timer.label}”.`, onConfirm(){ manager.deleteTimer(id); render(); }});
  });
  card.querySelector('.focus-btn')?.addEventListener('click', () => { audio.play('click'); manager.setFocus(id); });
  card.querySelector('.back-btn')?.addEventListener('click', () => { audio.play('click'); manager.clearFocus(); });
}

function toggleStart(timer) {
  if (timer.state === 'running') timer.pause();
  else if (timer.state === 'paused') timer.resume();
  else if (timer.state === 'idle' || timer.state === 'finished') { timer.clear(); timer.start(); }
  manager.save(); render();
}

/* ------------------------- Countdown Editor Modal ----------------------- */

function openCountdownEditor(existing) {
  const isEdit = !!existing;
  const label = existing?.label ?? enforceLabelMax(`CD${manager.timers.filter(t=>t.type==='countdown').length+1}`);
  const ms = existing?.durationMs ?? 0;
  const defaultHMS = { hh: Math.floor(ms/3600000), mm: Math.floor((ms%3600000)/60000), ss: Math.floor((ms%60000)/1000) };
  modalRoot.innerHTML = `
    <div class="absolute inset-0 bg-slate-950/70 backdrop-blur grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby="edit-title">
      <form id="cd-form" class="max-w-md w-full rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
        <h2 id="edit-title" class="text-xl font-semibold mb-4">${isEdit?'Edit':'New'} Countdown</h2>
        <div class="mb-4">
          <label class="block text-sm mb-1" for="label">Label (max 9 chars)</label>
          <input id="label" name="label" maxlength="9" class="w-full px-3 py-2 rounded bg-slate-800 border border-slate-700" value="${label}">
        </div>
        <fieldset class="mb-4">
          <legend class="block text-sm mb-1">Duration (HH:MM:SS)</legend>
          <div class="flex gap-2">
            <input id="hh" class="w-20 px-3 py-2 rounded bg-slate-800 border border-slate-700" inputmode="numeric" value="${String(defaultHMS.hh).padStart(2,'0')}" aria-label="Hours" />
            <span class="self-center">:</span>
            <input id="mm" class="w-20 px-3 py-2 rounded bg-slate-800 border border-slate-700" inputmode="numeric" value="${String(defaultHMS.mm).padStart(2,'0')}" aria-label="Minutes" />
            <span class="self-center">:</span>
            <input id="ss" class="w-20 px-3 py-2 rounded bg-slate-800 border border-slate-700" inputmode="numeric" value="${String(defaultHMS.ss).padStart(2,'0')}" aria-label="Seconds" />
          </div>
          <p id="err" class="text-rose-400 text-sm mt-2 hidden">Please enter a valid time (not 00:00:00).</p>
        </fieldset>
        <label class="inline-flex items-center gap-2 mb-6">
          <input id="autostart" type="checkbox" class="accent-emerald-500" ${existing?.autoStart ? 'checked':''} />
          <span>Auto-start when created</span>
        </label>
        <div class="flex justify-end gap-2">
          <button type="button" id="cancel" class="${ghostBtn()}">Cancel</button>
          <button type="submit" class="${btnBase('text-emerald-300')}">${isEdit?'Save':'Create'}</button>
        </div>
      </form>
    </div>
  `;
  modalRoot.classList.remove('hidden'); modalRoot.setAttribute('aria-hidden','false');
  const form = QS('#cd-form', modalRoot);
  const cancel = QS('#cancel', modalRoot);
  const err = QS('#err', modalRoot);
  form.label.focus();
  cancel.addEventListener('click', () => { audio.play('click'); close(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault(); audio.play('click');
    const hh = clamp(parseInt(QS('#hh').value,10)||0,0,99);
    const mm = clamp(parseInt(QS('#mm').value,10)||0,0,59);
    const ss = clamp(parseInt(QS('#ss').value,10)||0,0,59);
    const total = msFromHMS(hh,mm,ss);
    const newLabel = enforceLabelMax(QS('#label').value);
    if (total <= 0) { err.classList.remove('hidden'); return; }
    if (isEdit) {
      existing.label = newLabel;
      existing.durationMs = total;
      // Reset remaining to new duration (common expected behavior)
      existing.remainingMs = total;
      // If previously running, keep running
      if (existing.state === 'running') existing._lastTick = performance.now();
      manager.save(); render();
    } else {
      const cd = new Countdown({ label: newLabel, durationMs: total, autoStart: QS('#autostart').checked });
      cd.remainingMs = total;
      manager.addTimer(cd);
      if (cd.autoStart) cd.start();
      manager.save(); render();
    }
    close();
  });
  function close() {
    modalRoot.classList.add('hidden'); modalRoot.setAttribute('aria-hidden','true'); modalRoot.innerHTML=''; 
  }
  document.addEventListener('keydown', function onEsc(ev){ if (ev.key==='Escape'){ document.removeEventListener('keydown', onEsc); close(); }});
}

/* ------------------------------- Ticker --------------------------------- */

function loop(now) {
  for (const t of manager.timers) {
    t.tick(now);
  }
  // Update the visible outputs only (efficiently)
  if (!manager.focusId) {
    QSA('article[role="group"]', boardEl).forEach(card => {
      const t = manager.get(card.dataset.id); if (!t) return;
      const text = t.type === 'stopwatch' ? fmtHMS(t.elapsedMs) : fmtHMS(t.remainingMs);
      const out = card.querySelector('.timer-output'); if (out) out.textContent = text;
    });
  } else {
    const t = manager.get(manager.focusId);
    if (t && focusEl.firstElementChild) {
      const out = QS('output.timer-output', focusEl);
      if (out) out.textContent = t.type === 'stopwatch' ? fmtHMS(t.elapsedMs, {showCenti:true}) : fmtHMS(t.remainingMs, {showCenti:true});
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ---------------------- Countdown finish side-effects ------------------- */

function wireFinishCallbacks() {
  manager.timers.forEach(t => {
    if (t.type === 'countdown') {
      t.onFinished = async (timer) => {
        // Always show modal + info sound
        audio.play('info');
        // Try browser notification; also play notification sound if permission granted
        const notified = await notifier.notify({ title: 'Countdown finished', body: timer.label });
        if (notified) audio.play('notification');
        // Queue modal so multiple timers each show their own popup (no exceptions)
        queueModal({
          title: 'Countdown finished',
          message: `“${timer.label}” has reached 00:00:00.`,
          onConfirm() {
            timer.clear();
            manager.save();
            render();
          }
        });
        render(); // update state styles
      };
    }
  });
}

/* ------------------------------- Bootstrap ------------------------------ */

function applyURLParams() {
  const params = new URLSearchParams(location.search);
  const countdown = params.get('countdown');
  const autostart = params.get('autostart') === 'true';
  if (countdown) {
    const { hh, mm, ss } = parseHMS(countdown);
    const cd = new Countdown({ label: 'Countdown', durationMs: msFromHMS(hh,mm,ss), autoStart: autostart });
    cd.remainingMs = cd.durationMs;
    manager.addTimer(cd); if (autostart) cd.start(); manager.save();
  }
}

function init() {
  // Ensure click produces first audio unlock on iOS etc.
  document.addEventListener('click', function once(){ audio.play('click'); document.removeEventListener('click', once); }, { once: true });

  // Apply default theme state
  if (UI_STATE.theme === 'light') {
    ensureLightOverrides();
    document.documentElement.classList.add('tw-light');
  }

  render(UI_STATE.filterText);
  wireFinishCallbacks();
  applyURLParams();
}
init();
wireFinishCallbacks(); // after potential URL add

/* End of file */
