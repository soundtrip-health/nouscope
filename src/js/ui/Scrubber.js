/**
 * Scrubber — the movie-style transport for the Analysis tab.
 *
 * Owns a playhead cursor (seconds) and a window width W. The visible window is
 * `[cursor - W, cursor]` (history ending at the playhead, matching the live
 * view's "recent past up to now"); W = 0 means "show the whole session". Each
 * animation frame — while playing, following live, or after a seek — it calls
 * `onFrame(store, t0, t1, cursor)` to redraw and updates its own track UI.
 *
 * Kept deliberately dumb about *what* gets drawn: App wires `onFrame` to
 * AnalysisDisplay.renderWindow, so the scrubber works for both a loaded file
 * and a live/DVR session (where the store keeps growing and "● LIVE" follows
 * the leading edge).
 */

import { cssVar } from './palette'

const SPEEDS = [1, 2, 4]
const RIBBON_SAMPLES = 300      // ribbon resolution, independent of canvas pixel width
const RIBBON_REBUILD_MS = 1000  // throttle: re-sample at most this often while a live session grows

export default class Scrubber {
  /** @param {(store, t0:number, t1:number, cursor:number)=>void} onFrame */
  constructor(onFrame) {
    this._onFrame = onFrame
    this._store = null

    this._cursor = 0        // playhead time (s)
    this._window = 30       // visible width (s); 0 = whole session
    this._speedIdx = 0
    this._playing = false
    this._following = false // track the live leading edge
    this._dragging = false
    this._active = false
    this._dirty = false
    this._lastPerf = 0
    this._raf = null

    // Quality ribbon + event ticks (see `_renderTimeline`).
    this._ribbonDirty = true
    this._ribbonBuiltFor = -1
    this._ribbonLastBuiltAt = 0
    this._colors = null
  }

  /** Wire DOM once (idempotent). */
  attach() {
    if (this._els) return
    const $ = (id) => document.getElementById(id)
    this._els = {
      root:     $('scrubber'),
      play:     $('scrub-play'),
      time:     $('scrub-time'),
      duration: $('scrub-duration'),
      timeline: $('scrub-timeline'),
      track:    $('scrub-track'),
      fill:     $('scrub-fill'),
      head:     $('scrub-head'),
      ribbon:   $('scrub-ribbon'),
      ticks:    $('scrub-ticks'),
      live:     $('scrub-live'),
      speed:    $('scrub-speed'),
      window:   $('scrub-window'),
      windowText: $('scrub-window-text'),
    }
    this._ribbonCtx = this._els.ribbon.getContext('2d')
    // Read lazily (matches BioDataDisplay/AnalysisDisplay/palette.js convention) —
    // the stylesheet must be parsed before getComputedStyle can resolve these.
    this._colors = {
      good: cssVar('--status-good'),
      marginal: cssVar('--status-marginal'),
      poor: cssVar('--status-poor'),
    }

    this._els.play.addEventListener('click', () => this.togglePlay())
    this._els.live.addEventListener('click', () => this.goLive())
    this._els.speed.addEventListener('click', () => this._cycleSpeed())
    this._els.window.addEventListener('change', (e) => this._setWindow(+e.target.value))

    // Timeline drag / click-to-seek — the whole timeline (track + ribbon + ticks)
    // is clickable, not just the 8px track.
    const seekFromEvent = (e) => {
      const rect = this._els.timeline.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      this.seek(frac * this._durationOr0())
    }
    this._els.timeline.addEventListener('pointerdown', (e) => {
      this._dragging = true
      this._following = false
      this._els.timeline.setPointerCapture(e.pointerId)
      seekFromEvent(e)
    })
    this._els.timeline.addEventListener('pointermove', (e) => { if (this._dragging) seekFromEvent(e) })
    const endDrag = (e) => {
      if (!this._dragging) return
      this._dragging = false
      try { this._els.timeline.releasePointerCapture(e.pointerId) } catch {}
    }
    this._els.timeline.addEventListener('pointerup', endDrag)
    this._els.timeline.addEventListener('pointercancel', endDrag)

    // Keyboard (only acts while the scrubber is active).
    this._onKey = (e) => {
      if (!this._active) return
      if (e.key === ' ') { e.preventDefault(); this.togglePlay() }
      else if (e.key === 'ArrowLeft')  { this.seek(this._cursor - this._stepSize()) }
      else if (e.key === 'ArrowRight') { this.seek(this._cursor + this._stepSize()) }
      else if (e.key === 'Home')       { this.seek(0) }
      else if (e.key === 'End')        { this.goLive() }
    }
    document.addEventListener('keydown', this._onKey)
  }

  setStore(store) {
    this._store = store
    this._dirty = true
    this._ribbonDirty = true   // new/changed session — rebuild the ribbon+ticks immediately
    this._updateLiveBtn()
  }

  /** Resize the ribbon canvas buffer to match its on-screen size (call on window resize). */
  resize() {
    if (!this._els) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const c = this._els.ribbon
    const r = c.getBoundingClientRect()
    if (!r.width || !r.height) return
    const w = Math.max(1, Math.round(r.width * dpr))
    const h = Math.max(1, Math.round(r.height * dpr))
    if (c.width !== w || c.height !== h) {
      // Assigning canvas.width/height clears its drawing buffer, so anything
      // painted before this call (e.g. the first synchronous render triggered
      // by `setActive()`, before `App._setView` gets to call `resize()`) is
      // wiped out right here. `_ribbonDirty` alone isn't enough to recover —
      // it's only checked inside `_render()`, which is gated behind `_dirty`;
      // without also setting that, the ribbon stays blank until something
      // else (e.g. a seek) happens to flip `_dirty` again. Set both.
      c.width = w; c.height = h
      this._ribbonDirty = true
      this._dirty = true
    }
  }

  /** ● LIVE only means something for a growing live session — hide it for files. */
  _updateLiveBtn() {
    if (this._els?.live) this._els.live.hidden = this._store?.source !== 'live'
  }

  /** Force a redraw on the next frame (e.g. after new data was ingested). */
  refresh() { this._dirty = true }

  /**
   * Show/hide + start/stop the scrubber. On activation, jumps to the start of a
   * file, or follows the live edge of a growing session.
   * @param {boolean} on
   * @param {{atStart?:boolean, follow?:boolean}} [opts]
   */
  setActive(on, opts = {}) {
    this._active = on
    if (this._els?.root) this._els.root.hidden = !on
    this._updateLiveBtn()
    if (on) {
      const dur = this._durationOr0()
      if (opts.follow) { this._following = true; this._cursor = dur }
      else if (opts.atStart) { this._following = false; this._cursor = Math.min(this._window || dur, dur) }
      this._dirty = true
      this._lastPerf = performance.now()
      if (!this._raf) this._loop()
    } else {
      this._playing = false
      this._updatePlayBtn()
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null }
    }
  }

  togglePlay() {
    this._playing = !this._playing
    if (this._playing) {
      this._following = false
      // If parked at the end, restart from the beginning.
      if (this._cursor >= this._durationOr0() - 0.01) this._cursor = 0
      this._lastPerf = performance.now()
    }
    this._updatePlayBtn()
  }

  goLive() {
    this._following = true
    this._playing = false
    this._updatePlayBtn()
    this._cursor = this._durationOr0()
    this._dirty = true
  }

  seek(tSeconds) {
    const dur = this._durationOr0()
    this._cursor = Math.max(0, Math.min(dur, tSeconds))
    this._following = false
    this._dirty = true
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _durationOr0() { return this._store ? this._store.duration() : 0 }

  _stepSize() { return this._window ? this._window * 0.1 : Math.max(1, this._durationOr0() * 0.02) }

  _cycleSpeed() {
    this._speedIdx = (this._speedIdx + 1) % SPEEDS.length
    this._els.speed.textContent = `${SPEEDS[this._speedIdx]}×`
  }

  _setWindow(w) {
    this._window = w
    if (this._els.windowText) {
      const opt = [...this._els.window.options].find(o => +o.value === w)
      this._els.windowText.textContent = opt ? opt.textContent : `${w}s`
    }
    this._dirty = true
  }

  _updatePlayBtn() {
    if (this._els?.play) this._els.play.textContent = this._playing ? '⏸' : '▶'
    if (this._els?.live) this._els.live.classList.toggle('active', this._following)
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop())
    if (!this._active || !this._store) return

    const now = performance.now()
    const dt = (now - this._lastPerf) / 1000
    this._lastPerf = now
    const dur = this._durationOr0()

    let needRender = this._dirty || this._dragging

    if (this._following) {
      this._cursor = dur
      needRender = true
    } else if (this._playing) {
      this._cursor += dt * SPEEDS[this._speedIdx]
      if (this._cursor >= dur) { this._cursor = dur; this._playing = false; this._updatePlayBtn() }
      needRender = true
    }

    if (needRender) {
      this._dirty = false
      this._render(dur)
    }
  }

  _render(dur) {
    // Fixed width W → sliding window [cursor-W, cursor] (ends at the playhead).
    // "All" (W=0) → the whole session [0, dur] on every graph; the playhead still
    // marks a position (used for the scalar readouts).
    const cursor = this._cursor
    const t0 = this._window ? Math.max(0, cursor - this._window) : 0
    const t1 = this._window ? cursor : dur
    this._onFrame(this._store, t0, t1, cursor)

    // Track UI.
    const frac = dur > 0 ? this._cursor / dur : 0
    this._els.fill.style.width = `${(frac * 100).toFixed(2)}%`
    this._els.head.style.left = `${(frac * 100).toFixed(2)}%`
    this._els.time.textContent = fmt(this._cursor)
    this._els.duration.textContent = fmt(dur)

    this._renderTimeline(dur)
  }

  // ── Quality ribbon + event ticks ─────────────────────────────────────────

  /**
   * Rebuild the quality ribbon and event ticks — but not every frame. A loaded
   * file has a fixed duration, so this builds once and never again; a live/DVR
   * session's duration keeps growing, so it re-samples at most once every
   * `RIBBON_REBUILD_MS` as new data arrives. Without this throttle, redoing a
   * 300-point quality scan (each touching ~1 s of raw EEG) every animation frame
   * would reintroduce the same per-frame-cost problem the Analysis tab's line
   * plots had before their mip-pyramid fix.
   */
  _renderTimeline(dur) {
    if (!this._store || dur <= 0) return
    const now = performance.now()
    if (!this._ribbonDirty && dur === this._ribbonBuiltFor) return
    if (!this._ribbonDirty && now - this._ribbonLastBuiltAt < RIBBON_REBUILD_MS) return

    this._ribbonDirty = false
    this._ribbonBuiltFor = dur
    this._ribbonLastBuiltAt = now
    this._renderQualityRibbon(dur)
    this._renderTicks(dur)
  }

  /**
   * One thin row per EEG channel (TP9/AF7/AF8/TP10, top→bottom — same order as
   * everywhere else) rather than a single collapsed worst-of-4 row, so a lone
   * bad electrode reads as exactly that instead of looking like the whole
   * signal dropped out.
   */
  _renderQualityRibbon(dur) {
    const c = this._els.ribbon
    const ctx = this._ribbonCtx
    const W = c.width, H = c.height
    if (!W || !H) return
    ctx.clearRect(0, 0, W, H)   // rows leave a gap between them, so old pixels must be cleared first
    const perChannel = this._store.qualityRibbon(RIBBON_SAMPLES)
    const nc = perChannel.length
    const cellH = H / nc
    const gap = Math.max(1, Math.round(cellH * 0.2))   // visual separation between rows
    for (let ch = 0; ch < nc; ch++) {
      const y0 = Math.round(ch * cellH)
      const y1 = Math.round((ch + 1) * cellH) - gap
      const row = perChannel[ch]
      for (let i = 0; i < RIBBON_SAMPLES; i++) {
        const x0 = Math.floor((i * W) / RIBBON_SAMPLES)
        const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * W) / RIBBON_SAMPLES))
        ctx.fillStyle = this._colors[row[i]] || this._colors.poor
        ctx.fillRect(x0, y0, x1 - x0, Math.max(1, y1 - y0))
      }
    }
  }

  _renderTicks(dur) {
    const container = this._els.ticks
    container.innerHTML = ''
    const addTick = (t, cls) => {
      const el = document.createElement('div')
      el.className = `scrub-tick ${cls}`
      el.style.left = `${Math.max(0, Math.min(100, (t / dur) * 100)).toFixed(2)}%`
      container.appendChild(el)
    }
    for (const rec of this._store.music) addTick(rec.t, 'scrub-tick--music')
    for (const gap of this._store.gaps()) addTick(gap.t0, 'scrub-tick--gap')
  }
}

/** Seconds → MM:SS (or H:MM:SS past an hour). */
function fmt(s) {
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = m.toString().padStart(2, '0')
  const ss = sec.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
