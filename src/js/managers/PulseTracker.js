/**
 * PulseTracker — beat-locked heartbeat phase from the stored PPG + accelerometer.
 *
 * A lightweight, closed-form take on *Physically-Constrained Harmonic
 * Separation* (Fraihi, Karrakchou & Ghogho, arXiv:2606.30156): the PPG window
 * is modelled analysis-by-synthesis as a quasi-periodic cardiac component —
 * a fundamental f0 ∈ [F_MIN, F_MAX] Hz with K harmonics — plus a motion
 * residual that the accelerometer *conditions* (lagged accel regressors fitted
 * jointly with the harmonics, so the two explain disjoint parts of the
 * signal) plus a slow baseline. The paper learns the conditioning with a CNN
 * and FiLM; here it is a linear ridge regression, which keeps the whole fit
 * to a few milliseconds of plain JS and needs no training. What is kept from
 * the paper: the harmonic generator (f0, A_k, K=3), the 8 s window, the
 * accelerometer as artifact conditioner rather than vital-sign regressor,
 * joint (orthogonal) separation, and a per-window reliability weight that
 * gates how much a fit is trusted (here: how far a slot may pull the phase
 * away from the last confident fit's prediction, and how bright the pulse is).
 *
 * Output is a **phase**, not a rate: `at(t)` returns the cardiac phase at any
 * session time (0 ≡ systolic peak), the instantaneous rate, and the fit
 * reliability. Fits live on a HOP_S grid and are cached per slot; the phase
 * between two slots is a cubic Hermite spline whose end values are the two
 * fitted phases (unwrapped nearest to the rate prediction) and whose end
 * slopes are the two fitted rates — C¹ smooth and locked to the observed
 * beats, rather than a free-running oscillator that drifts off them.
 *
 * Every result is a pure function of the stored streams at absolute times,
 * so it is scrub-correct: following ● LIVE, dragged back, or on a loaded
 * `.jsonl` file the same t always yields the same phase. Slots are fitted
 * lazily (only the ones a query touches), so seeking anywhere costs at most
 * a handful of fits.
 *
 * See `docs/algorithms.md` §4b.
 */

const PPG_FS   = 64
const IMU_FS   = 52
const FIT_FS   = 32                     // PPG decimated 2:1 for the fit
const DECIM    = PPG_FS / FIT_FS

export const HOP_S     = 1              // fit grid spacing (s)
const WIN_S            = 8              // analysis window (s)
const MIN_WIN_S        = 4              // shortest window accepted at session start
const F_MIN            = 0.5            // Hz (30 bpm)
const F_MAX            = 3.0            // Hz (180 bpm)
const F_COARSE         = 0.02           // Hz, first search grid
const F_FINE           = 0.002          // Hz, refinement grid
const F_FINE_SPAN      = 0.03           // Hz, ± span of the refinement grid
const K                = 3              // harmonics in the cardiac model
const BASELINE_HALF    = 24             // samples @32 Hz: ±0.75 s moving-average baseline
const ACC_LAGS         = [-4, -2, 0, 2, 4]   // samples @32 Hz (±125 ms)
const ACC_CHANNELS     = 4              // x, y, z, |a|
const RIDGE            = 0.02           // ridge on motion regressors, × N
const RAMP_W0          = 0.25           // LS row weight at window start (1 at the end)
const PHASE_WIN_S      = 3              // end-phase refinement: re-fit the harmonics (f0 fixed) over the last 3 s
const MAX_NAN_FRAC     = 0.25           // more missing PPG than this → no fit
const MIN_ACC_FRAC     = 0.75           // less accel coverage than this → no motion model
const MOTION_PENALTY   = 0.3            // share of motion power counted against reliability
// Soft phase lock: a slot at/above W_ANCHOR uses its own fitted phase outright
// and anchors the slots after it; below that, the slot's phase is the last
// anchor's phase integrated forward at the anchor's rate, corrected toward
// the slot's own fit by a gain that ramps from 0 at W_FLOOR to 1 at W_ANCHOR
// (a confidence-weighted phase-locked loop, rather than a hard threshold that
// would flip between two disagreeing phase bases as reliability wavers).
export const W_ANCHOR  = 0.5
export const W_FLOOR   = 0.2
const LOOKBACK         = 6              // slots to search back for an anchor
const EDGE_LOOKBACK    = 3              // slots the newest fit may lag the cursor
const PPG_SIGN         = 1              // +1: raw infrared rises at systole (matches MSPTD's peak convention)

const TWO_PI = 2 * Math.PI

function wrap2pi(x) {
  x %= TWO_PI
  return x < 0 ? x + TWO_PI : x
}

/** Wrap to (−π, π]. */
function wrapPi(x) {
  x = wrap2pi(x)
  return x > Math.PI ? x - TWO_PI : x
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Solve A·x = b for symmetric positive-definite A (n×n, row-major) by Cholesky. */
function cholSolve(A, b, n) {
  const L = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j]
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k]
      if (i === j) {
        if (s <= 1e-12) return null
        L[i * n + i] = Math.sqrt(s)
      } else {
        L[i * n + j] = s / L[j * n + j]
      }
    }
  }
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]
    y[i] = s / L[i * n + i]
  }
  const x = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]
    x[i] = s / L[i * n + i]
  }
  return x
}

/** Forward-fill NaNs in place (leading NaNs take the first valid value). */
function fillNaN(a, n) {
  let last = NaN
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(a[i])) a[i] = last
    else last = a[i]
  }
  if (Number.isNaN(a[0])) {
    let first = 0
    for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) { first = a[i]; break }
    for (let i = 0; i < n && Number.isNaN(a[i]); i++) a[i] = first
  }
}

/** Subtract an edge-clamped centred moving average (the slow baseline b(t)). */
function removeBaseline(a, n, half, prefix) {
  prefix[0] = 0
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + a[i]
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1)
    a[i] -= (prefix[hi] - prefix[lo]) / (hi - lo)
  }
}

export default class PulseTracker {
  constructor(store) {
    this._store = store
    this._fits  = new Map()   // slot index → fit record
  }

  reset() { this._fits.clear() }

  /**
   * Cardiac phase (radians, 0 ≡ systolic peak, cumulative within the local
   * spline segment), instantaneous rate (Hz) and fit reliability (0–1) at
   * session time t. Null before the first fit is possible (t < MIN_WIN_S) or
   * when the PPG has not yet been written far enough.
   * @returns {{phase:number, hz:number, w:number}|null}
   */
  at(t) {
    if (!(t >= 0)) return null
    let i = Math.floor(t / HOP_S)
    let a = this._eff(i)
    if (!a) {
      // At the live edge the newest fit trails the cursor by up to a slot or
      // two (its window must be fully written) — extrapolate from it.
      for (let j = i - 1; j >= i - EDGE_LOOKBACK && !a; j--) { a = this._eff(j); if (a) i = j }
      if (!a) return null
    }
    const ti = i * HOP_S
    const b  = this._eff(i + 1)
    if (!b) {
      return { phase: a.phase + TWO_PI * a.hz * (t - ti), hz: a.hz, w: a.w }
    }
    // Cubic Hermite between the two fits: end values are the fitted phases
    // (b unwrapped nearest to the rate prediction), end slopes the fitted rates.
    const u   = (t - ti) / HOP_S
    const pred = a.phase + Math.PI * (a.hz + b.hz) * HOP_S
    const pb  = b.phase + TWO_PI * Math.round((pred - b.phase) / TWO_PI)
    const u2 = u * u, u3 = u2 * u
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u
    const h01 = -2 * u3 + 3 * u2,    h11 = u3 - u2
    const phase = h00 * a.phase + h10 * HOP_S * TWO_PI * a.hz
                + h01 * pb      + h11 * HOP_S * TWO_PI * b.hz
    return { phase, hz: a.hz + (b.hz - a.hz) * u, w: a.w + (b.w - a.w) * u }
  }

  /**
   * Effective (phase mod 2π, hz, w) at slot i under the soft lock: an anchor
   * slot (w ≥ W_ANCHOR) stands on its own fit; a weaker slot starts from the
   * last anchor within LOOKBACK integrated forward at the anchor's rate and
   * moves toward its own fitted phase by gain smoothstep(W_FLOOR, W_ANCHOR, w)
   * — so an artifact stretch holds its course instead of jumping, and the
   * hand-back to a clean fit is gradual. With no anchor in reach the slot's
   * own values are used as they are (amplitude is gated on w downstream).
   */
  _eff(i) {
    const fit = this._fit(i)
    if (!fit) return null
    if (fit.valid && fit.w >= W_ANCHOR) return { phase: fit.phase, hz: fit.f0, w: fit.w }
    for (let j = i - 1; j >= Math.max(0, i - LOOKBACK); j--) {
      const r = this._fit(j)
      if (r && r.valid && r.w >= W_ANCHOR) {
        const held = wrap2pi(r.phase + TWO_PI * r.f0 * (i - j) * HOP_S)
        if (!fit.valid) return { phase: held, hz: r.f0, w: 0 }
        const gain = smoothstep(W_FLOOR, W_ANCHOR, fit.w)
        return {
          phase: wrap2pi(held + gain * wrapPi(fit.phase - held)),
          hz: r.f0 + gain * (fit.f0 - r.f0),
          w: fit.w,
        }
      }
    }
    return fit.valid ? { phase: fit.phase, hz: fit.f0, w: fit.w } : { phase: 0, hz: 0, w: 0 }
  }

  /** Cached fit for slot i (window ending at i·HOP_S); null if not computable yet. */
  _fit(i) {
    const cached = this._fits.get(i)
    if (cached) return cached
    const tEnd = i * HOP_S
    if (tEnd < MIN_WIN_S) return null
    const ppg = this._store.ppg
    const s1 = Math.round(tEnd * PPG_FS)
    // Wait for the window's tail to be fully written (one packet of margin),
    // so a slot is never cached against a half-arrived last packet.
    if (ppg.length < s1 + 8) return null
    const fit = this._compute(Math.max(0, s1 - WIN_S * PPG_FS), s1)
    fit.t = tEnd
    this._fits.set(i, fit)
    return fit
  }

  /** The analysis-by-synthesis fit over PPG grid samples [s0, s1). */
  _compute(s0, s1) {
    const store = this._store
    const N = (s1 - s0) >> 1
    const invalid = { valid: false, f0: 0, phase: 0, w: 0 }
    if (N < MIN_WIN_S * FIT_FS - 2) return invalid

    // ── PPG: decimate 2:1, track gaps, fill, detrend, weight, normalize ──────
    const raw = store.ppg.channelSlice(0, s0, s0 + N * DECIM)
    const x   = new Float64Array(N)
    const wr  = new Float64Array(N)       // LS row weights (0 on missing samples)
    let nanCount = 0
    for (let n = 0; n < N; n++) {
      const a = raw[2 * n], b = raw[2 * n + 1]
      if (Number.isNaN(a) || Number.isNaN(b)) { x[n] = NaN; nanCount++ }
      else x[n] = 0.5 * (a + b)
    }
    if (nanCount > MAX_NAN_FRAC * N) return invalid
    const missing = new Uint8Array(N)
    for (let n = 0; n < N; n++) missing[n] = Number.isNaN(x[n]) ? 1 : 0
    fillNaN(x, N)
    const prefix = new Float64Array(N + 1)
    removeBaseline(x, N, BASELINE_HALF, prefix)
    // Ramp weighting: the fit is read out at the window's end, so recent
    // cycles dominate (a rate drifting across the window biases the end
    // phase far less than with uniform weights).
    for (let n = 0; n < N; n++) {
      wr[n] = missing[n] ? 0 : RAMP_W0 + (1 - RAMP_W0) * (n / (N - 1))
    }
    let sw = 0, sxx = 0
    for (let n = 0; n < N; n++) { sw += wr[n]; sxx += wr[n] * x[n] * x[n] }
    const rms = Math.sqrt(sxx / Math.max(sw, 1e-9))
    if (!(rms > 1e-9)) return invalid
    const sq = new Float64Array(N)        // sqrt(weight), applied to every column
    for (let n = 0; n < N; n++) { sq[n] = Math.sqrt(wr[n]); x[n] = x[n] / rms * sq[n] }

    // ── Motion regressors: accel (x, y, z, |a|) resampled to FIT_FS, lagged ─
    const tStart = s0 / PPG_FS
    const G = this._motionRegressors(tStart, N, sq, prefix)
    const M = G ? G.cols : 0

    // ── Stage A: project the motion model out once, then grid-search f0 on
    //    the harmonic model alone (cheap: a 2K×2K solve per candidate) ───────
    let xr = x
    let GtG = null
    if (M) {
      GtG = new Float64Array(M * M)
      const Gtx = new Float64Array(M)
      const g = G.data
      for (let a = 0; a < M; a++) {
        const ga = a * N
        for (let b = 0; b <= a; b++) {
          const gb = b * N
          let s = 0
          for (let n = 0; n < N; n++) s += g[ga + n] * g[gb + n]
          GtG[a * M + b] = s; GtG[b * M + a] = s
        }
        let s = 0
        for (let n = 0; n < N; n++) s += g[ga + n] * x[n]
        Gtx[a] = s
      }
      const A = new Float64Array(GtG)
      for (let a = 0; a < M; a++) A[a * M + a] += RIDGE * N
      const beta = cholSolve(A, Gtx, M)
      if (beta) {
        xr = new Float64Array(x)
        for (let a = 0; a < M; a++) {
          const ga = a * N, ba = beta[a]
          for (let n = 0; n < N; n++) xr[n] -= ba * g[ga + n]
        }
      }
    }

    const H = new Float64Array(2 * K * N)   // scratch: weighted harmonic columns
    let bestF = F_MIN, bestE = Infinity
    for (let f = F_MIN; f <= F_MAX + 1e-9; f += F_COARSE) {
      const E = this._harmonicResidual(xr, sq, N, f, H)
      if (E < bestE) { bestE = E; bestF = f }
    }
    const fLo = Math.max(F_MIN, bestF - F_FINE_SPAN), fHi = Math.min(F_MAX, bestF + F_FINE_SPAN)
    for (let f = fLo; f <= fHi + 1e-9; f += F_FINE) {
      const E = this._harmonicResidual(xr, sq, N, f, H)
      if (E < bestE) { bestE = E; bestF = f }
    }
    const f0 = bestF

    // ── Stage B: joint solve at f0 — harmonics and motion regressors share
    //    the explanation (the orthogonality/separation constraint), and the
    //    final phase, amplitudes and reliability come from this fit ──────────
    this._harmonicColumns(sq, N, f0, H)
    const P = 2 * K + M
    const A = new Float64Array(P * P)
    const bvec = new Float64Array(P)
    const col = (c) => (c < 2 * K ? H.subarray(c * N, c * N + N) : G.data.subarray((c - 2 * K) * N, (c - 2 * K) * N + N))
    for (let a = 0; a < P; a++) {
      const ca = col(a)
      for (let b = 0; b <= a; b++) {
        const cb = col(b)
        let s = 0
        for (let n = 0; n < N; n++) s += ca[n] * cb[n]
        A[a * P + b] = s; A[b * P + a] = s
      }
      let s = 0
      for (let n = 0; n < N; n++) s += ca[n] * x[n]
      bvec[a] = s
      if (a >= 2 * K) A[a * P + a] += RIDGE * N
    }
    const beta = cholSolve(A, bvec, P)
    if (!beta) return invalid

    let Ph = 0, Pg = 0, Pr = 0
    for (let n = 0; n < N; n++) {
      let yh = 0, yg = 0
      for (let c = 0; c < 2 * K; c++) yh += beta[c] * H[c * N + n]
      for (let c = 0; c < M; c++) yg += beta[2 * K + c] * G.data[c * N + n]
      const r = x[n] - yh - yg
      Ph += yh * yh; Pg += yg * yg; Pr += r * r
    }
    // Reliability: the cardiac model's share of what the window contains,
    // with motion-explained power counting partly against it (a window the
    // accelerometer had to explain is one whose cardiac phase is less certain).
    const w = Ph / (Ph + Pr + MOTION_PENALTY * Pg + 1e-12)

    // ── Stage C: end-phase refinement. f0 is a whole-window estimate; the
    //    phase we need is at the window's end, and a rate drifting across the
    //    window (respiratory sinus arrhythmia) makes the single-f0 fit lag
    //    there. With the motion part removed, re-fit the harmonic amplitudes/
    //    phases over the last PHASE_WIN_S at the same f0 — phase read-out
    //    then follows the most recent cycles only ─────────────────────────────
    let hb = beta.subarray(0, 2 * K)
    {
      const n0 = Math.max(0, N - PHASE_WIN_S * FIT_FS)
      const D = 2 * K
      const A2 = new Float64Array(D * D)
      const b2 = new Float64Array(D)
      for (let a = 0; a < D; a++) {
        const oa = a * N
        for (let c = 0; c <= a; c++) {
          const oc = c * N
          let t = 0
          for (let n = n0; n < N; n++) t += H[oa + n] * H[oc + n]
          A2[a * D + c] = t; A2[c * D + a] = t
        }
        let t = 0
        for (let n = n0; n < N; n++) {
          let yg = 0
          for (let c = 0; c < M; c++) yg += beta[2 * K + c] * G.data[c * N + n]
          t += H[oa + n] * (x[n] - yg)
        }
        b2[a] = t
      }
      const refined = cholSolve(A2, b2, D)
      if (refined) hb = refined
    }

    // ── Systolic phase at the window end: locate the peak of the synthesized
    //    cardiac cycle (all K harmonics, sign convention applied) ─────────────
    let peakPhi = 0, peakVal = -Infinity
    for (let m = 0; m < 128; m++) {
      const phi = (m / 128) * TWO_PI
      let y = 0
      for (let k = 1; k <= K; k++) {
        y += hb[2 * (k - 1)] * Math.cos(k * phi) + hb[2 * (k - 1) + 1] * Math.sin(k * phi)
      }
      y *= PPG_SIGN
      if (y > peakVal) { peakVal = y; peakPhi = phi }
    }
    // Model phase θ at the window end (samples sit at (2n+0.5)/64 s past tStart).
    const thetaEnd = TWO_PI * f0 * (N * DECIM / PPG_FS)
    return { valid: true, f0, phase: wrap2pi(thetaEnd - peakPhi), w }
  }

  /** Fill H (2K columns × N, weighted): cos(kθ_n), sin(kθ_n) via rotation recurrence. */
  _harmonicColumns(sq, N, f0, H) {
    const step = TWO_PI * f0 / FIT_FS
    const th0  = TWO_PI * f0 * (0.5 / PPG_FS)
    for (let k = 1; k <= K; k++) {
      const dc = Math.cos(k * step), ds = Math.sin(k * step)
      let c = Math.cos(k * th0), s = Math.sin(k * th0)
      const oc = 2 * (k - 1) * N, os = oc + N
      for (let n = 0; n < N; n++) {
        H[oc + n] = c * sq[n]
        H[os + n] = s * sq[n]
        const c2 = c * dc - s * ds
        s = s * dc + c * ds
        c = c2
      }
    }
  }

  /** Weighted residual energy of the best K-harmonic fit at f0 to xr. */
  _harmonicResidual(xr, sq, N, f0, H) {
    this._harmonicColumns(sq, N, f0, H)
    const D = 2 * K
    const A = new Float64Array(D * D)
    const b = new Float64Array(D)
    let exx = 0
    for (let n = 0; n < N; n++) exx += xr[n] * xr[n]
    for (let a = 0; a < D; a++) {
      const oa = a * N
      for (let c = 0; c <= a; c++) {
        const oc = c * N
        let s = 0
        for (let n = 0; n < N; n++) s += H[oa + n] * H[oc + n]
        A[a * D + c] = s; A[c * D + a] = s
      }
      let s = 0
      for (let n = 0; n < N; n++) s += H[oa + n] * xr[n]
      b[a] = s
    }
    const beta = cholSolve(A, b, D)
    if (!beta) return exx
    let explained = 0
    for (let a = 0; a < D; a++) explained += beta[a] * b[a]
    return exx - explained
  }

  /**
   * Lagged, baseline-removed, unit-RMS accelerometer regressors (x, y, z and
   * |a|, each at ACC_LAGS) resampled from the 52 Hz grid onto the fit grid.
   * Returns null when the window has too little accelerometer coverage.
   */
  _motionRegressors(tStart, N, sq, prefix) {
    const acc = this._store.accel
    if (!acc || !acc.length) return null
    const i0 = Math.floor(tStart * IMU_FS)
    const i1 = Math.ceil((tStart + N / FIT_FS) * IMU_FS) + 2
    const ax = acc.channelSlice(0, i0, i1)
    const ay = acc.channelSlice(1, i0, i1)
    const az = acc.channelSlice(2, i0, i1)
    const base = [new Float64Array(N), new Float64Array(N), new Float64Array(N), new Float64Array(N)]
    let valid = 0
    for (let n = 0; n < N; n++) {
      const pos = (tStart + (2 * n + 0.5) / PPG_FS) * IMU_FS - i0
      const j = Math.floor(pos), f = pos - j
      const lerp = (arr) => {
        const a = arr[j], b = arr[j + 1]
        if (Number.isNaN(a)) return b
        if (Number.isNaN(b)) return a
        return a + (b - a) * f
      }
      const vx = lerp(ax), vy = lerp(ay), vz = lerp(az)
      base[0][n] = vx; base[1][n] = vy; base[2][n] = vz
      base[3][n] = Math.sqrt(vx * vx + vy * vy + vz * vz)
      if (!Number.isNaN(vx) && !Number.isNaN(vy) && !Number.isNaN(vz)) valid++
    }
    if (valid < MIN_ACC_FRAC * N) return null
    for (const ch of base) {
      fillNaN(ch, N)
      removeBaseline(ch, N, BASELINE_HALF, prefix)
      let s = 0
      for (let n = 0; n < N; n++) s += ch[n] * ch[n]
      const r = Math.sqrt(s / N)
      const inv = r > 1e-9 ? 1 / r : 0
      for (let n = 0; n < N; n++) ch[n] *= inv
    }
    const cols = ACC_CHANNELS * ACC_LAGS.length
    const data = new Float64Array(cols * N)
    let c = 0
    for (let ch = 0; ch < ACC_CHANNELS; ch++) {
      for (const lag of ACC_LAGS) {
        const o = c * N
        for (let n = 0; n < N; n++) {
          const m = Math.min(N - 1, Math.max(0, n - lag))
          data[o + n] = base[ch][m] * sq[n]
        }
        c++
      }
    }
    return { cols, data }
  }
}
