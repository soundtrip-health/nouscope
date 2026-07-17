/**
 * MultiTrackScrubber — the master transport for the Multi-Track tab.
 *
 * Sibling of `Scrubber` (the original single-session transport), not a
 * replacement: this tab is a separate, independent feature for reviewing
 * several loaded `.jsonl` recordings side by side, so it gets its own
 * transport bar with its own `mt-scrub-*` ids (the original's `#scrub-*` ids
 * stay exactly as they were, untouched, in the original tab).
 *
 * Owns a single piece of view state: the master playhead cursor, in seconds.
 * Each animation frame — while playing or after a seek — it calls
 * `onFrame(cursor)` so every track can redraw itself at its own effective
 * cursor (`masterCursor + track.offsetSeconds`, or its independent
 * `ownCursor` when unlinked — see `Track`). Per-track quality ribbons/ticks
 * are drawn by each track itself (`timelineDecor`), not here.
 *
 * This tab is file-review only (see App/MultiTrackApp) — there is no live
 * track and no growing timeline here, so unlike `Scrubber` there is no
 * "● LIVE"/follow-the-leading-edge concept at all.
 */

import { renderEventTicks } from './timelineDecor'
import { formatTime as fmt } from './formatTime'

const SPEEDS = [0.25, 0.5, 1, 2, 4]
const DEFAULT_SPEED_IDX = SPEEDS.indexOf(1)
const SEEK_STEP_S = 5           // ← / → keyboard nudge

export default class MultiTrackScrubber {
  /** @param {(cursor:number)=>void} onFrame */
  constructor(onFrame) {
    this._onFrame = onFrame

    // () => overall timeline length (seconds) — max across every track.
    this._durationSource = () => 0
    // () => the Track a keyboard nudge should redirect to when it's unlinked.
    this._focusedTrackSource = () => null
    // () => shared master-timeline markers (see MultiTrackApp) for the tick row.
    this._markersSource = () => []

    this._cursor = 0        // playhead time (s)
    this._speedIdx = DEFAULT_SPEED_IDX
    this._playing = false
    this._dragging = false
    this._active = false
    this._dirty = false
    this._lastPerf = 0
    this._raf = null
  }

  setDurationSource(fn) { this._durationSource = fn }
  setFocusedTrackSource(fn) { this._focusedTrackSource = fn }
  setMarkersSource(fn) { this._markersSource = fn }

  /** Current master timeline length (seconds) — for callers outside the render loop. */
  getDuration() { return this._durationSource() }
  /** Current playhead position (seconds) — e.g. for "add a marker here". */
  getCursor() { return this._cursor }
  /** Whether the transport is actively playing (for driving synced audio playback). */
  isPlaying() { return this._playing }
  /** Current playback speed multiplier (1/2/4×). */
  getSpeed() { return SPEEDS[this._speedIdx] }
  /** Whether the scrubber is shown/wired up (for gating keyboard shortcuts). */
  isActive() { return this._active }

  /**
   * Whether this tab is actually the one on screen right now — `_active`
   * alone stays true once this tab has been shown once (see MultiTrackApp's
   * `onShow`, which never deactivates it on tab-out), so without this check
   * this scrubber's global keydown listener would keep firing shortcuts even
   * while the Single Track tab is the one visible, colliding with its
   * identical listener (Scrubber.js).
   */
  isVisible() {
    return !!this._els?.root && this._els.root.closest('[hidden]') === null
  }

  /** Wire DOM once (idempotent). */
  attach() {
    if (this._els) return
    const $ = (id) => document.getElementById(id)
    this._els = {
      root:     $('mt-scrubber'),
      play:     $('mt-scrub-play'),
      time:     $('mt-scrub-time'),
      duration: $('mt-scrub-duration'),
      timeline: $('mt-scrub-timeline'),
      track:    $('mt-scrub-track'),
      ticks:    $('mt-scrub-ticks'),
      fill:     $('mt-scrub-fill'),
      head:     $('mt-scrub-head'),
      hoverTime: $('mt-scrub-hover-time'),
      speed:    $('mt-scrub-speed'),
    }

    this._els.play.addEventListener('click', () => this.togglePlay())
    this._els.speed.addEventListener('click', () => this._cycleSpeed())

    // Timeline drag / click-to-seek — the whole timeline (track + ribbon + ticks)
    // is clickable, not just the 8px track.
    const fracFromEvent = (e) => {
      const rect = this._els.timeline.getBoundingClientRect()
      return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    }
    const seekFromEvent = (e) => this.seek(fracFromEvent(e) * this._durationSource())
    this._els.timeline.addEventListener('pointerdown', (e) => {
      this._dragging = true
      this._els.timeline.setPointerCapture(e.pointerId)
      seekFromEvent(e)
      this._showHoverTime(e)
    })
    this._els.timeline.addEventListener('pointermove', (e) => {
      if (this._dragging) seekFromEvent(e)
      this._showHoverTime(e)
    })
    this._els.timeline.addEventListener('pointerleave', () => { this._els.hoverTime.hidden = true })
    const endDrag = (e) => {
      // Touch has no real hover/pointerleave, so nothing else would hide the
      // pill after a touch drag ends. Mouse/pen still get a pointerleave when
      // the cursor actually moves away — hiding here too would just flash it
      // off right at release while the cursor is still sitting there hovering.
      if (e.pointerType === 'touch') this._els.hoverTime.hidden = true
      if (!this._dragging) return
      this._dragging = false
      try { this._els.timeline.releasePointerCapture(e.pointerId) } catch {}
    }
    this._els.timeline.addEventListener('pointerup', endDrag)
    this._els.timeline.addEventListener('pointercancel', endDrag)
    this._fracFromEvent = fracFromEvent

    // Keyboard (only acts while the scrubber is active). ←/→ normally nudge the
    // master cursor, but redirect to the focused track's own cursor when that
    // track is unlinked — otherwise there'd be no way to keyboard-nudge it.
    this._onKey = (e) => {
      if (!this._active || !this.isVisible()) return
      if (e.target && /^(input|textarea)$/i.test(e.target.tagName)) return
      const focused = this._focusedTrackSource()
      if (e.key === ' ') { e.preventDefault(); this.togglePlay() }
      else if (e.key === 'ArrowLeft') {
        if (focused && !focused.linked) { focused.ownCursor = focused.clampTime(focused.ownCursor - SEEK_STEP_S); this.refresh() }
        else this.seek(this._cursor - SEEK_STEP_S)
      } else if (e.key === 'ArrowRight') {
        if (focused && !focused.linked) { focused.ownCursor = focused.clampTime(focused.ownCursor + SEEK_STEP_S); this.refresh() }
        else this.seek(this._cursor + SEEK_STEP_S)
      } else if (e.key === 'Home')       { this.seek(0) }
      else if (e.key === 'End')          { this.seek(this._durationSource()) }
    }
    document.addEventListener('keydown', this._onKey)
  }

  /** Resize the head/track geometry (call on window resize). No-op today — kept
   *  for symmetry with the per-track resize and in case the master bar grows
   *  its own canvas again. */
  resize() {}

  /**
   * Show/update the floating time pill at the pointer's position — the preview
   * of where a click would seek to, before it's committed. Clamped so it can't
   * overflow past the timeline's left/right edges.
   */
  _showHoverTime(e) {
    const dur = this._durationSource()
    if (dur <= 0) return
    const frac = this._fracFromEvent(e)
    this._els.hoverTime.textContent = fmt(frac * dur)
    this._els.hoverTime.hidden = false
    const rect = this._els.timeline.getBoundingClientRect()
    const half = this._els.hoverTime.offsetWidth / 2
    const rawLeft = frac * rect.width
    this._els.hoverTime.style.left = `${Math.max(half, Math.min(rect.width - half, rawLeft))}px`
  }

  /** Force a redraw on the next frame (e.g. after new data was ingested). */
  refresh() { this._dirty = true }

  /**
   * Show/hide + start/stop the scrubber. On activation, jumps to the start
   * unless told otherwise.
   * @param {boolean} on
   * @param {{atStart?:boolean}} [opts]
   */
  setActive(on, opts = {}) {
    this._active = on
    if (this._els?.root) this._els.root.hidden = !on
    if (on) {
      if (opts.atStart) this._cursor = 0
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
      // If parked at the end, restart from the beginning.
      if (this._cursor >= this._durationSource() - 0.01) this._cursor = 0
      this._lastPerf = performance.now()
    }
    // Force at least one render even though pausing alone wouldn't otherwise
    // trigger one (`_loop`'s needRender check skips idle frames) — synced
    // audio playback only actually stops when `onFrame`/`sync()` runs with
    // `playing=false`; without this, the `<audio>` element just kept
    // physically playing under a frozen "paused" transport until the next
    // real seek/play forced a render and caught the drift.
    this._dirty = true
    this._updatePlayBtn()
  }

  seek(tSeconds) {
    const dur = this._durationSource()
    this._cursor = Math.max(0, Math.min(dur, tSeconds))
    this._dirty = true
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _cycleSpeed() {
    this._speedIdx = (this._speedIdx + 1) % SPEEDS.length
    this._els.speed.textContent = `${SPEEDS[this._speedIdx]}×`
  }

  _updatePlayBtn() {
    if (this._els?.play) this._els.play.textContent = this._playing ? '⏸' : '▶'
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop())
    if (!this._active) return

    const now = performance.now()
    const dt = (now - this._lastPerf) / 1000
    this._lastPerf = now
    const dur = this._durationSource()

    let needRender = this._dirty || this._dragging

    if (this._playing) {
      this._cursor += dt * SPEEDS[this._speedIdx]
      if (this._cursor >= dur) {
        this._cursor = dur
        this._playing = false
      }
      needRender = true
    }

    if (needRender) {
      this._dirty = false
      this._render(dur)
    }
  }

  _render(dur) {
    this._onFrame(this._cursor)

    // Re-sync the play/pause icon on every actual render — not just from the
    // handful of call sites that flip `_playing` directly (togglePlay/etc).
    // A drag-seek or the panel's first frame both trigger a render without
    // going through any of those, so without this the button could show
    // stale state until some unrelated call happened to refresh it.
    this._updatePlayBtn()

    // Master track UI. Per-track ribbons/ticks are drawn by each Track itself.
    const frac = dur > 0 ? this._cursor / dur : 0
    this._els.fill.style.width = `${(frac * 100).toFixed(2)}%`
    this._els.head.style.left = `${(frac * 100).toFixed(2)}%`
    this._els.time.textContent = fmt(this._cursor)
    this._els.duration.textContent = fmt(dur)

    // Marker ticks only — no per-track music/gap store here, and cheap enough
    // (a handful of divs) to redraw every frame with no throttling.
    if (this._els.ticks) {
      renderEventTicks(this._els.ticks, null, { offsetSeconds: 0, masterDuration: dur }, this._markersSource(), (m) => this.seek(m.t))
    }
  }
}
