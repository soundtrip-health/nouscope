import { createWebGL2Context, setBackgroundColor, WebglLineRoll } from 'webgl-plot'
import { colorVar, colorVars } from './palette'
import { TRANSPARENT, PANEL_WINDOWS, EEG_TOKENS, BAND_TOKENS, IMU_TOKENS, MSE_TOKENS } from './bioRender'
import RenderPipeline, { OUT_N } from './RenderPipeline'

/**
 * MultiTrackDisplay — the per-track renderer for the Multi-Track tab.
 *
 * Sibling of `AnalysisDisplay` (the original single-session view's renderer),
 * not a replacement for it: this tab is a separate, independent feature for
 * reviewing several loaded `.jsonl` recordings side by side, so it gets its
 * own renderer scoped to a `rootEl` (a cloned `#track-lane-template` instance)
 * rather than the original's page-global `an-*` ids — every lookup below is a
 * class query within that root, since N tracks each need their own set of
 * canvases/readouts. See `Track.js`/`TrackManager.js` for how tracks are
 * assembled, and `App.js`/`AnalysisDisplay.js` for the untouched original.
 *
 * All panel-drawing logic (line plots, spectrograms, readouts) lives in the
 * shared `RenderPipeline` base class — see there. This file only resolves
 * this view's scoped canvas/readout elements and manages each panel's
 * WebGL/2D context lifecycle, since — unlike the single-session view — panels
 * here can be individually enabled/disabled per track via the ☰ graphs menu.
 */
export default class MultiTrackDisplay extends RenderPipeline {
  /**
   * @param {HTMLElement} rootEl — the cloned `#track-lane-template` instance
   *   this display draws into; every canvas/readout is looked up within it.
   * @param {object} [opts]
   * @param {Set<string>|null} [opts.normalizeBands] — which band-legend rows
   *   to show; null shows all (loaded files have no live EEGManager to consult).
   * @param {Set<string>} [opts.enabledPanels] — panels to allocate resources
   *   for up front (see `setEnabledPanels`); defaults to all.
   */
  constructor(rootEl, opts = {}) {
    super()
    this._root = rootEl
    this._normalizeBands = opts.normalizeBands ?? null
    this._inited = false
    this._enabled = new Set(opts.enabledPanels ?? Object.keys(PANEL_WINDOWS))
    this._panelReady = {}
  }

  init() {
    if (this._inited) return

    // Readouts + legend DOM refs — cheap (no GL), always resolved regardless
    // of which graphs are enabled, since the menu can enable them later.
    const BAND_NAMES = ['delta', 'theta', 'alpha', 'beta', 'gamma']
    this._bandItemEls = BAND_NAMES.map(b => this._root.querySelector(`.an-band-item-${b}`))
    this._bandValEls  = BAND_NAMES.map(b => this._root.querySelector(`.an-band-val-${b}`))
    this._mseValueEl  = this._root.querySelector('.an-mse-value')
    this._mseValEls   = [0, 1, 2, 3, 4].map(i => this._root.querySelector(`.an-mse-val-${i}`))
    this._hrEl           = this._root.querySelector('.an-hr')
    this._hrAvgEl        = this._root.querySelector('.an-hr-avg')
    this._entrainValueEl = this._root.querySelector('.an-entrain-value')
    this._entrainAvgEl   = this._root.querySelector('.an-entrain-avg')
    this._entrainFillEl  = this._root.querySelector('.an-entrain-fill')
    this._qualityDots    = this._root.querySelectorAll('.an-quality-dots .quality-dot')

    // Audio-tempogram section — hidden for loaded files (no audio is stored in JSONL).
    this._audioSection = this._root.querySelector('.an-audio-section')

    this._inited = true
    for (const key of this._enabled) this._ensurePanel(key)
  }

  /**
   * Change which panels are drawn. Each panel's WebGL/2D context is created
   * only the first time it's enabled, and freed (GL buffers/program deleted,
   * context explicitly lost) the moment it's disabled — with several tracks
   * on screen at once, leaving every panel's context alive regardless of
   * visibility would risk exceeding the browser's live WebGL context limit
   * (~8–16), so only the panels actually shown may hold one.
   */
  setEnabledPanels(set) {
    const prev = this._enabled
    if (prev.size === set.size && [...prev].every(k => set.has(k))) return
    this._enabled = new Set(set)
    if (!this._inited) return
    for (const key of prev) if (!this._enabled.has(key)) this._disposePanel(key)
    for (const key of this._enabled) if (!prev.has(key)) this._ensurePanel(key)
  }

  _ensurePanel(key) {
    if (this._panelReady[key]) return
    switch (key) {
      case 'eeg':
        this._eegGL = this._ctx('an-eeg-canvas')
        this._eegPlot = new WebglLineRoll(this._eegGL, OUT_N * 2, 4)
        colorVars(EEG_TOKENS).forEach((c, i) => this._eegPlot.setLineColor(c, i))
        break
      case 'bands':
        this._bandGL = this._ctx('an-band-canvas')
        this._bandPlot = new WebglLineRoll(this._bandGL, OUT_N, 5)
        colorVars(BAND_TOKENS).forEach((c, i) => this._bandPlot.setLineColor(c, i))
        break
      case 'mse':
        this._mseGL = this._ctx('an-mse-canvas')
        this._msePlot = new WebglLineRoll(this._mseGL, OUT_N, 5)
        colorVars(MSE_TOKENS).forEach((c, i) => this._msePlot.setLineColor(c, i))
        break
      case 'ppg':
        this._ppgGL = this._ctx('an-ppg-canvas')
        this._ppgPlot = new WebglLineRoll(this._ppgGL, OUT_N * 2, 1)
        this._ppgPlot.setLineColor(colorVar('--ppg'), 0)
        break
      case 'imu':
        this._imuGL = this._ctx('an-imu-canvas')
        this._imuPlot = new WebglLineRoll(this._imuGL, OUT_N * 2, 6)
        colorVars(IMU_TOKENS).forEach((c, i) => this._imuPlot.setLineColor(c, i))
        break
      case 'spec':      this._specCtx      = this._canvas2d('an-spec-canvas'); break
      case 'specLo':    this._specLoCtx    = this._canvas2d('an-spec-lo-canvas'); break
      case 'specAudio': this._specAudioCtx = this._canvas2d('an-spec-audio-canvas'); break
    }
    this._panelReady[key] = true
  }

  _disposePanel(key) {
    if (!this._panelReady[key]) return
    switch (key) {
      case 'eeg':   this._disposeRoll(this._eegPlot);  this._eegGL  = null; this._eegPlot  = null; break
      case 'bands': this._disposeRoll(this._bandPlot); this._bandGL = null; this._bandPlot = null; break
      case 'mse':   this._disposeRoll(this._msePlot);  this._mseGL  = null; this._msePlot  = null; break
      case 'ppg':   this._disposeRoll(this._ppgPlot);  this._ppgGL  = null; this._ppgPlot  = null; break
      case 'imu':   this._disposeRoll(this._imuPlot);  this._imuGL  = null; this._imuPlot  = null; break
      case 'spec':      this._specCtx      = null; break
      case 'specLo':    this._specLoCtx    = null; break
      case 'specAudio': this._specAudioCtx = null; break
    }
    this._panelReady[key] = false
  }

  /**
   * Free a WebglLineRoll's GPU buffers/program and lose its GL context. Once
   * `loseContext()` is called, that `<canvas>` element's context is dead for
   * good — per spec, `canvas.getContext()` on the same node forever returns
   * the same lost context object rather than creating a fresh one, so if this
   * panel is re-enabled later, `_ensurePanel`'s `createWebGL2Context` would
   * silently hand back a context that can never compile a shader again (the
   * roll would construct against a context stuck in the lost state, so
   * nothing ever draws — the panel just goes blank). Swap in a fresh,
   * contextless clone of the canvas so a later `_ensurePanel()` gets a
   * genuinely new context.
   */
  _disposeRoll(plot) {
    if (!plot) return
    const canvas = plot.gl.canvas
    plot.gl.deleteBuffer(plot.vertexBuffer)
    plot.gl.deleteBuffer(plot.colorBuffer)
    plot.gl.deleteProgram(plot.program)
    plot.gl.getExtension('WEBGL_lose_context')?.loseContext()
    canvas.replaceWith(canvas.cloneNode(true))
  }

  /** Release every currently-held panel resource — call when a track is removed. */
  dispose() {
    for (const key of Object.keys(this._panelReady)) this._disposePanel(key)
    this._specImgCache.clear()
  }

  _ctx(cls) {
    const gl = createWebGL2Context(this._root.querySelector(`.${cls}`), { transparent: true })
    setBackgroundColor(gl, TRANSPARENT)
    return gl
  }

  _canvas2d(cls) {
    const c = this._root.querySelector(`.${cls}`)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, c.width, c.height)
    return ctx
  }

  _activeBands() {
    return this._normalizeBands
  }
}
