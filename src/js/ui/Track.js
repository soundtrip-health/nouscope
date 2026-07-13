import AnalysisDisplay from './AnalysisDisplay'
import { renderQualityRibbon, renderEventTicks } from './timelineDecor'
import { cssVar } from './palette'

/** All panel keys a track can show/hide — see `PANEL_WINDOWS` in bioRender. */
export const ALL_PANELS = ['eeg', 'spec', 'specLo', 'specAudio', 'bands', 'mse', 'ppg', 'imu']

const PANEL_LABELS = {
  eeg: 'EEG', spec: 'Spectrogram', specLo: 'Delta / Theta', specAudio: 'Audio Tempo',
  bands: 'EEG Bands', mse: 'Complexity (MSE)', ppg: 'PPG', imu: 'IMU',
}

// Hard cap enforced by the graph-select menu — each enabled line-plot panel
// (all but the 3 spectrograms) holds its own WebGL context, and a handful of
// tracks each showing every panel would blow past the browser's live-context
// limit (~8–16). Capping per track keeps the total bounded regardless of how
// many tracks are on screen.
const MAX_PANELS = 4
const LIVE_DEFAULT_PANELS = ['eeg', 'bands', 'spec', 'ppg']
const FILE_DEFAULT_PANELS = ['eeg', 'bands', 'spec']

// Throttle: re-sample the quality ribbon/ticks at most this often while a live
// session grows — see the identical guard the single-session Scrubber used to
// have (now per-track, since each track's store grows independently).
const RIBBON_REBUILD_MS = 1000

/**
 * Track — one session lane in the multi-track review view: a `SessionStore`
 * plus the `AnalysisDisplay` that draws it, plus its own header (label, live
 * connect/record controls or a file-replace button, link/offset, graph menu)
 * and timeline strip (quality ribbon + event ticks), all wrapped in one root.
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
   * @param {'live'|'file'} opts.kind
   * @param {import('../managers/SessionStore').default} opts.store
   * @param {HTMLElement} opts.laneEl — the cloned track-lane-template root, passed to AnalysisDisplay
   * @param {string} [opts.label]
   * @param {Set<string>|null} [opts.normalizeBands]
   * @param {() => number} opts.getMasterDuration
   * @param {(t: number) => void} opts.seekMaster
   * @param {() => void} opts.markDirty — force the master scrubber to redraw
   *   next frame even though the master cursor itself didn't move (needed
   *   whenever this track's own `ownCursor`/`offsetSeconds`/`linked` changes,
   *   since `renderTimeline`/`renderAt` only run as part of its render loop).
   */
  constructor({ id, kind, store, laneEl, label = '', normalizeBands = null, getMasterDuration, seekMaster, markDirty }) {
    this.id = id
    this.kind = kind
    this.store = store
    this.label = label
    this.laneEl = laneEl
    this.root = null   // the `.track` wrapper — set by TrackManager once mounted

    this.linked = true
    this.offsetSeconds = 0
    this.ownCursor = 0
    this.enabledPanels = new Set(kind === 'live' ? LIVE_DEFAULT_PANELS : FILE_DEFAULT_PANELS)

    this._getMasterDuration = getMasterDuration
    this._seekMaster = seekMaster
    this._markDirty = markDirty ?? (() => {})
    this._dragging = false

    this._colors = {
      good: cssVar('--status-good'),
      marginal: cssVar('--status-marginal'),
      poor: cssVar('--status-poor'),
    }
    this._ribbonDirty = true
    this._ribbonBuiltFor = -1
    this._ribbonLastBuiltAt = 0

    this.display = new AnalysisDisplay(laneEl, { normalizeBands, enabledPanels: this.enabledPanels })
    this.headerEl = this._buildHeader()
    this.timelineStripEl = this._buildTimelineStrip()
    this._applyPanelVisibility()
  }

  /** Left header column: controls (kind-specific) + label + link/offset/menu. */
  _buildHeader() {
    const header = document.createElement('div')
    header.className = 'track-header'
    header.innerHTML = `
      <div class="track-controls"></div>
      <div class="track-strip">
        <span class="track-label"></span>
        <button type="button" class="track-link-btn scrub-btn" title="Unlink from master"></button>
        <input type="number" class="track-offset-input" step="0.5" value="0" title="Offset from master (s)" />
        <details class="track-menu">
          <summary class="track-menu-btn scrub-btn" title="Choose which graphs to show">☰ graphs</summary>
          <div class="track-menu-popover">
            <div class="track-menu-count"></div>
            ${ALL_PANELS.map(key => `
              <label class="track-menu-item">
                <input type="checkbox" class="track-menu-check" value="${key}" />
                ${PANEL_LABELS[key]}
              </label>
            `).join('')}
          </div>
        </details>
      </div>
    `
    this._controlsEl  = header.querySelector('.track-controls')
    this._labelEl      = header.querySelector('.track-label')
    this._linkBtn      = header.querySelector('.track-link-btn')
    this._offsetInput  = header.querySelector('.track-offset-input')
    this._menuCountEl  = header.querySelector('.track-menu-count')
    this._menuChecks   = [...header.querySelectorAll('.track-menu-check')]

    this._labelEl.textContent = this.label
    this._buildControls()

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

  /**
   * Kind-specific controls, appended into `.track-controls`:
   * - live: clones `#track-live-controls-template` (connect/battery/record/
   *   pause/mic/audio-upload) — `this.controlsEl` exposes that clone so App
   *   can wire the EEG/audio pipeline into it (see App._wireLiveControls).
   * - file: a small "↑ Replace" button that reloads this track's own store
   *   from a different .jsonl, without touching any other track.
   */
  _buildControls() {
    if (this.kind === 'live') {
      const template = document.getElementById('track-live-controls-template')
      const clone = template.content.firstElementChild.cloneNode(true)
      this._controlsEl.appendChild(clone)
      this.controlsEl = clone
      return
    }

    const label = document.createElement('label')
    label.className = 'track-replace-btn controls-upload-btn'
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

  /** Right-lane timeline strip: the ribbon/ticks/head row above this track's graphs. */
  _buildTimelineStrip() {
    const strip = document.createElement('div')
    strip.className = 'scrub-timeline track-timeline'
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
    this.display.setEnabledPanels?.(this.enabledPanels)
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
    renderEventTicks(this._ticksEl, this.store, geom)
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
