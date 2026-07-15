import { WebglLineRoll, createWebGL2Context, setBackgroundColor } from 'webgl-plot'
import App from '../App'
import { colorVar, colorVars } from './palette'
import { TRANSPARENT, EEG_TOKENS, BAND_TOKENS, IMU_TOKENS, MSE_TOKENS } from './bioRender'
import RenderPipeline, { OUT_N } from './RenderPipeline'

/**
 * AnalysisDisplay — the app's only data view.
 *
 * It renders every panel from a `SessionStore` at an arbitrary playhead time,
 * rather than from a manager's live ring buffers. That single fact is what makes
 * the view seekable: with the playhead pinned to the leading edge it *is* the
 * live view, and dragging the playhead anywhere else replays the same panels
 * over stored data, live session or loaded file alike.
 *
 * All panel-drawing logic (line plots, spectrograms, readouts) lives in the
 * shared `RenderPipeline` base class — see there. This file only resolves
 * this view's page-global `an-*` canvas/readout ids and always keeps every
 * panel enabled (there is no panel-select menu here — see `MultiTrackDisplay`
 * for the sibling that toggles panels per track).
 */
export default class AnalysisDisplay extends RenderPipeline {
  constructor() {
    super()
    this._inited = false
    this._enabled = new Set(['eeg', 'spec', 'specLo', 'specAudio', 'bands', 'mse', 'ppg', 'imu'])
  }

  init() {
    if (this._inited) return

    // EEG — 4 stacked channels, min/max envelope → 2 points per column
    this._eegGL = this._ctx('an-eeg-canvas')
    this._eegPlot = new WebglLineRoll(this._eegGL, OUT_N * 2, 4)
    colorVars(EEG_TOKENS).forEach((c, i) => this._eegPlot.setLineColor(c, i))

    // Spectrograms (2D canvases)
    this._specCtx      = this._canvas2d('an-spec-canvas')
    this._specLoCtx    = this._canvas2d('an-spec-lo-canvas')
    this._specAudioCtx = this._canvas2d('an-spec-audio-canvas')

    // EEG band powers — 5 lines, one value per column (step/hold from records)
    this._bandGL = this._ctx('an-band-canvas')
    this._bandPlot = new WebglLineRoll(this._bandGL, OUT_N, 5)
    colorVars(BAND_TOKENS).forEach((c, i) => this._bandPlot.setLineColor(c, i))
    const BAND_NAMES = ['delta', 'theta', 'alpha', 'beta', 'gamma']
    this._bandItemEls = BAND_NAMES.map(b => document.getElementById(`an-band-item-${b}`))
    this._bandValEls  = BAND_NAMES.map(b => document.getElementById(`an-band-val-${b}`))

    // MSE — 5-line timeseries (one per τ scale)
    this._mseGL = this._ctx('an-mse-canvas')
    this._msePlot = new WebglLineRoll(this._mseGL, OUT_N, 5)
    colorVars(MSE_TOKENS).forEach((c, i) => this._msePlot.setLineColor(c, i))
    this._mseValueEl       = document.getElementById('an-mse-value')
    this._mseValEls        = [0, 1, 2, 3, 4].map(i => document.getElementById(`an-mse-val-${i}`))

    // PPG — single trace, min/max envelope
    this._ppgGL = this._ctx('an-ppg-canvas')
    this._ppgPlot = new WebglLineRoll(this._ppgGL, OUT_N * 2, 1)
    this._ppgPlot.setLineColor(colorVar('--ppg'), 0)

    // IMU — accel (3) + gyro (3)
    this._imuGL = this._ctx('an-imu-canvas')
    this._imuPlot = new WebglLineRoll(this._imuGL, OUT_N * 2, 6)
    colorVars(IMU_TOKENS).forEach((c, i) => this._imuPlot.setLineColor(c, i))

    // Readouts
    this._hrEl           = document.getElementById('an-hr')
    this._hrAvgEl        = document.getElementById('an-hr-avg')
    this._entrainValueEl = document.getElementById('an-entrain-value')
    this._entrainAvgEl   = document.getElementById('an-entrain-avg')
    this._entrainFillEl  = document.getElementById('an-entrain-fill')
    this._qualityDots    = document.querySelectorAll('#an-quality-dots .quality-dot')

    // Audio-tempogram section — hidden for loaded files (no audio is stored in JSONL).
    this._audioSection = document.getElementById('an-audio-section')

    this._inited = true
  }

  _ctx(id) {
    const gl = createWebGL2Context(document.getElementById(id), { transparent: true })
    setBackgroundColor(gl, TRANSPARENT)
    return gl
  }

  _canvas2d(id) {
    const c = document.getElementById(id)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, c.width, c.height)
    return ctx
  }

  _activeBands() {
    return App.eegManager?.normalizeBands
  }
}
