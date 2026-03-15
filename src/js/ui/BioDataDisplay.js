import { WebglLineRoll, ColorRGBA, createWebGL2Context, setBackgroundColor } from 'webgl-plot'
import App from '../App'

// ── Constants ─────────────────────────────────────────────────────────────────

const EEG_ROLL      = 512   // 2 s at 256 Hz
const EEG_SCALE     = 200   // µV mapped to full per-channel half-height
const EEG_AMPLITUDE = 0.22  // normalized half-height per channel stripe
const EEG_OFFSETS   = [0.75, 0.25, -0.25, -0.75]  // TP9, AF7, AF8, TP10

const BAND_ROLL        = 300   // ~5 s at ~60 fps polling rate
const BAND_YMAX_MIN    = 0.2   // minimum visible Y range (prevents zero-range when all flat)
const BAND_YMAX_DECAY  = 0.999 // per-frame running-max decay (~6% per 100 frames)

const PPG_ROLL = 384  // 6 s at 64 Hz — matches MSPTD analysis window

const IMU_ROLL    = 208    // 4 s at ~52 Hz
const ACCEL_SCALE = 2.0    // ±2 g (Muse full range)
const GYRO_SCALE  = 300    // ±300 dps

// ── Colors (0–255) ────────────────────────────────────────────────────────────

const EEG_COLORS = [
  new ColorRGBA(77,  217, 255, 255),   // TP9  — cyan
  new ColorRGBA(102, 255, 128, 255),   // AF7  — green
  new ColorRGBA(255, 166,  51, 255),   // AF8  — orange
  new ColorRGBA(229, 102, 255, 255),   // TP10 — magenta
]

// delta=violet, theta=blue, alpha=green, beta=amber, gamma=red
const BAND_COLORS = [
  new ColorRGBA(167, 139, 250, 255),  // δ delta  — violet
  new ColorRGBA( 96, 165, 250, 255),  // θ theta  — blue
  new ColorRGBA( 52, 211, 153, 255),  // α alpha  — green
  new ColorRGBA(251, 191,  36, 255),  // β beta   — amber
  new ColorRGBA(248, 113, 113, 255),  // γ gamma  — red
]

const PPG_COLOR = new ColorRGBA(255, 128, 128, 255)  // salmon

const IMU_COLORS = [
  new ColorRGBA( 77, 178, 255, 255),   // ax — blue
  new ColorRGBA( 51, 128, 230, 255),   // ay — darker blue
  new ColorRGBA(128, 210, 255, 255),   // az — lighter blue
  new ColorRGBA(255, 102, 102, 255),   // gx — red
  new ColorRGBA(217,  77,  77, 255),   // gy — darker red
  new ColorRGBA(255, 153, 128, 255),   // gz — lighter red
]

const TRANSPARENT = [0, 0, 0, 0]

// ─────────────────────────────────────────────────────────────────────────────

export default class BioDataDisplay {
  _eegPlot  = null
  _bandPlot = null
  _ppgPlot  = null
  _imuPlot  = null

  _eegGL  = null
  _bandGL = null
  _ppgGL  = null
  _imuGL  = null

  _eegReadIdx = [0, 0, 0, 0]
  _ppgReadIdx = 0
  _imuReadIdx = 0

  _ppgPeak   = 1              // running peak abs value for PPG auto-scale
  _bandYMax  = BAND_YMAX_MIN  // running peak for band auto-scale
  _bandValEls = null          // [δ, θ, α, β, γ] value <span> references

  /**
   * Create WebGL contexts and rolling-line plots for all three canvases.
   * Safe to call while the panel is hidden — canvas dimensions are set via HTML attributes.
   */
  init() {
    // EEG — 4 stacked channels
    const eegCanvas = document.getElementById('eeg-canvas')
    this._eegGL = createWebGL2Context(eegCanvas, { transparent: true })
    setBackgroundColor(this._eegGL, TRANSPARENT)
    this._eegPlot = new WebglLineRoll(this._eegGL, EEG_ROLL, 4)
    EEG_COLORS.forEach((c, i) => this._eegPlot.setLineColor(c, i))

    // EEG band powers — 5 lines (delta, theta, alpha, beta, gamma), polled each frame
    const bandCanvas = document.getElementById('band-canvas')
    this._bandGL = createWebGL2Context(bandCanvas, { transparent: true })
    setBackgroundColor(this._bandGL, TRANSPARENT)
    this._bandPlot = new WebglLineRoll(this._bandGL, BAND_ROLL, 5)
    BAND_COLORS.forEach((c, i) => this._bandPlot.setLineColor(c, i))

    this._bandValEls = ['delta', 'theta', 'alpha', 'beta', 'gamma']
      .map(b => document.getElementById(`band-val-${b}`))

    // PPG — single filtered infrared trace
    const ppgCanvas = document.getElementById('ppg-canvas')
    this._ppgGL = createWebGL2Context(ppgCanvas, { transparent: true })
    setBackgroundColor(this._ppgGL, TRANSPARENT)
    this._ppgPlot = new WebglLineRoll(this._ppgGL, PPG_ROLL, 1)
    this._ppgPlot.setLineColor(PPG_COLOR, 0)

    // IMU — accel (3) + gyro (3) in one plot
    const imuCanvas = document.getElementById('imu-canvas')
    this._imuGL = createWebGL2Context(imuCanvas, { transparent: true })
    setBackgroundColor(this._imuGL, TRANSPARENT)
    this._imuPlot = new WebglLineRoll(this._imuGL, IMU_ROLL, 6)
    IMU_COLORS.forEach((c, i) => this._imuPlot.setLineColor(c, i))

    this.resetIndices()
  }

  /** Reset read pointers to the current sample counts — call on each reconnect. */
  resetIndices() {
    const mgr = App.eegManager
    if (!mgr) return
    this._eegReadIdx = [mgr.eegSampleCount, mgr.eegSampleCount, mgr.eegSampleCount, mgr.eegSampleCount]
    this._ppgReadIdx = mgr.ppgSampleCount
    this._imuReadIdx = mgr.imuSampleCount
    this._ppgPeak  = 1
    this._bandYMax = BAND_YMAX_MIN
  }

  /** Call each animation frame (only when panel is visible). */
  update() {
    const mgr = App.eegManager
    if (!mgr?.isConnected) return
    this._updateEEG(mgr)
    this._updateBands(mgr)
    this._updatePPG(mgr)
    this._updateIMU(mgr)
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _updateEEG(mgr) {
    const chs = mgr.eegChannels
    // available = new samples produced since last read, capped at buffer capacity
    const available = Math.min(mgr.eegSampleCount - this._eegReadIdx[0], chs[0].length)
    if (available <= 0) return

    // The new samples occupy the last `available` slots of each rolling buffer
    const start = chs[0].length - available
    for (let s = 0; s < available; s++) {
      const yVals = EEG_OFFSETS.map((offset, ch) => {
        const v = chs[ch][start + s] ?? 0
        return offset + (v / EEG_SCALE) * EEG_AMPLITUDE
      })
      this._eegPlot.addPoint(yVals)
    }
    this._eegReadIdx = [mgr.eegSampleCount, mgr.eegSampleCount, mgr.eegSampleCount, mgr.eegSampleCount]

    this._eegGL.clear(this._eegGL.COLOR_BUFFER_BIT)
    this._eegPlot.draw()
  }

  _updateBands(mgr) {
    const { delta, theta, alpha, beta, gamma } = mgr.bandPower
    const vals = [delta, theta, alpha, beta, gamma]

    // Auto-scale: running max with slow decay, floored at BAND_YMAX_MIN so the
    // plot always shows at least some vertical range even when all bands are flat.
    const frameMax = Math.max(...vals)
    this._bandYMax = Math.max(this._bandYMax * BAND_YMAX_DECAY, frameMax, BAND_YMAX_MIN)

    // Map [0, _bandYMax] → [-1, +1] for webgl-plot (0 = bottom, peak = top)
    this._bandPlot.addPoint(vals.map(v => v / this._bandYMax * 2 - 1))
    this._bandGL.clear(this._bandGL.COLOR_BUFFER_BIT)
    this._bandPlot.draw()

    // Update per-band text readouts
    if (this._bandValEls) {
      this._bandValEls[0].textContent = delta.toFixed(2)
      this._bandValEls[1].textContent = theta.toFixed(2)
      this._bandValEls[2].textContent = alpha.toFixed(2)
      this._bandValEls[3].textContent = beta.toFixed(2)
      this._bandValEls[4].textContent = gamma.toFixed(2)
    }
  }

  _updatePPG(mgr) {
    const buf = mgr.ppgDisplay
    const available = Math.min(mgr.ppgSampleCount - this._ppgReadIdx, buf.length)
    if (available <= 0) return

    // Update auto-scale from recent peak magnitude
    const recent = buf.slice(-128)
    const peak = Math.max(...recent.map(Math.abs))
    if (peak > 0) this._ppgPeak = peak * 1.2

    const start = buf.length - available
    for (let s = 0; s < available; s++) {
      this._ppgPlot.addPoint([buf[start + s] / this._ppgPeak])
    }
    this._ppgReadIdx = mgr.ppgSampleCount

    this._ppgGL.clear(this._ppgGL.COLOR_BUFFER_BIT)
    this._ppgPlot.draw()
  }

  _updateIMU(mgr) {
    const acc = mgr.accelDisplay
    const gyr = mgr.gyroDisplay
    const available = Math.min(mgr.imuSampleCount - this._imuReadIdx, acc.x.length)
    if (available <= 0) return

    const start = acc.x.length - available
    // Gyro buffer may lag by a sample or two — clamp index to its length
    const gStart = Math.max(0, gyr.x.length - available)
    for (let s = 0; s < available; s++) {
      const gi = Math.min(gStart + s, gyr.x.length - 1)
      this._imuPlot.addPoint([
        (acc.x[start + s] ?? 0) / ACCEL_SCALE,
        (acc.y[start + s] ?? 0) / ACCEL_SCALE,
        (acc.z[start + s] ?? 0) / ACCEL_SCALE,
        (gyr.x[gi] ?? 0) / GYRO_SCALE,
        (gyr.y[gi] ?? 0) / GYRO_SCALE,
        (gyr.z[gi] ?? 0) / GYRO_SCALE,
      ])
    }
    this._imuReadIdx = mgr.imuSampleCount

    this._imuGL.clear(this._imuGL.COLOR_BUFFER_BIT)
    this._imuPlot.draw()
  }
}
