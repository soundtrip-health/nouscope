import App from '../App'

// ── Constants ─────────────────────────────────────────────────────────────────

// MSE: coarse-grain at each τ in SCALES, compute SampEn at each scale.
// Odd scales {1,3,5,7,9} give a wider temporal range than consecutive 1..6 while
// keeping the per-scale cost manageable. At τ=9 the 2048-sample window coarse-grains
// to 227 samples — still within SampEn's usable range for m=2.
const SCALES        = [1, 3, 5, 7, 9]
const NUM_SCALES    = SCALES.length
const EMBED_DIM     = 2        // m — embedding dimension for SampEn (2 is standard)
const TOL_COEF      = 0.15     // r = TOL_COEF × σ  (Richman & Moorman, 2000)
const WIN_SAMPLES   = 2048     // 8 s of EEG at 256 Hz — balances resolution vs. cost

// Update cadence. Re-running MSE is expensive (O(N²) per scale), so we rate-limit
// aggressively. Ideal for a slowly-drifting state measure rather than a reactive signal.
const UPDATE_INTERVAL_MS = 5000

// Quality scoring (mirrors EEGManager + EntrainmentManager conventions)
const Q_WEIGHT = { good: 1.0, marginal: 0.5, poor: 0.0 }

// ── ComplexityManager ───────────────────────────────────────────────────────

/**
 * ComplexityManager — real-time multiscale entropy (MSE) on the quality-weighted
 * 4-channel EEG average.
 *
 * MSE workflow (Costa, Goldberger & Peng, 2002):
 *   1. Coarse-grain the signal at each scale τ (average τ consecutive samples).
 *   2. Compute Sample Entropy (SampEn, m=2, r=0.15·σ) on each coarse-grained series.
 *   3. The resulting curve reflects signal complexity across time scales.
 *
 * Interpretation:
 *   - Flat low curve       → highly regular signal (e.g. seizure, deep anesthesia).
 *   - High curve at small τ → dominant fast-scale randomness.
 *   - Curve rising with τ  → rich cross-scale structure ("healthy" complexity).
 *
 * The tolerance r is fixed from the full-signal σ (not recomputed per scale),
 * which matches the original MSE convention and lets scale-vs-scale values be
 * compared on a common axis.
 *
 * Exposes:
 *   mseCurve   — Float32Array(NUM_SCALES) of SampEn values (EMA-smoothed)
 *   complexity — mean of mseCurve across scales; 0–1-ish typical range
 *
 * References:
 *   - Costa, Goldberger & Peng (2002) "Multiscale entropy analysis of
 *     complex physiologic time series"
 *   - Richman & Moorman (2000) "Physiological time-series analysis using
 *     approximate entropy and sample entropy"
 */
export default class ComplexityManager {
  // ── Public output ──────────────────────────────────────────────────────────
  mseCurve   = new Float32Array(NUM_SCALES)
  complexity = 0       // 0–1-ish; mean SampEn across scales
  numScales  = NUM_SCALES
  scales     = SCALES  // τ values in display order

  // ── Private ────────────────────────────────────────────────────────────────
  _lastUpdateTime = 0
  _avgBuf         = new Float32Array(WIN_SAMPLES)

  update(now) {
    if (now - this._lastUpdateTime < UPDATE_INTERVAL_MS) return
    this._lastUpdateTime = now

    const eegMgr = App.eegManager
    if (!eegMgr?.isConnected) {
      this._reset()
      return
    }

    const chBufs = eegMgr._chBuffersLong
    if (!chBufs?.[0] || chBufs[0].length < WIN_SAMPLES) return

    // Quality-weighted channel aggregation — matches EntrainmentManager approach
    const sq = eegMgr.signalQuality
    const weights = sq.map(q => Q_WEIGHT[q] ?? 0)
    const totalW  = weights.reduce((a, b) => a + b, 0)
    if (totalW === 0) return

    const N = WIN_SAMPLES
    const buf = this._avgBuf
    for (let i = 0; i < N; i++) {
      let s = 0
      for (let ch = 0; ch < 4; ch++) {
        if (weights[ch] === 0) continue
        const sig = chBufs[ch]
        s += sig[sig.length - N + i] * weights[ch]
      }
      buf[i] = s / totalW
    }

    // Tolerance r — fixed from full-signal σ so scale values stay comparable
    const sigma = _std(buf)
    if (sigma < 1e-6) { this._reset(); return }
    const r = TOL_COEF * sigma

    // SampEn at each scale — raw values, no smoothing
    let sum = 0
    for (let i = 0; i < NUM_SCALES; i++) {
      const tau = SCALES[i]
      const coarse = _coarseGrain(buf, tau)
      let se = _sampleEntropy(coarse, EMBED_DIM, r)
      if (!isFinite(se) || se < 0) se = 0
      this.mseCurve[i] = se
      sum += se
    }
    this.complexity = sum / NUM_SCALES

    App.recordingManager?.recordMse(this.mseCurve, this.complexity)
  }

  _reset() {
    this.mseCurve.fill(0)
    this.complexity = 0
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Standard deviation of a Float32Array. */
function _std(arr) {
  const N = arr.length
  let sum = 0
  for (let i = 0; i < N; i++) sum += arr[i]
  const mean = sum / N
  let ss = 0
  for (let i = 0; i < N; i++) {
    const d = arr[i] - mean
    ss += d * d
  }
  return Math.sqrt(ss / N)
}

/**
 * Coarse-grain a signal at scale τ: average each non-overlapping block of τ
 * consecutive samples. Returns a Float32Array of length ⌊N/τ⌋.
 */
function _coarseGrain(sig, tau) {
  if (tau === 1) return sig
  const N = sig.length
  const M = Math.floor(N / tau)
  const out = new Float32Array(M)
  for (let j = 0; j < M; j++) {
    let s = 0
    const base = j * tau
    for (let k = 0; k < tau; k++) s += sig[base + k]
    out[j] = s / tau
  }
  return out
}

/**
 * Sample Entropy (Richman & Moorman, 2000).
 *
 *   SampEn(m, r, N) = -ln( A / B )
 *     A = # template pairs (i, j) with Chebyshev distance ≤ r over m+1 points
 *     B = # template pairs (i, j) with Chebyshev distance ≤ r over m   points
 *
 * Self-matches excluded (i ≠ j), so unlike ApEn there is no bias toward log(1).
 * Returns 0 if B=0 or A=0 (undefined log) — a conservative fallback.
 *
 * Complexity: O(N² × m). At N≈1000 and m=2, this is a few million comparisons
 * with an early-exit on mismatch, which runs in milliseconds.
 */
function _sampleEntropy(sig, m, r) {
  const N = sig.length
  if (N < m + 2) return 0

  let A = 0, B = 0
  const limit = N - m

  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      // Chebyshev distance over first m points — early-exit on any mismatch
      let match = true
      for (let k = 0; k < m; k++) {
        if (Math.abs(sig[i + k] - sig[j + k]) > r) { match = false; break }
      }
      if (!match) continue

      B++
      // Extend to m+1: one more point needs to match as well
      if (Math.abs(sig[i + m] - sig[j + m]) <= r) A++
    }
  }

  if (B === 0 || A === 0) return 0
  return -Math.log(A / B)
}
