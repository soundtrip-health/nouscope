import { guess } from 'web-audio-beat-detector'
import { renderEventTicks } from './timelineDecor'

// Deadband before hard-seeking the <audio> element — its own clock is
// accurate once actually playing, so only correct real drift (a scrub-drag,
// an offset edit), not every sub-frame float rounding difference.
const DRIFT_S = 0.18

// Fixed scope id for markers added via this row's own "+ Marker" button —
// there's only ever one audio row, so a constant works (see `Track` for the
// per-recording equivalent, which uses each track's own generated `id`).
export const AUDIO_TRACK_ID = 'audio'

/**
 * AudioTrack — the (at most one) loaded stimulus-audio file in the
 * Multi-Track tab, played back in sync with the master transport (see
 * `sync()`). Sibling of `Track`, but far simpler: no WebGL panels, no
 * per-channel quality ribbon — just an offset, a mute toggle, a BPM readout,
 * and a thin timeline strip carrying the shared marker ticks. Owned directly
 * by `MultiTrackApp` (no manager class — there's only ever zero or one).
 *
 * The strip's fill/head always mirrors the master cursor directly (the same
 * "linked" behavior a `Track` has), since its job is to carry the marker
 * ticks in the shared `[0, masterDuration]` frame, not to show a locally-
 * rescaled playhead. `offsetSeconds` only affects where *playback* maps onto
 * that shared timeline (see `sync()`) — separate from strip positioning.
 */
export default class AudioTrack {
  /**
   * @param {object} opts
   * @param {() => number} opts.getMasterDuration
   * @param {(t: number) => void} opts.seekMaster
   * @param {() => void} [opts.markDirty] — force the master scrubber to redraw next frame.
   * @param {() => void} [opts.onRemove] — called when the "✕" button is clicked.
   * @param {() => {t:number,label:string,trackId:?string}[]} [opts.getMarkers] —
   *   every marker; this row overlays the global ones (`trackId == null`)
   *   plus any scoped to `AUDIO_TRACK_ID`.
   * @param {() => void} [opts.onAddMarker] — called when this row's own
   *   "+ Marker" button is clicked, to add a marker scoped to the audio row alone.
   */
  constructor({ getMasterDuration, seekMaster, markDirty, onRemove, getMarkers, onAddMarker }) {
    this.label = ''
    this.offsetSeconds = 0
    this.bpmValue = 0

    this._audio = new Audio()
    this._audio.preload = 'auto'
    this._objectUrl = null

    this._getMasterDuration = getMasterDuration ?? (() => 0)
    this._seekMaster = seekMaster ?? (() => {})
    this._markDirty = markDirty ?? (() => {})
    this._onRemove = onRemove ?? (() => {})
    this._getMarkers = getMarkers ?? (() => [])
    this._onAddMarker = onAddMarker ?? (() => {})
    this._dragging = false

    this._ticksDirty = true
    this._ticksBuiltFor = -1

    this.root = this._build()
  }

  _build() {
    const root = document.createElement('div')
    root.className = 'mt-track mt-audio-track'
    root.innerHTML = `
      <div class="mt-track-header">
        <div class="mt-track-controls">
          <button type="button" class="mt-track-remove-btn controls-upload-btn" title="Remove this audio">✕</button>
        </div>
        <div class="mt-track-strip">
          <span class="mt-track-label"></span>
        </div>
        <div class="mt-track-buttons">
          <button type="button" class="mt-audio-mute-btn scrub-btn" title="Mute"></button>
          <input type="number" class="mt-track-offset-input" step="0.5" value="0" title="Offset from master (s)" />
          <button type="button" class="mt-marker-add-btn scrub-btn" title="Queue a marker here (this audio row only) — name it in the box that gets focused">+ Marker</button>
          <span class="mt-audio-bpm"></span>
        </div>
      </div>
      <div class="mt-track-lane-col mt-audio-lane-col">
        <div class="scrub-timeline mt-track-timeline">
          <div class="scrub-track">
            <div class="scrub-fill"></div>
            <div class="scrub-head"></div>
          </div>
          <div class="scrub-ticks"></div>
        </div>
      </div>
    `
    this._labelEl      = root.querySelector('.mt-track-label')
    this._removeBtn    = root.querySelector('.mt-track-remove-btn')
    this._muteBtn      = root.querySelector('.mt-audio-mute-btn')
    this._offsetInput  = root.querySelector('.mt-track-offset-input')
    this._addMarkerBtn = root.querySelector('.mt-marker-add-btn')
    this._bpmEl        = root.querySelector('.mt-audio-bpm')
    this._timelineEl   = root.querySelector('.mt-track-timeline')
    this._fillEl       = root.querySelector('.scrub-fill')
    this._headEl       = root.querySelector('.scrub-head')
    this._ticksEl      = root.querySelector('.scrub-ticks')

    this._removeBtn.addEventListener('click', () => this._onRemove())

    this._updateMuteBtn()
    this._muteBtn.addEventListener('click', () => {
      this._audio.muted = !this._audio.muted
      this._updateMuteBtn()
    })

    this._offsetInput.addEventListener('change', () => {
      const v = parseFloat(this._offsetInput.value)
      this.offsetSeconds = Number.isFinite(v) ? v : 0
      this._markDirty()
    })

    this._addMarkerBtn.addEventListener('click', () => this._onAddMarker())

    const fracFromEvent = (e) => {
      const rect = this._timelineEl.getBoundingClientRect()
      return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    }
    const seekFromEvent = (e) => this._seekMaster(fracFromEvent(e) * this._getMasterDuration())
    this._timelineEl.addEventListener('pointerdown', (e) => {
      this._dragging = true
      this._timelineEl.setPointerCapture(e.pointerId)
      seekFromEvent(e)
    })
    this._timelineEl.addEventListener('pointermove', (e) => { if (this._dragging) seekFromEvent(e) })
    const endDrag = (e) => {
      if (!this._dragging) return
      this._dragging = false
      try { this._timelineEl.releasePointerCapture(e.pointerId) } catch {}
    }
    this._timelineEl.addEventListener('pointerup', endDrag)
    this._timelineEl.addEventListener('pointercancel', endDrag)

    return root
  }

  _updateMuteBtn() {
    this._muteBtn.textContent = this._audio.muted ? '🔇' : '🔊'
    this._muteBtn.title = this._audio.muted ? 'Unmute' : 'Mute'
  }

  /**
   * Load a new audio file: swap in a fresh playback element and (re-)detect
   * BPM via a one-off decode.
   *
   * Deliberately does NOT reuse `BPMManager` — its `detectBPM()`
   * unconditionally calls `setBPM()`, which logs to `App.recordingManager` (a
   * cross-tab static singleton). Reusing it here would silently inject a
   * spurious `music` JSONL record into an unrelated, currently-recording
   * single-session tab, if one happened to be live. `guess()` is the same
   * underlying detector `BPMManager` calls, just without that side effect.
   */
  async loadFile(file) {
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl)
    this._objectUrl = URL.createObjectURL(file)
    this._audio.pause()
    this._audio.src = this._objectUrl
    this.setLabel(file.name)
    this.bpmValue = 0
    this._bpmEl.textContent = ''

    let audioBuffer
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      audioBuffer = await ctx.decodeAudioData(await file.arrayBuffer())
      ctx.close()
    } catch (err) {
      console.error('Audio decode failed:', err)
      return
    }
    try {
      const { bpm } = await guess(audioBuffer)
      this.bpmValue = bpm
    } catch {
      this.bpmValue = 120
    }
    this._bpmEl.textContent = `${Math.round(this.bpmValue)} BPM`
  }

  setLabel(text) {
    this.label = text
    if (this._labelEl) this._labelEl.textContent = text
  }

  /**
   * Keep the `<audio>` element's position/rate/play-state matching the master
   * transport. Called every master render tick (see `MultiTrackApp`).
   */
  sync(masterCursor, playing, speed) {
    const dur = this._audio.duration
    if (!dur || Number.isNaN(dur)) return
    const target = masterCursor - this.offsetSeconds
    const inRange = target >= 0 && target <= dur
    if (!inRange) {
      if (!this._audio.paused) this._audio.pause()
      return
    }
    if (Math.abs(this._audio.currentTime - target) > DRIFT_S) this._audio.currentTime = target
    if (this._audio.playbackRate !== speed) this._audio.playbackRate = speed
    if (playing && this._audio.paused) this._audio.play().catch(() => {})
    else if (!playing && !this._audio.paused) this._audio.pause()
  }

  /** Position the fill/head + rebuild the tick row within the shared master coordinate frame. */
  renderTimeline(masterCursor) {
    const masterDur = this._getMasterDuration()
    const frac = masterDur > 0 ? Math.max(0, Math.min(1, masterCursor / masterDur)) : 0
    this._fillEl.style.width = `${(frac * 100).toFixed(2)}%`
    this._headEl.style.left = `${(frac * 100).toFixed(2)}%`
    this._maybeRebuildTicks(masterDur)
  }

  _maybeRebuildTicks(masterDur) {
    if (masterDur <= 0) return
    if (!this._ticksDirty && masterDur === this._ticksBuiltFor) return
    this._ticksDirty = false
    this._ticksBuiltFor = masterDur
    // offsetSeconds: 0 — this strip is always in absolute master-frame terms
    // (see class doc), unlike `sync()`'s playback-position mapping. Global
    // markers plus any scoped to this audio row alone — never a track's.
    const markers = this._getMarkers().filter(m => m.trackId == null || m.trackId === AUDIO_TRACK_ID)
    renderEventTicks(this._ticksEl, null, { offsetSeconds: 0, masterDuration: masterDur }, markers, (m) => this._seekMaster(m.t))
  }

  /** Force the tick row to refresh after a marker add/edit/delete. */
  notifyMarkersChanged() {
    this._ticksDirty = true
  }

  dispose() {
    this._audio.pause()
    this._audio.src = ''
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl)
    this.root?.remove()
  }
}
