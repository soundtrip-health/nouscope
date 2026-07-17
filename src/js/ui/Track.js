import MultiTrackDisplay from './MultiTrackDisplay'
import { renderQualityRibbon, renderEventTicks } from './timelineDecor'
import { cssVar } from './palette'

/**
 * All panel keys a track can show/hide — see `PANEL_WINDOWS` in bioRender.
 * Excludes `specAudio` (Audio Tempo): every track in this tab is a loaded
 * `.jsonl` file with no live entrainment computation feeding it, so that
 * panel can never have data here (see `MultiTrackDisplay.renderAt`, which
 * hides it unconditionally for file-sourced stores) — offering it in the
 * menu would just waste one of the 4 panel slots on a panel that can never
 * show anything.
 */
export const ALL_PANELS = ['eeg', 'spec', 'specLo', 'bands', 'mse', 'ppg', 'imu']

const PANEL_LABELS = {
  eeg: 'EEG', spec: 'Spectrogram', specLo: 'Delta / Theta',
  bands: 'EEG Bands', mse: 'Complexity (MSE)', ppg: 'PPG', imu: 'IMU',
}

// Hard cap enforced by the graph-select menu — each enabled line-plot panel
// (all but the 3 spectrograms) holds its own WebGL context, and several
// tracks each showing every panel would blow past the browser's live-context
// limit (~8–16). Capping per track keeps the total bounded regardless of how
// many tracks are on screen.
export const MAX_PANELS = 4
export const DEFAULT_PANELS = ['eeg', 'bands', 'spec']

// Per-track accent color, cycled by creation order — reuses the EEG-electrode
// hue tokens (see _tokens.scss) rather than inventing new ones, and lines up
// 1:1 with MAX_TRACKS (TrackManager.js) so every concurrent track gets a
// distinct, already-themed color.
export const TRACK_ACCENT_VARS = ['--eeg-tp9', '--eeg-af7', '--eeg-af8', '--eeg-tp10']

// Throttle: re-sample the quality ribbon/ticks at most this often while a
// session grows — see the identical guard the original single-session
// Scrubber has (now per-track, since each track's store grows independently).
const RIBBON_REBUILD_MS = 1000

/**
 * Track — one loaded recording in the Multi-Track tab: a `SessionStore` plus
 * the `MultiTrackDisplay` that draws it, plus its own header (label, a
 * replace/remove-recording button pair, link/offset, graph-select menu) and timeline
 * strip (quality ribbon + event ticks), all wrapped in one root. This tab is
 * file-review only — see App.js/MultiTrackApp.js — so every track is a
 * loaded `.jsonl`; there is no live EEG connection here.
 *
 * By default a track follows the master scrubber's cursor, shifted by its own
 * `offsetSeconds` (so sessions started at different times can be lined up):
 * `effectiveCursor = masterCursor + offsetSeconds`. Unlinking a track lets it
 * be scrubbed independently via `ownCursor`, ignoring the master cursor until
 * relinked. The strip always draws in the master's shared `[0, masterDuration]`
 * coordinate frame — a track's local time `t` appears at `t - offsetSeconds` —
 * so linked and unlinked tracks visually line up the same way.
 */
export default class Track {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {import('../managers/SessionStore').default} opts.store
   * @param {HTMLElement} opts.laneEl — the cloned track-lane-template root, passed to MultiTrackDisplay
   * @param {string} [opts.label]
   * @param {string} [opts.colorVar] — one of `TRACK_ACCENT_VARS`, this track's
   *   accent color (header label, border, timeline fill/head); defaults to the first.
   * @param {string[]|Set<string>} [opts.enabledPanels] — starting panel set; defaults to `DEFAULT_PANELS`.
   * @param {() => number} opts.getMasterDuration
   * @param {(t: number) => void} opts.seekMaster
   * @param {() => void} opts.markDirty — force the master scrubber to redraw
   *   next frame even though the master cursor itself didn't move (needed
   *   whenever this track's own `ownCursor`/`offsetSeconds`/`linked` changes,
   *   since `renderTimeline`/`renderAt` only run as part of its render loop).
   * @param {(track: Track) => void} [opts.onRemove] — called when this
   *   track's "✕" button is clicked.
   * @param {() => {t:number,label:string,color:string,trackIds:?string[]}[]} [opts.getMarkers] —
   *   every marker (see `MultiTrackApp`); this track overlays the global ones
   *   (`trackIds == null`) plus any whose `trackIds` includes its own `id`,
   *   ignoring markers scoped to other tracks. Markers are only ever added/
   *   edited via the master transport's "+ Marker" button/modal — a track
   *   has no add-marker control of its own.
   */
  constructor({ id, store, laneEl, label = '', colorVar, enabledPanels, getMasterDuration, seekMaster, markDirty, onRemove, getMarkers }) {
    this.id = id
    this.store = store
    this.label = label
    this.laneEl = laneEl
    this.color = cssVar(colorVar || TRACK_ACCENT_VARS[0])
    this.root = null   // the `.mt-track` wrapper — set by TrackManager once mounted

    this.linked = true
    this.offsetSeconds = 0
    this.ownCursor = 0
    this.enabledPanels = new Set(enabledPanels ?? DEFAULT_PANELS)

    this._getMasterDuration = getMasterDuration
    this._seekMaster = seekMaster
    this._markDirty = markDirty ?? (() => {})
    this._onRemove = onRemove ?? (() => {})
    this._getMarkers = getMarkers ?? (() => [])
    this._dragging = false

    this._colors = {
      good: cssVar('--status-good'),
      marginal: cssVar('--status-marginal'),
      poor: cssVar('--status-poor'),
    }
    this._ribbonDirty = true
    this._ribbonBuiltFor = -1
    this._ribbonLastBuiltAt = 0

    // Loaded files have no live EEGManager to consult for which bands
    // participate in normalization, so show every band-legend row.
    this.display = new MultiTrackDisplay(laneEl, { normalizeBands: null, enabledPanels: this.enabledPanels })
    this.headerEl = this._buildHeader()
    this.timelineStripEl = this._buildTimelineStrip()
    this._applyPanelVisibility()
  }

  /** Left header column: replace-recording button + label + link/offset/menu. */
  _buildHeader() {
    const header = document.createElement('div')
    header.className = 'mt-track-header'
    header.innerHTML = `
      <div class="mt-track-controls"></div>
      <div class="mt-track-strip">
        <span class="mt-track-label"></span>
      </div>
      <div class="mt-track-buttons">
        <button type="button" class="mt-track-link-btn scrub-btn" title="Unlink from master"></button>
        <input type="number" class="mt-track-offset-input" step="0.5" value="0" title="Offset from master (s)" />
        <details class="mt-track-menu">
          <summary class="mt-track-menu-btn scrub-btn" title="Choose which graphs to show">☰ graphs</summary>
          <div class="mt-track-menu-popover">
            <div class="mt-track-menu-count"></div>
            ${ALL_PANELS.map(key => `
              <label class="mt-track-menu-item">
                <input type="checkbox" class="mt-track-menu-check" value="${key}" />
                ${PANEL_LABELS[key]}
              </label>
            `).join('')}
          </div>
        </details>
      </div>
    `
    this._controlsEl  = header.querySelector('.mt-track-controls')
    this._labelEl      = header.querySelector('.mt-track-label')
    this._linkBtn      = header.querySelector('.mt-track-link-btn')
    this._offsetInput  = header.querySelector('.mt-track-offset-input')
    this._menuCountEl  = header.querySelector('.mt-track-menu-count')
    this._menuChecks   = [...header.querySelectorAll('.mt-track-menu-check')]

    this._labelEl.textContent = this.label
    this._labelEl.style.color = this.color
    this._buildReplaceControl()
    this._buildRemoveControl()

    this._menuChecks.forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (this.enabledPanels.size >= MAX_PANELS) { cb.checked = false; return }
          this.enabledPanels.add(cb.value)
        } else {
          this.enabledPanels.delete(cb.value)
        }
        this._updateMenu()
        this._applyPanelVisibility()
        // setEnabledPanels lazily creates/frees each panel's canvas context —
        // must run before resize() sizes it, or a freshly-enabled panel's
        // canvas keeps its default backing-buffer resolution (blurry, since
        // CSS still stretches it to the full panel size) until some later,
        // unrelated resize.
        this.display.setEnabledPanels(this.enabledPanels)
        this.resize()
        this._markDirty()
      })
    })
    this._updateMenu()

    this._linkBtn.addEventListener('click', () => {
      this.linked = !this.linked
      if (this.linked) this.ownCursor = 0   // discard the free-scrub position on relink
      this._updateLinkBtn()
      this._markDirty()
    })
    this._updateLinkBtn()

    this._offsetInput.addEventListener('change', () => {
      const v = parseFloat(this._offsetInput.value)
      this.offsetSeconds = Number.isFinite(v) ? v : 0
      this._ribbonDirty = true   // offset changed where this track's data lands on the shared strip
      this._markDirty()
    })

    return header
  }

  /** A small "↑ Replace" button that reloads this track's own store from a
   *  different .jsonl, without touching any other track. */
  _buildReplaceControl() {
    const label = document.createElement('label')
    label.className = 'mt-track-replace-btn controls-upload-btn'
    label.title = 'Replace this track with another recording'
    label.append('↑ Replace')
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.jsonl,application/x-ndjson'
    label.appendChild(input)
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0]
      if (!file) return
      e.target.value = ''
      let text
      try { text = await file.text() } catch (err) { console.error('Recording read failed:', err); return }
      try {
        this.store.loadFromText(text)
      } catch (err) { console.error('Recording parse failed:', err); return }
      this.setLabel(file.name)
      this._ribbonDirty = true
      this.resize()
      this._markDirty()
    })
    this._controlsEl.appendChild(label)
  }

  /** A small "✕" button that removes this track entirely. */
  _buildRemoveControl() {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mt-track-remove-btn controls-upload-btn'
    btn.title = 'Remove this track'
    btn.textContent = '✕'
    btn.addEventListener('click', () => this._onRemove(this))
    this._controlsEl.appendChild(btn)
  }

  /** Right-lane timeline strip: the ribbon/ticks/head row above this track's graphs. */
  _buildTimelineStrip() {
    const strip = document.createElement('div')
    strip.className = 'scrub-timeline mt-track-timeline'
    strip.innerHTML = `
      <div class="scrub-track">
        <div class="scrub-fill"></div>
        <div class="scrub-head"></div>
      </div>
      <canvas class="scrub-ribbon"></canvas>
      <div class="scrub-ticks"></div>
    `
    this._timelineEl   = strip
    this._fillEl       = strip.querySelector('.scrub-fill')
    this._headEl       = strip.querySelector('.scrub-head')
    this._ribbonCanvas = strip.querySelector('.scrub-ribbon')
    this._ticksEl      = strip.querySelector('.scrub-ticks')

    const fracFromEvent = (e) => {
      const rect = this._timelineEl.getBoundingClientRect()
      return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    }
    const seekFromEvent = (e) => {
      const masterDur = this._getMasterDuration()
      const frac = fracFromEvent(e)
      if (this.linked) this._seekMaster(frac * masterDur)
      else this.ownCursor = this.clampTime(frac * masterDur + this.offsetSeconds)
      this._markDirty()
    }
    strip.addEventListener('pointerdown', (e) => {
      this._dragging = true
      strip.setPointerCapture(e.pointerId)
      seekFromEvent(e)
    })
    strip.addEventListener('pointermove', (e) => { if (this._dragging) seekFromEvent(e) })
    const endDrag = (e) => {
      if (!this._dragging) return
      this._dragging = false
      try { strip.releasePointerCapture(e.pointerId) } catch {}
    }
    strip.addEventListener('pointerup', endDrag)
    strip.addEventListener('pointercancel', endDrag)

    return strip
  }

  _updateLinkBtn() {
    this._linkBtn.classList.toggle('active', this.linked)
    this._linkBtn.textContent = this.linked ? '🔗' : '⛓️‍💥'
    this._linkBtn.title = this.linked ? 'Unlink from master' : 'Re-link to master'
  }

  /** Sync menu checkboxes to `enabledPanels`, disabling unchecked ones once the cap is hit. */
  _updateMenu() {
    const atCap = this.enabledPanels.size >= MAX_PANELS
    this._menuChecks.forEach(cb => {
      cb.checked = this.enabledPanels.has(cb.value)
      cb.disabled = atCap && !cb.checked
    })
    this._menuCountEl.textContent = `${this.enabledPanels.size} / ${MAX_PANELS}`
  }

  /** Show/hide each `[data-panel]` section in the lane to match `enabledPanels`. */
  _applyPanelVisibility() {
    for (const key of ALL_PANELS) {
      const section = this.laneEl.querySelector(`[data-panel="${key}"]`)
      if (section) section.hidden = !this.enabledPanels.has(key)
    }
  }

  init() {
    this.display.init()
    this.display.resize()
  }

  resize() {
    this.display.resize()
    this._resizeRibbon()
  }

  _resizeRibbon() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const c = this._ribbonCanvas
    const r = c.getBoundingClientRect()
    if (!r.width || !r.height) return
    const w = Math.max(1, Math.round(r.width * dpr))
    const h = Math.max(1, Math.round(r.height * dpr))
    if (c.width !== w || c.height !== h) {
      c.width = w; c.height = h
      this._ribbonDirty = true
    }
  }

  duration() {
    return this.store.duration()
  }

  /** Clamp a candidate cursor into this track's own valid time range. */
  clampTime(t) {
    return Math.max(0, Math.min(this.duration(), t))
  }

  /** The time this track actually renders at, given the master's cursor. */
  effectiveCursor(masterCursor) {
    return this.linked ? this.clampTime(masterCursor + this.offsetSeconds) : this.ownCursor
  }

  renderAt(masterCursor) {
    this.display.setEnabledPanels(this.enabledPanels)
    this.display.renderAt(this.store, this.effectiveCursor(masterCursor))
  }

  /** Redraw this track's timeline strip (head position + throttled ribbon/ticks). */
  renderTimeline(masterCursor) {
    const masterDur = this._getMasterDuration()
    // This track's cursor, expressed in the strip's shared [0, masterDuration]
    // coordinate frame — the inverse of `effectiveCursor` (see class doc).
    const sharedCursor = this.linked ? masterCursor : this.ownCursor - this.offsetSeconds
    const frac = masterDur > 0 ? Math.max(0, Math.min(1, sharedCursor / masterDur)) : 0
    this._fillEl.style.width = `${(frac * 100).toFixed(2)}%`
    this._headEl.style.left = `${(frac * 100).toFixed(2)}%`
    this._maybeRebuildRibbon(masterDur)
  }

  _maybeRebuildRibbon(masterDur) {
    if (masterDur <= 0) return
    const now = performance.now()
    if (!this._ribbonDirty && masterDur === this._ribbonBuiltFor) return
    if (!this._ribbonDirty && now - this._ribbonLastBuiltAt < RIBBON_REBUILD_MS) return
    this._ribbonDirty = false
    this._ribbonBuiltFor = masterDur
    this._ribbonLastBuiltAt = now
    const geom = { offsetSeconds: this.offsetSeconds, masterDuration: masterDur }
    renderQualityRibbon(this._ribbonCanvas, this.store, this._colors, geom)
    // Global markers (trackIds == null) plus any whose trackIds includes this
    // track's own id — never another track's.
    const markers = this._getMarkers().filter(m => m.trackIds == null || m.trackIds.includes(this.id))
    renderEventTicks(this._ticksEl, this.store, geom, markers, (m) => this._seekToMarker(m))
  }

  /** Jump to a marker's exact time — mirrors the strip's own click-to-seek branching. */
  _seekToMarker(m) {
    if (this.linked) this._seekMaster(m.t)
    else this.ownCursor = this.clampTime(m.t + this.offsetSeconds)
    this._markDirty()
  }

  /** Force this track's ticks to refresh (within the usual throttle) after a marker add/edit/delete. */
  notifyMarkersChanged() {
    this._ribbonDirty = true
  }

  setLabel(text) {
    this.label = text
    if (this._labelEl) this._labelEl.textContent = text
  }

  dispose() {
    this.display.dispose?.()
    this.root?.remove()
  }
}
