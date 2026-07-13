import { WebglLineRoll, createWebGL2Context, setBackgroundColor } from 'webgl-plot'
import { colorVar, colorVars } from './palette'
import {
  TRANSPARENT,
  EEG_SCALE, EEG_AMPLITUDE, EEG_OFFSETS,
  ACCEL_SCALE, GYRO_SCALE,
  MSE_Y_MAX,
  PANEL_WINDOWS, BAND_SMOOTH_TAU,
  EEG_TOKENS, BAND_TOKENS, IMU_TOKENS, MSE_TOKENS,
  SPEC_START_IDX, SPEC_BINS, SPEC_PX_PER_BIN,
  SPEC_LOG_CAP,
  SPEC_LO_BINS, SPEC_LO_PX_PER_BIN,
  paintSpecColumn, specColumnsScale,
  paintNoAudioPlaceholder,
} from './bioRender'

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
 * It renders every panel from a `SessionStore` at an arbitrary playhead time
 * — the same seekable-by-construction approach the original view uses. Each
 * panel draws its own fixed-width window ending at the playhead — see
 * `PANEL_WINDOWS` in bioRender for why the windows differ per panel. Every
 * call to `renderAt()` clears each canvas and redraws it from scratch.
 *
 * Line plots reuse WebglLineRoll but are fully refreshed each frame: we add
 * exactly the roll's capacity worth of points (min/max-decimated to the display
 * width) so the ring is overwritten left→right across the window. Spectrograms
 * blit stored columns per output pixel, nearest-in-time.
 */

const OUT_N = 280   // output columns across each plot (matches canvas width)
const PPG_RAW_SAMPLE_CAP = 20000   // ~5 min at 64 Hz — see `_ppgSignal`

// WebglLineRoll's `shift`/`dataX` uniforms grow every frame for the life of the
// instance and are never reset by the library — after several minutes of
// continuous 60fps redraws they reach a magnitude where float32 (both the GPU
// vertex math and the JS-side buffer) can no longer resolve the roll's own
// per-point step, and the trace visibly quantizes into a blocky staircase.
// Since every frame already fully repopulates each roll's visible window from
// the store (see the class doc above), recreating the roll well before that
// point is free of any state loss — the next frame just re-uploads the same
// window into a clean instance.
const ROLL_SHIFT_LIMIT = 20000

// A stored spectrogram column is painted at an output pixel only if it lies
// within this many column-spacings of that pixel's time. Without the guard,
// `_nearestColumn` happily smears the single oldest column across the entire
// empty stretch of a window that reaches back before the session began.
const SPEC_NEAREST_TOLERANCE = 1.5

export default class MultiTrackDisplay {
  /**
   * @param {HTMLElement} rootEl — the cloned `#track-lane-template` instance
   *   this display draws into; every canvas/readout is looked up within it.
   * @param {object} [opts]
   * @param {Set<string>|null} [opts.normalizeBands] — which band-legend rows
   *   to show; null shows all (loaded files have no live EEGManager to consult).
   * @param {Set<string>} [opts.enabledPanels] — panels to allocate resources
   *   for up front (see `setEnabledPanels`); defaults to all 8.
   */
  constructor(rootEl, opts = {}) {
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

  /** Free a WebglLineRoll's GPU buffers/program and lose its GL context. */
  _disposeRoll(plot) {
    if (!plot) return
    plot.gl.deleteBuffer(plot.vertexBuffer)
    plot.gl.deleteBuffer(plot.colorBuffer)
    plot.gl.deleteProgram(plot.program)
    plot.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  /** Release every currently-held panel resource — call when a track is removed. */
  dispose() {
    for (const key of Object.keys(this._panelReady)) this._disposePanel(key)
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
      if (!gl) continue   // panel disabled — no context to size
      const c = gl.canvas
      const r = c.getBoundingClientRect()
      if (!r.width || !r.height) continue
      const w = Math.max(1, Math.round(r.width * dpr))
      const h = Math.max(1, Math.round(r.height * dpr))
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      gl.viewport(0, 0, c.width, c.height)
    }
    for (const ctx of [this._specCtx, this._specLoCtx, this._specAudioCtx]) {
      if (!ctx) continue
      const c = ctx.canvas
      const r = c.getBoundingClientRect()
      const w = Math.max(1, Math.round(r.width * dpr))
      if (r.width && c.width !== w) c.width = w   // more time columns; clears → repainted next frame
    }
  }

  /**
   * Redraw every panel with its own window ending at the playhead `cursor`
   * (seconds). Cheap enough to call every frame.
   */
  renderAt(store, cursor) {
    if (!this._inited || !store) return

    // Audio tempogram is unavailable for loaded files (no audio stored in JSONL);
    // combine that with the panel-menu's own enabled/disabled state — either
    // reason hides the section so it doesn't read as a broken/missing panel.
    if (this._audioSection) {
      const noAudio = store.specAudio.length === 0
      this._audioSection.hidden = !this._enabled.has('specAudio') || (store.source === 'file' && noAudio)
    }

    const w = (panel) => [cursor - PANEL_WINDOWS[panel], cursor]

    if (this._enabled.has('eeg'))   this._renderEEG(store, ...w('eeg'))
    if (this._enabled.has('ppg'))   this._renderPPG(store, ...w('ppg'))
    if (this._enabled.has('imu'))   this._renderIMU(store, ...w('imu'))
    if (this._enabled.has('bands')) this._renderBands(store, ...w('bands'))
    if (this._enabled.has('mse'))   this._renderMse(store, ...w('mse'))

    if (this._enabled.has('spec')) {
      const [st0, st1] = w('spec')
      this._renderSpec(this._specCtx, store.specColumns('main', st0, st1), st0, st1, SPEC_START_IDX, SPEC_BINS, SPEC_PX_PER_BIN, SPEC_LOG_CAP)
    }
    if (this._enabled.has('specLo')) {
      const [lt0, lt1] = w('specLo')
      this._renderSpec(this._specLoCtx, store.specColumns('lo', lt0, lt1), lt0, lt1, 0, SPEC_LO_BINS, SPEC_LO_PX_PER_BIN, SPEC_LOG_CAP)
    }
    if (this._enabled.has('specAudio')) this._renderAudioSpec(store, ...w('specAudio'))

    this._renderReadouts(store, cursor)
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

  /**
   * Recreate a roll once its accumulated shift risks float32 precision loss —
   * see `ROLL_SHIFT_LIMIT`. WebglLineRoll exposes no dispose(), so its vertex/
   * color buffers and program are freed by hand first; otherwise every cycle
   * would leak a full roll's worth of GPU buffers for as long as the tab stays
   * open. (Its two shader objects stay unreachable-but-undeleted regardless —
   * the library never stores their handles — but those are a few bytes of
   * compiled bytecode each, not the growing buffers this guards against.)
   */
  _recycleRoll(plot, rebuild) {
    if (plot.shift <= ROLL_SHIFT_LIMIT) return plot
    plot.gl.deleteBuffer(plot.vertexBuffer)
    plot.gl.deleteBuffer(plot.colorBuffer)
    plot.gl.deleteProgram(plot.program)
    return rebuild()
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
    this._eegPlot = this._recycleRoll(this._eegPlot, () => {
      const p = new WebglLineRoll(this._eegGL, OUT_N * 2, 4)
      colorVars(EEG_TOKENS).forEach((c, i) => p.setLineColor(c, i))
      return p
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
    this._ppgPlot = this._recycleRoll(this._ppgPlot, () => {
      const p = new WebglLineRoll(this._ppgGL, OUT_N * 2, 1)
      p.setLineColor(colorVar('--ppg'), 0)
      return p
    })
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
    this._imuPlot = this._recycleRoll(this._imuPlot, () => {
      const p = new WebglLineRoll(this._imuGL, OUT_N * 2, 6)
      colorVars(IMU_TOKENS).forEach((c, i) => p.setLineColor(c, i))
      return p
    })
    this._imuGL.clear(this._imuGL.COLOR_BUFFER_BIT)
    this._imuPlot.addPoints([ea[0], ea[1], ea[2], eg[0], eg[1], eg[2]])
    this._drawRoll(this._imuPlot)
  }

  /**
   * Band powers are produced at ~2 Hz, so resampling them onto ~280 pixels of a
   * 5 s window gives a coarse staircase. The live panel hid that behind a
   * per-frame lerp; reproduce it here as a one-pole low-pass across pixels with
   * the same time constant, seeded at the first sample so the curve doesn't ramp
   * in from zero at the left edge.
   */
  _renderBands(store, t0, t1) {
    const BAND_KEYS = ['delta', 'theta', 'alpha', 'beta', 'gamma']
    const lastT = store.lastT('bands')
    if (lastT != null && lastT < t1) { const span = t1 - t0; t1 = lastT; t0 = t1 - span }
    const lines = [0, 1, 2, 3, 4].map(() => new Float32Array(OUT_N))
    const ymax = store.bandsScale()   // stable session-wide scale (no per-frame jump)

    const dt = (t1 - t0) / (OUT_N - 1)
    const alpha = 1 - Math.exp(-dt / BAND_SMOOTH_TAU)
    const smoothed = new Float64Array(5)
    let seeded = false

    for (let x = 0; x < OUT_N; x++) {
      const rec = store.sampleAt('bands', t0 + x * dt)
      for (let b = 0; b < 5; b++) {
        const v = rec ? rec[BAND_KEYS[b]] : 0
        smoothed[b] = seeded ? smoothed[b] + alpha * (v - smoothed[b]) : v
        lines[b][x] = (smoothed[b] / ymax) * 2 - 1
      }
      seeded = true
    }
    this._bandPlot = this._recycleRoll(this._bandPlot, () => {
      const p = new WebglLineRoll(this._bandGL, OUT_N, 5)
      colorVars(BAND_TOKENS).forEach((c, i) => p.setLineColor(c, i))
      return p
    })
    this._bandGL.clear(this._bandGL.COLOR_BUFFER_BIT)
    this._bandPlot.addPoints(lines)
    this._drawRoll(this._bandPlot)
  }

  _renderMse(store, t0, t1) {
    const lastT = store.lastT('mse')
    if (lastT != null && lastT < t1) { const span = t1 - t0; t1 = lastT; t0 = t1 - span }
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
    this._msePlot = this._recycleRoll(this._msePlot, () => {
      const p = new WebglLineRoll(this._mseGL, OUT_N, 5)
      colorVars(MSE_TOKENS).forEach((c, i) => p.setLineColor(c, i))
      return p
    })
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
    if (W < 2) return   // need at least 2 columns for a meaningful mapping

    // How far a stored column may sit from an output pixel's time and still be
    // painted there: a multiple of the columns' own spacing, so pixels that fall
    // outside the recorded stretch of this window stay black.
    const spacing = columns.length > 1
      ? (columns[columns.length - 1].t - columns[0].t) / (columns.length - 1)
      : span
    const tol = Math.max(spacing, span / W) * SPEC_NEAREST_TOLERANCE

    for (let x = 0; x < W; x++) {
      const t = t0 + (x / (W - 1)) * span
      const col = this._nearestColumn(columns, t, tol)
      if (!col || Number.isNaN(col[startIdx])) continue
      paintSpecColumn(img, col, { lo, range, H, colWidth: 1, stride: W, x0: x, pxPerBin, startIdx, endIdx })
    }
    ctx.putImageData(img, 0, 0)
  }

  _renderAudioSpec(store, t0, t1) {
    const cols = store.specColumns('audio', t0, t1)
    if (!cols.length) {
      paintNoAudioPlaceholder(this._specAudioCtx)
      return
    }
    const bins = cols[0].col.length
    this._renderSpec(this._specAudioCtx, cols, t0, t1, 0, bins, 1)
  }

  /** Column whose time is nearest `t` (columns sorted by t), or null if none within `tol`. */
  _nearestColumn(columns, t, tol) {
    let lo = 0, hi = columns.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (columns[mid].t < t) lo = mid + 1
      else hi = mid
    }
    // Compare neighbour for true nearest.
    if (lo > 0 && Math.abs(columns[lo - 1].t - t) < Math.abs(columns[lo].t - t)) lo--
    return Math.abs(columns[lo].t - t) <= tol ? columns[lo].col : null
  }

  // ── Scalar readouts at the playhead ──────────────────────────────────────────

  /**
   * Instant values at the playhead `t`. HR and entrainment also show a window
   * average over the same span their panel draws ("what's typical over the
   * stretch you're looking at", not just "what is it right now"). Bands and MSE
   * don't: both series are produced from real EEG sample arrival rather than a
   * wall-clock timer (see the tail clamp in `_renderBands`/`_renderMse`), so
   * their average — computed from the raw unclamped window — increasingly
   * averaged over fewer real samples than the window claimed the longer a live
   * session ran, eventually going empty; not worth carrying the same clamp into
   * a second query path for a number that's secondary to the trace itself.
   */
  _renderReadouts(store, t) {
    const win = (panel) => [t - PANEL_WINDOWS[panel], t]

    const hr = store.sampleAt('hr', t)
    if (this._hrEl) this._hrEl.textContent = hr && hr.bpm > 0 ? `${Math.round(hr.bpm)} bpm` : ''
    const [hrAvg] = store.windowMean(store.hr, ...win('ppg'), [r => (r.bpm > 0 ? r.bpm : NaN)])
    if (this._hrAvgEl) this._hrAvgEl.textContent = hrAvg != null ? `avg ${Math.round(hrAvg)}` : ''

    // Only bands that participate in the relative-power normalisation carry a
    // meaningful value; the rest are zeroed at the source (delta, by default).
    // Show a legend row only for the ones that mean something.
    const bands = store.sampleAt('bands', t)
    const normNames = ['delta', 'theta', 'alpha', 'beta', 'gamma']
    const active = this._normalizeBands
    for (let i = 0; i < 5; i++) {
      const shown = !active || active.has(normNames[i])
      if (this._bandItemEls[i]) this._bandItemEls[i].style.display = shown ? '' : 'none'
      if (!shown) continue
      if (this._bandValEls[i]) this._bandValEls[i].textContent = bands ? bands[normNames[i]].toFixed(2) : '—'
    }

    const mse = store.sampleAt('mse', t)
    if (this._mseValueEl) this._mseValueEl.textContent = mse && mse.complexity > 0 ? mse.complexity.toFixed(2) : ''
    for (let i = 0; i < 5; i++) {
      if (this._mseValEls[i]) this._mseValEls[i].textContent = mse && mse.curve[i] != null ? mse.curve[i].toFixed(2) : '—'
    }

    const entrain = store.sampleAt('entrain', t)
    const val = entrain ? entrain.idx : 0
    if (this._entrainFillEl) this._entrainFillEl.style.width = `${(val * 100).toFixed(1)}%`
    if (this._entrainValueEl) this._entrainValueEl.textContent = val > 0.01 ? `${(val * 100).toFixed(0)}%` : ''
    const [entrainAvg] = store.windowMean(store.entrain, ...win('specAudio'), [r => r.idx])
    if (this._entrainAvgEl) this._entrainAvgEl.textContent = entrainAvg != null ? `avg ${Math.round(entrainAvg * 100)}%` : ''

    const q = store.qualityAt(t)
    this._qualityDots.forEach((dot, i) => {
      dot.classList.remove('good', 'marginal', 'poor')
      dot.classList.add(q[i] || 'poor')
    })
  }
}
