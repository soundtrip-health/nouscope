import { WebglLineRoll, createWebGL2Context, setBackgroundColor } from 'webgl-plot'
import { colorVar, colorVars } from './palette'
import {
  TRANSPARENT,
  EEG_SCALE, EEG_AMPLITUDE, EEG_OFFSETS,
  ACCEL_SCALE, GYRO_SCALE,
  MSE_Y_MAX,
  EEG_TOKENS, BAND_TOKENS, IMU_TOKENS, MSE_TOKENS,
  SPEC_START_IDX, SPEC_BINS, SPEC_PX_PER_BIN,
  SPEC_LOG_CAP,
  SPEC_LO_BINS, SPEC_LO_PX_PER_BIN,
  paintSpecColumn, specColumnsScale,
} from './bioRender'

/**
 * AnalysisDisplay — random-access counterpart to BioDataDisplay.
 *
 * Where BioDataDisplay scrolls the newest live samples in from the right, this
 * renderer draws an arbitrary window `[t0, t1]` of a SessionStore on demand:
 * every call to `renderWindow()` clears each canvas and redraws the whole
 * window from stored data. That's what lets the scrubber seek and play.
 *
 * Line plots reuse WebglLineRoll but are fully refreshed each frame: we add
 * exactly the roll's capacity worth of points (min/max-decimated to the display
 * width) so the ring is overwritten left→right across the window. Spectrograms
 * blit stored columns per output pixel, nearest-in-time, so any zoom level works.
 *
 * Canvas IDs are the live ones prefixed with `an-` (see #analysis-panel markup).
 */

const OUT_N = 280   // output columns across each plot (matches canvas width)
const PPG_RAW_SAMPLE_CAP = 20000   // ~5 min at 64 Hz — see `_ppgSignal`

export default class AnalysisDisplay {
  constructor() {
    this._inited = false
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
    this._bandAvgEls  = BAND_NAMES.map(b => document.getElementById(`an-band-avg-${b}`))

    // MSE — 5-line timeseries (one per τ scale)
    this._mseGL = this._ctx('an-mse-canvas')
    this._msePlot = new WebglLineRoll(this._mseGL, OUT_N, 5)
    colorVars(MSE_TOKENS).forEach((c, i) => this._msePlot.setLineColor(c, i))
    this._mseValueEl       = document.getElementById('an-mse-value')
    this._mseAvgEl         = document.getElementById('an-mse-avg')
    this._mseValEls        = [0, 1, 2, 3, 4].map(i => document.getElementById(`an-mse-val-${i}`))
    this._mseScaleAvgEls   = [0, 1, 2, 3, 4].map(i => document.getElementById(`an-mse-avg-${i}`))

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

    // Playhead cursor — one hairline per panel, positioned by x-fraction (see _renderPlayhead)
    this._playheadEls = ['eeg', 'spec', 'spec-lo', 'spec-audio', 'band', 'mse', 'ppg', 'imu']
      .map(id => document.getElementById(`an-${id}-cursor`))
      .filter(Boolean)

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

  /**
   * Match each canvas's drawing buffer to its on-screen size (× devicePixelRatio)
   * so the fullscreen grid isn't upscaling tiny 280-px buffers. Call whenever the
   * panel becomes visible or the window resizes. Line plots draw in clip space so
   * they just need the viewport; 2D spectrograms get more time columns (their
   * bin-natural height stays, CSS + `image-rendering: pixelated` handles vertical).
   */
  resize() {
    if (!this._inited) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    for (const gl of [this._eegGL, this._bandGL, this._mseGL, this._ppgGL, this._imuGL]) {
      const c = gl.canvas
      const r = c.getBoundingClientRect()
      if (!r.width || !r.height) continue
      const w = Math.max(1, Math.round(r.width * dpr))
      const h = Math.max(1, Math.round(r.height * dpr))
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      gl.viewport(0, 0, c.width, c.height)
    }
    for (const ctx of [this._specCtx, this._specLoCtx, this._specAudioCtx]) {
      const c = ctx.canvas
      const r = c.getBoundingClientRect()
      const w = Math.max(1, Math.round(r.width * dpr))
      if (r.width && c.width !== w) c.width = w   // more time columns; clears → repainted next frame
    }
  }

  /**
   * Render the display window [t0, t1] from the store. `cursor` (default t1) is
   * the playhead time used for the scalar readouts — distinct from t1 only in
   * "whole session" mode, where the window spans the entire recording but the
   * readouts still track the playhead. Cheap enough to call every frame.
   */
  renderWindow(store, t0, t1, cursor = t1) {
    if (!this._inited || !store) return
    if (t1 <= t0) t1 = t0 + 0.001

    this._renderEEG(store, t0, t1)
    this._renderPPG(store, t0, t1)
    this._renderIMU(store, t0, t1)
    this._renderBands(store, t0, t1)
    this._renderMse(store, t0, t1)
    this._renderSpec(this._specCtx, store.specColumns('main', t0, t1), t0, t1, SPEC_START_IDX, SPEC_BINS, SPEC_PX_PER_BIN, SPEC_LOG_CAP)
    this._renderSpec(this._specLoCtx, store.specColumns('lo', t0, t1), t0, t1, 0, SPEC_LO_BINS, SPEC_LO_PX_PER_BIN, SPEC_LOG_CAP)
    this._renderAudioSpec(store, t0, t1)
    this._renderReadouts(store, t0, t1, cursor)
    this._renderPlayhead(t0, t1, cursor)
  }

  // ── Playhead cursor ──────────────────────────────────────────────────────

  /**
   * Position the vertical cursor hairline on every panel at the playhead's
   * x-fraction across [t0, t1]. In fixed-window mode `cursor === t1`, so this
   * pins the hairline to the right edge; in "All" mode it marks the actual
   * playhead position within the whole-session window.
   */
  _renderPlayhead(t0, t1, cursor) {
    const span = t1 - t0
    const frac = span > 0 ? Math.max(0, Math.min(1, (cursor - t0) / span)) : 1
    const pct = `${(frac * 100).toFixed(2)}%`
    for (const el of this._playheadEls) el.style.left = pct
  }

  // ── Line plots ────────────────────────────────────────────────────────────

  /**
   * Min/max-decimate `slice` into `outN` buckets → Float32Array of 2*outN raw
   * values (min,max per bucket). NaN samples are skipped; empty buckets → 0.
   */
  _envelope(slice, outN) {
    const M = slice.length
    const out = new Float32Array(outN * 2)
    for (let i = 0; i < outN; i++) {
      const a = Math.floor((i * M) / outN)
      const b = Math.max(a + 1, Math.floor(((i + 1) * M) / outN))
      let mn = Infinity, mx = -Infinity, any = false
      for (let s = a; s < b && s < M; s++) {
        const v = slice[s]
        if (Number.isNaN(v)) continue
        any = true
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      if (!any) { mn = 0; mx = 0 }
      out[i * 2] = mn
      out[i * 2 + 1] = mx
    }
    return out
  }

  // All line plots refresh the whole roll each frame by adding exactly its
  // capacity of points (via the batched addPoints — cheap GL upload), so the
  // ring is overwritten left→right across the window [t0, t1].
  //
  // The roll's vertex shader is `x = a_position.x - uShift`, and addPoints leaves
  // uShift at its pre-batch value. WebglLineRoll starts `dataX` at 1 and advances
  // `shift` by 2 per full-capacity batch, so after the batch the points span
  // [shift-1, shift+1). Subtracting exactly `shift` maps that onto clip space
  // [-1, 1) — the full canvas width. (Subtracting shift-1 shifts everything half a
  // screen right, leaving the left half empty and clipping the newest samples.)
  _drawRoll(plot) {
    plot.gl.uniform1f(plot.uShiftLocation, plot.shift)
    plot.draw()
  }

  _renderEEG(store, t0, t1) {
    // `GriddedStream.envelope` sources from a precomputed min/max mip pyramid once
    // the window is wide enough, so this stays cheap even in "All" mode on a long
    // session — see SessionStore.js for why the naive per-frame raw scan was the
    // main cause of laggy scrubbing at large window sizes.
    const lines = [0, 1, 2, 3].map((ch, i) => {
      const e = store.eeg.envelope(ch, t0, t1, OUT_N)
      const off = EEG_OFFSETS[i]
      for (let j = 0; j < e.length; j++) e[j] = off + (e[j] / EEG_SCALE) * EEG_AMPLITUDE
      return e
    })
    this._eegGL.clear(this._eegGL.COLOR_BUFFER_BIT)
    this._eegPlot.addPoints(lines)
    this._drawRoll(this._eegPlot)
  }

  _renderPPG(store, t0, t1) {
    const { data, fs } = this._ppgSignal(store, t0, t1)
    // Stored PPG is the RAW infrared signal (big DC offset + slow drift), so the
    // pulse is a tiny ripple. Detrend (subtract a ~1 s moving average) to isolate
    // the pulsatile AC, then scale by its robust peak so heartbeats fill the panel.
    const ac = this._detrend(data, Math.max(2, Math.round(fs)))
    const env = this._envelope(ac, OUT_N)
    const scale = this._robustPeak(ac) * 1.3 || 1
    for (let i = 0; i < env.length; i++) env[i] = Math.max(-1, Math.min(1, env[i] / scale))
    this._ppgGL.clear(this._ppgGL.COLOR_BUFFER_BIT)
    this._ppgPlot.addPoints([env])
    this._drawRoll(this._ppgPlot)
  }

  /**
   * Samples to feed the detrend/robust-scale pipeline above. For ordinary
   * windows, the exact raw signal (unchanged behavior). Detrending every raw
   * sample every frame is the same O(window) cost problem the EEG/IMU mip
   * pyramid solves, so above a sample cap — reached only by very wide windows
   * like "All" on a long session — source from a bounded-size min/max-decimated
   * proxy instead. The moving-average detrend just needs to see the same slow
   * DC drift, which a min/max envelope still carries even though it's sparser.
   */
  _ppgSignal(store, t0, t1) {
    const fs = store.ppg.fs
    const n = Math.ceil((t1 - t0) * fs)
    if (n <= PPG_RAW_SAMPLE_CAP) return store.rangePPG(t0, t1)
    const proxyN = Math.floor(PPG_RAW_SAMPLE_CAP / 2)
    const data = store.ppg.envelope(0, t0, t1, proxyN)   // interleaved [min,max] × proxyN
    const proxyFs = (proxyN * 2) / Math.max(1e-6, t1 - t0)
    return { data, fs: proxyFs }
  }

  /** Subtract a centred moving average (window `win` samples), NaN-aware. O(n). */
  _detrend(sig, win) {
    const n = sig.length
    const ps = new Float64Array(n + 1)   // prefix sum of valid values
    const cs = new Int32Array(n + 1)     // prefix count of valid values
    for (let i = 0; i < n; i++) {
      const v = sig[i], ok = !Number.isNaN(v)
      ps[i + 1] = ps[i] + (ok ? v : 0)
      cs[i + 1] = cs[i] + (ok ? 1 : 0)
    }
    const half = win >> 1
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n, i + half + 1)
      const c = cs[b] - cs[a]
      const mean = c ? (ps[b] - ps[a]) / c : 0
      out[i] = Number.isNaN(sig[i]) ? 0 : sig[i] - mean
    }
    return out
  }

  /** ~95th-percentile of |sig| — a peak that ignores occasional motion artifacts. */
  _robustPeak(sig) {
    const abs = []
    for (const v of sig) if (!Number.isNaN(v) && v !== 0) abs.push(Math.abs(v))
    if (!abs.length) return 1
    abs.sort((a, b) => a - b)
    return abs[Math.floor(abs.length * 0.95)] || abs[abs.length - 1]
  }

  _renderIMU(store, t0, t1) {
    const ea = [0, 1, 2].map(c => store.accel.envelope(c, t0, t1, OUT_N))
    const eg = [0, 1, 2].map(c => store.gyro.envelope(c, t0, t1, OUT_N))
    for (let i = 0; i < ea[0].length; i++) {
      ea[0][i] /= ACCEL_SCALE; ea[1][i] /= ACCEL_SCALE; ea[2][i] /= ACCEL_SCALE
      eg[0][i] /= GYRO_SCALE;  eg[1][i] /= GYRO_SCALE;  eg[2][i] /= GYRO_SCALE
    }
    this._imuGL.clear(this._imuGL.COLOR_BUFFER_BIT)
    this._imuPlot.addPoints([ea[0], ea[1], ea[2], eg[0], eg[1], eg[2]])
    this._drawRoll(this._imuPlot)
  }

  _renderBands(store, t0, t1) {
    const BAND_KEYS = ['delta', 'theta', 'alpha', 'beta', 'gamma']
    const lines = [0, 1, 2, 3, 4].map(() => new Float32Array(OUT_N))
    const ymax = store.bandsScale()   // stable session-wide scale (no per-frame jump)
    for (let x = 0; x < OUT_N; x++) {
      const t = t0 + (x / (OUT_N - 1)) * (t1 - t0)
      const rec = store.sampleAt('bands', t)
      for (let b = 0; b < 5; b++) {
        const v = rec ? rec[BAND_KEYS[b]] : 0
        lines[b][x] = (v / ymax) * 2 - 1
      }
    }
    this._bandGL.clear(this._bandGL.COLOR_BUFFER_BIT)
    this._bandPlot.addPoints(lines)
    this._drawRoll(this._bandPlot)
  }

  _renderMse(store, t0, t1) {
    const lines = [0, 1, 2, 3, 4].map(() => new Float32Array(OUT_N))
    for (let x = 0; x < OUT_N; x++) {
      const t = t0 + (x / (OUT_N - 1)) * (t1 - t0)
      const rec = store.sampleAt('mse', t)
      const curve = rec ? rec.curve : null
      for (let i = 0; i < 5; i++) {
        const val = curve && curve[i] != null ? curve[i] : 0
        lines[i][x] = Math.max(-1, Math.min(1, (val / MSE_Y_MAX) * 2 - 1))
      }
    }
    this._mseGL.clear(this._mseGL.COLOR_BUFFER_BIT)
    this._msePlot.addPoints(lines)
    this._drawRoll(this._msePlot)
  }

  // ── Spectrograms ────────────────────────────────────────────────────────────

  /**
   * Blit stored spectrogram columns across the canvas, one column per output
   * pixel (nearest column in time). Auto-scales with the shared robust policy
   * (`specColumnsScale`) so the analysis view matches the live panel; `cap`
   * clamps EEG log-power (SPEC_LOG_CAP) so an artifact column can't wash it out.
   * The whole spectrogram is painted into one ImageData and blitted once.
   */
  _renderSpec(ctx, columns, t0, t1, startIdx, endIdx, pxPerBin, cap = Infinity) {
    const canvas = ctx.canvas
    const W = canvas.width
    const H = (endIdx - startIdx) * pxPerBin
    // Clear to black (gaps / empty window).
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    if (!columns.length) return

    const scale = specColumnsScale(columns, startIdx, endIdx, cap)
    if (!scale) return
    const { lo, range } = scale

    const span = t1 - t0
    const img = ctx.createImageData(W, H)
    for (let x = 0; x < W; x++) {
      const t = t0 + (x / (W - 1)) * span
      const col = this._nearestColumn(columns, t)
      if (!col || Number.isNaN(col[startIdx])) continue
      paintSpecColumn(img, col, { lo, range, H, colWidth: 1, stride: W, x0: x, pxPerBin, startIdx, endIdx })
    }
    ctx.putImageData(img, 0, 0)
  }

  _renderAudioSpec(store, t0, t1) {
    const cols = store.specColumns('audio', t0, t1)
    if (!cols.length) {
      const c = this._specAudioCtx.canvas
      this._specAudioCtx.fillStyle = '#000'
      this._specAudioCtx.fillRect(0, 0, c.width, c.height)
      return
    }
    const bins = cols[0].col.length
    this._renderSpec(this._specAudioCtx, cols, t0, t1, 0, bins, 1)
  }

  /** Column whose time is nearest `t` (columns sorted by t). */
  _nearestColumn(columns, t) {
    let lo = 0, hi = columns.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (columns[mid].t < t) lo = mid + 1
      else hi = mid
    }
    // Compare neighbour for true nearest.
    if (lo > 0 && Math.abs(columns[lo - 1].t - t) < Math.abs(columns[lo].t - t)) lo--
    return columns[lo].col
  }

  // ── Scalar readouts at the playhead ──────────────────────────────────────────

  /**
   * Instant values at the playhead `t`, plus the average over the visible
   * window `[t0, t1]` via `store.windowMean` — the window average is what
   * turns these from a live readout into an actual analysis surface: scrubbing
   * a window tells you "what's typical here", not just "what is it right now".
   */
  _renderReadouts(store, t0, t1, t) {
    const hr = store.sampleAt('hr', t)
    if (this._hrEl) this._hrEl.textContent = hr && hr.bpm > 0 ? `${Math.round(hr.bpm)} bpm` : ''
    const [hrAvg] = store.windowMean(store.hr, t0, t1, [r => (r.bpm > 0 ? r.bpm : NaN)])
    if (this._hrAvgEl) this._hrAvgEl.textContent = hrAvg != null ? `avg ${Math.round(hrAvg)}` : ''

    const bands = store.sampleAt('bands', t)
    const normNames = ['delta', 'theta', 'alpha', 'beta', 'gamma']
    for (let i = 0; i < 5; i++) {
      if (this._bandValEls[i]) this._bandValEls[i].textContent = bands ? bands[normNames[i]].toFixed(2) : '—'
    }
    const bandAvgs = store.windowMean(store.bands, t0, t1, normNames.map(k => r => r[k]))
    for (let i = 0; i < 5; i++) {
      if (this._bandAvgEls[i]) this._bandAvgEls[i].textContent = bandAvgs[i] != null ? bandAvgs[i].toFixed(2) : '—'
    }

    const mse = store.sampleAt('mse', t)
    if (this._mseValueEl) this._mseValueEl.textContent = mse && mse.complexity > 0 ? mse.complexity.toFixed(2) : ''
    for (let i = 0; i < 5; i++) {
      if (this._mseValEls[i]) this._mseValEls[i].textContent = mse && mse.curve[i] != null ? mse.curve[i].toFixed(2) : '—'
    }
    const mseAvgs = store.windowMean(store.mse, t0, t1, [r => r.complexity, ...[0, 1, 2, 3, 4].map(i => r => r.curve[i])])
    if (this._mseAvgEl) this._mseAvgEl.textContent = mseAvgs[0] != null ? `avg ${mseAvgs[0].toFixed(2)}` : ''
    for (let i = 0; i < 5; i++) {
      if (this._mseScaleAvgEls[i]) {
        const v = mseAvgs[i + 1]
        this._mseScaleAvgEls[i].textContent = v != null ? v.toFixed(2) : '—'
      }
    }

    const entrain = store.sampleAt('entrain', t)
    const val = entrain ? entrain.idx : 0
    if (this._entrainFillEl) this._entrainFillEl.style.width = `${(val * 100).toFixed(1)}%`
    if (this._entrainValueEl) this._entrainValueEl.textContent = val > 0.01 ? `${(val * 100).toFixed(0)}%` : ''
    const [entrainAvg] = store.windowMean(store.entrain, t0, t1, [r => r.idx])
    if (this._entrainAvgEl) this._entrainAvgEl.textContent = entrainAvg != null ? `avg ${Math.round(entrainAvg * 100)}%` : ''

    const q = store.qualityAt(t)
    this._qualityDots.forEach((dot, i) => {
      dot.classList.remove('good', 'marginal', 'poor')
      dot.classList.add(q[i] || 'poor')
    })
  }
}
