/**
 * Scrubber — the master movie-style transport under the multi-track panel.
 *
 * Owns a single piece of view state: the master playhead cursor, in seconds.
 * Each animation frame — while playing, following live, or after a seek — it
 * calls `onFrame(cursor)` so every track can redraw itself at its own
 * effective cursor (`masterCursor + track.offsetSeconds`, or its independent
 * `ownCursor` when unlinked — see `Track`). Per-track quality ribbons/ticks are
 * drawn by each track itself (`timelineDecor`), not here.
 *
 * Duration isn't a single store's anymore — it's supplied via
 * `setDurationSource`/`setLiveDurationSource` callbacks so the master timeline
 * can span every track (the longest one) while "● LIVE" follows specifically
 * the live track's leading edge, not just whichever track is longest.
 */

const SPEEDS = [1, 2, 4]
const SEEK_STEP_S = 5           // ← / → keyboard nudge

export default class Scrubber {
  /** @param {(cursor:number)=>void} onFrame */
  constructor(onFrame) {
    this._onFrame = onFrame

    // () => overall timeline length (seconds) — max across every track.
    this._durationSource = () => 0
    // () => the live track's own duration, or null if there is no live track.
    this._liveDurationSource = () => null
    // () => the Track a keyboard nudge should redirect to when it's unlinked.
    this._focusedTrackSource = () => null

    this._cursor = 0        // playhead time (s)
    this._speedIdx = 0
    this._playing = false
    this._following = false // track the live leading edge
    this._dragging = false
    this._active = false
    this._dirty = false
    this._lastPerf = 0
    this._raf = null
  }

  setDurationSource(fn) { this._durationSource = fn }
  setLiveDurationSource(fn) { this._liveDurationSource = fn }
  setFocusedTrackSource(fn) { this._focusedTrackSource = fn }

  /** Current master timeline length (seconds) — for callers outside the render loop. */
  getDuration() { return this._durationSource() }

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
      hoverTime: $('scrub-hover-time'),
      live:     $('scrub-live'),
      speed:    $('scrub-speed'),
    }

    this._els.play.addEventListener('click', () => this.togglePlay())
    this._els.live.addEventListener('click', () => this.goLive())
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
      this._following = false
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
      if (!this._active) return
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
      else if (e.key === 'End')          { this.goLive() }
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

  /** ● LIVE only means something with a live track to follow — hide it otherwise. */
  _updateLiveBtn() {
    if (this._els?.live) this._els.live.hidden = this._liveDurationSource() == null
  }

  /** Force a redraw on the next frame (e.g. after new data was ingested). */
  refresh() { this._dirty = true }

  /**
   * Show/hide + start/stop the scrubber. On activation, jumps to the start, or
   * follows the live track's leading edge.
   * @param {boolean} on
   * @param {{atStart?:boolean, follow?:boolean}} [opts]
   */
  setActive(on, opts = {}) {
    this._active = on
    if (this._els?.root) this._els.root.hidden = !on
    this._updateLiveBtn()
    if (on) {
      if (opts.follow) { this._following = true; this._cursor = this._liveDurationSource() ?? this._durationSource() }
      else if (opts.atStart) { this._following = false; this._cursor = 0 }
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
      if (this._cursor >= this._durationSource() - 0.01) this._cursor = 0
      this._lastPerf = performance.now()
    }
    this._updatePlayBtn()
  }

  /**
   * Stop tracking the leading edge without moving the playhead — used when the
   * headset drops, since the live track stops growing and "following" would
   * just pin the cursor to a frozen duration.
   */
  stopFollowing() {
    this._following = false
    this._updatePlayBtn()
    this._dirty = true
  }

  goLive() {
    this._following = true
    this._playing = false
    this._updatePlayBtn()
    this._cursor = this._liveDurationSource() ?? this._durationSource()
    this._dirty = true
  }

  seek(tSeconds) {
    const dur = this._durationSource()
    this._cursor = Math.max(0, Math.min(dur, tSeconds))
    this._following = this._isLiveEdge(dur)
    this._dirty = true
  }

  /**
   * True only when the cursor sits on the live track's own leading edge *and*
   * that edge is also the master timeline's end. A loaded file can be far
   * longer than the live track, so a seek anywhere past the live track's own
   * (short) duration must not by itself re-engage live-follow — otherwise
   * every seek into the longer file's later data would snap straight back to
   * the live edge instead of landing where it was aimed.
   */
  _isLiveEdge(dur) {
    const liveDur = this._liveDurationSource()
    return liveDur != null && dur - liveDur <= 0.01 && this._cursor >= liveDur - 0.01
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _cycleSpeed() {
    this._speedIdx = (this._speedIdx + 1) % SPEEDS.length
    this._els.speed.textContent = `${SPEEDS[this._speedIdx]}×`
  }

  _updatePlayBtn() {
    if (this._els?.play) this._els.play.textContent = this._playing ? '⏸' : '▶'
    if (this._els?.live) this._els.live.classList.toggle('active', this._following)
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop())
    if (!this._active) return

    const now = performance.now()
    const dt = (now - this._lastPerf) / 1000
    this._lastPerf = now
    const dur = this._durationSource()
    const liveDur = this._liveDurationSource()

    let needRender = this._dirty || this._dragging

    if (this._following) {
      this._cursor = liveDur ?? dur
      needRender = true
    } else if (this._playing) {
      this._cursor += dt * SPEEDS[this._speedIdx]
      // Playback reaching the overall (longest-track) end stops; it only
      // re-engages live-follow if that end is actually the live track's edge.
      if (this._cursor >= dur) {
        this._cursor = dur
        this._playing = false
        if (this._isLiveEdge(dur)) this._following = true
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

    // Re-sync the play/pause icon and ● LIVE's red/grey state on every actual
    // render — not just from the handful of call sites that flip `_playing`/
    // `_following` directly (togglePlay/stopFollowing/goLive/etc). A drag-seek
    // or the panel's first frame both change `_following` without going
    // through any of those, so without this the button could show stale state
    // (e.g. not starting red, or staying red after dragging away) until some
    // unrelated call happened to refresh it.
    this._updatePlayBtn()

    // Master track UI. Per-track ribbons/ticks are drawn by each Track itself.
    const frac = dur > 0 ? this._cursor / dur : 0
    this._els.fill.style.width = `${(frac * 100).toFixed(2)}%`
    this._els.head.style.left = `${(frac * 100).toFixed(2)}%`
    this._els.time.textContent = fmt(this._cursor)
    this._els.duration.textContent = fmt(dur)
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
