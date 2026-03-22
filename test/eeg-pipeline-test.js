/**
 * Synthetic EEG signal tests for the band power pipeline.
 *
 * Exercises the full path: raw samples → per-channel wavelet/DFT analysis →
 * quality-weighted aggregation → aperiodic model fitting → normalised output.
 *
 * Run with:  node test/eeg-pipeline-test.js
 *
 * No dependencies beyond Node.js — reimplements the pipeline constants and
 * kernel precomputation from EEGManager so the test is self-contained.
 */

// ── Pipeline constants (mirrored from EEGManager.js) ─────────────────────────

const EEG_FS       = 256
const EEG_BUF_SIZE = 256

const WAVELET_WAVENUMBER = 6
const WAVELET_WAVENUMBER_THETA = 4
const WAVELET_BAND_FREQS = { theta: 6, alpha: 10, beta: 20, gamma: 40 }
const DFT_BINS = [1, 2, 3]

const AP_FIT_FREQS = [6, 10, 20, 40]
const AP_FIT_BANDS = ['theta', 'alpha', 'beta', 'gamma']
const APERIODIC_UPDATE_INTERVAL = 10
const AP_SMOOTH    = 0.3
const AP_MIN_REFITS = 3

// ── Kernel precomputation ────────────────────────────────────────────────────

const wavelets = {}
for (const [band, f] of Object.entries(WAVELET_BAND_FREQS)) {
  const tau     = band === 'theta' ? WAVELET_WAVENUMBER_THETA : WAVELET_WAVENUMBER
  const sigma   = tau / (2 * Math.PI * f)
  const A       = 1 / Math.sqrt(sigma * Math.sqrt(Math.PI))
  const halfWin = Math.ceil(3.0 * sigma * EEG_FS)
  const len     = 2 * halfWin + 1
  const re      = new Float32Array(len)
  const im      = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const t     = (i - halfWin) / EEG_FS
    const gauss = A * Math.exp(-(t * t) / (2 * sigma * sigma))
    re[i] = gauss * Math.cos(2 * Math.PI * f * t)
    im[i] = gauss * Math.sin(2 * Math.PI * f * t)
  }
  wavelets[band] = { re, im, halfWin }
}

const dftKernels = {}
for (const k of DFT_BINS) {
  const reK = new Float32Array(EEG_BUF_SIZE)
  const imK = new Float32Array(EEG_BUF_SIZE)
  for (let n = 0; n < EEG_BUF_SIZE; n++) {
    const hann  = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (EEG_BUF_SIZE - 1))
    const angle = (2 * Math.PI * k * n) / EEG_BUF_SIZE
    reK[n] = hann * Math.cos(angle)
    imK[n] = hann * Math.sin(angle)
  }
  dftKernels[k] = { re: reK, im: imK }
}

// ── Pipeline functions (extracted from EEGManager) ───────────────────────────

function waveletPower(sig, band) {
  const { re, im, halfWin } = wavelets[band]
  const N = sig.length, kLen = re.length
  const start = halfWin, end = N - 1 - halfWin
  if (start > end) return 0
  let totalPower = 0, count = 0
  for (let i = start; i <= end; i++) {
    let r = 0, m = 0
    const base = i - halfWin
    for (let k = 0; k < kLen; k++) {
      r += re[k] * sig[base + k]
      m += im[k] * sig[base + k]
    }
    totalPower += r * r + m * m
    count++
  }
  return count > 0 ? totalPower / count : 0
}

function computeChannelBands(sig) {
  let delta = 0
  for (const k of DFT_BINS) {
    const { re: reK, im: imK } = dftKernels[k]
    let r = 0, m = 0
    for (let n = 0; n < EEG_BUF_SIZE; n++) {
      r += reK[n] * sig[n]
      m += imK[n] * sig[n]
    }
    delta += r * r + m * m
  }
  return {
    delta,
    theta: waveletPower(sig, 'theta'),
    alpha: waveletPower(sig, 'alpha'),
    beta:  waveletPower(sig, 'beta'),
    gamma: waveletPower(sig, 'gamma'),
  }
}

function linReg(xs, ys) {
  const n = xs.length
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0
  for (let i = 0; i < n; i++) {
    sumX += xs[i]; sumY += ys[i]; sumXX += xs[i] * xs[i]; sumXY += xs[i] * ys[i]
  }
  const denom = n * sumXX - sumX * sumX
  if (Math.abs(denom) < 1e-12) return { a: sumY / n, b: 0 }
  const b = (n * sumXY - sumX * sumY) / denom
  const a = (sumY - b * sumX) / n
  return { a, b }
}

function refitModel(model, bands, isFirst) {
  const logF = AP_FIT_FREQS.map(f => Math.log10(f))
  const logP = AP_FIT_BANDS.map(band => {
    const p = bands[band]
    return p > 0 ? Math.log10(p) : -10
  })
  const { a, b } = linReg(logF, logP)
  const smooth = isFirst ? 1.0 : AP_SMOOTH
  return {
    a: (1 - smooth) * model.a + smooth * a,
    b: (1 - smooth) * model.b + smooth * b,
  }
}

function apNormalize(raw, model, refitCount) {
  if (refitCount < AP_MIN_REFITS) {
    return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
  }
  const { a, b } = model
  const BAND_FREQ = { delta: 2, theta: 6, alpha: 10, beta: 20, gamma: 40 }
  let total = 0
  const norm = {}
  for (const [band, f] of Object.entries(BAND_FREQ)) {
    const expected = Math.pow(10, a + b * Math.log10(f))
    norm[band] = raw[band] > 0 ? raw[band] / expected : 0
    total += norm[band]
  }
  if (total === 0) return { delta: 0.2, theta: 0.2, alpha: 0.2, beta: 0.2, gamma: 0.2 }
  for (const band of Object.keys(norm)) norm[band] /= total
  return norm
}

// ── Signal generators ────────────────────────────────────────────────────────

/** Generate pink noise (1/f) using the Voss-McCartney algorithm. */
function pinkNoise(N) {
  const out = new Float64Array(N)
  const numRows = 16
  const rows = new Float64Array(numRows)
  let runningSum = 0
  for (let i = 0; i < numRows; i++) {
    rows[i] = (Math.random() - 0.5) * 2
    runningSum += rows[i]
  }
  for (let i = 0; i < N; i++) {
    const col = ctz(i)
    if (col < numRows) {
      runningSum -= rows[col]
      rows[col] = (Math.random() - 0.5) * 2
      runningSum += rows[col]
    }
    out[i] = runningSum / numRows + (Math.random() - 0.5) * 0.5
  }
  const max = out.reduce((a, v) => Math.max(a, Math.abs(v)), 0) || 1
  for (let i = 0; i < N; i++) out[i] /= max
  return out
}

function ctz(n) { if (n === 0) return 32; let c = 0; while ((n & 1) === 0) { c++; n >>= 1 } return c }

/** Generate a buffer of pink noise + optional sine components. */
function generateEEG(nSamples, noiseAmplitude, sines = []) {
  const noise = pinkNoise(nSamples)
  const out = new Float64Array(nSamples)
  for (let i = 0; i < nSamples; i++) {
    out[i] = noise[i] * noiseAmplitude
    for (const { freq, amp } of sines) {
      out[i] += amp * Math.sin(2 * Math.PI * freq * i / EEG_FS)
    }
  }
  return out
}

// ── Simulation harness ───────────────────────────────────────────────────────

/**
 * Simulate the full pipeline: feed samples one at a time, trigger analysis
 * at the correct intervals, and return the band power history.
 */
function simulate(signal, { label = '', channels = 4 } = {}) {
  const chBuffers = Array.from({ length: channels }, () => [])
  let model = { a: 0, b: -1.5 }
  let apWindowCount = 0
  let refitCount = 0
  let analysisCount = 0
  const history = []

  for (let i = 0; i < signal.length; i++) {
    const val = signal[i]
    for (let ch = 0; ch < channels; ch++) {
      chBuffers[ch].push(val)
      if (chBuffers[ch].length > EEG_BUF_SIZE) chBuffers[ch].shift()
    }

    analysisCount++
    if (analysisCount >= EEG_BUF_SIZE / 2 && chBuffers[0].length >= EEG_BUF_SIZE) {
      analysisCount = 0

      const chBands = chBuffers.map(buf => computeChannelBands([...buf]))
      const weights = new Array(channels).fill(1 / channels)

      const raw = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
      for (const band of Object.keys(raw)) {
        for (let ch = 0; ch < channels; ch++) raw[band] += chBands[ch][band] * weights[ch]
      }

      apWindowCount++
      if (apWindowCount >= APERIODIC_UPDATE_INTERVAL) {
        apWindowCount = 0
        model = refitModel(model, raw, refitCount === 0)
        refitCount++
      }

      const bp = apNormalize(raw, model, refitCount)
      history.push({ sample: i, raw: { ...raw }, model: { ...model }, refitCount, bandPower: { ...bp } })
    }
  }

  return history
}

// ── Test cases ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else           { failed++; console.error(`  ✗ ${msg}`) }
}

function approxEq(a, b, tol = 0.01) { return Math.abs(a - b) < tol }

// ── Test 1: Warm-up gate ─────────────────────────────────────────────────────
console.log('\nTest 1: Warm-up gate (output is zeros before AP_MIN_REFITS)')
{
  const sig = generateEEG(EEG_BUF_SIZE * 20, 20, [{ freq: 10, amp: 15 }])
  const hist = simulate(sig)
  const earlyFrames = hist.filter(h => h.refitCount < AP_MIN_REFITS)
  const allZero = earlyFrames.every(h =>
    Object.values(h.bandPower).every(v => v === 0)
  )
  assert(earlyFrames.length > 0, `${earlyFrames.length} analysis windows before warm-up ends`)
  assert(allZero, 'all band powers are zero during warm-up')
}

// ── Test 2: Post-warm-up output sums to 1 ────────────────────────────────────
console.log('\nTest 2: Post-warm-up output sums to 1')
{
  const sig = generateEEG(EEG_BUF_SIZE * 60, 20, [{ freq: 10, amp: 15 }])
  const hist = simulate(sig)
  const postWarmup = hist.filter(h => h.refitCount >= AP_MIN_REFITS)
  assert(postWarmup.length > 5, `${postWarmup.length} post-warm-up windows`)
  const allSumOne = postWarmup.every(h => {
    const sum = Object.values(h.bandPower).reduce((a, b) => a + b, 0)
    return approxEq(sum, 1.0, 0.001)
  })
  assert(allSumOne, 'all post-warm-up outputs sum to 1.0')
}

// ── Test 3: Alpha elevation detected ─────────────────────────────────────────
console.log('\nTest 3: Alpha elevation (eyes closed) produces highest alpha share')
{
  // Strong 10 Hz sine + pink noise = elevated alpha
  const sig = generateEEG(EEG_BUF_SIZE * 60, 10, [{ freq: 10, amp: 30 }])
  const hist = simulate(sig)
  const last5 = hist.slice(-5)
  const alphaHighest = last5.every(h => {
    const bp = h.bandPower
    return bp.alpha > bp.theta && bp.alpha > bp.beta && bp.alpha > bp.gamma
  })
  assert(alphaHighest, 'alpha is the dominant band when 10 Hz sine is present')

  const avgAlpha = last5.reduce((s, h) => s + h.bandPower.alpha, 0) / last5.length
  assert(avgAlpha > 0.3, `alpha share = ${avgAlpha.toFixed(3)} (should be > 0.3)`)
}

// ── Test 4: Sustained alpha stays elevated ───────────────────────────────────
console.log('\nTest 4: Sustained alpha does NOT decay to zero')
{
  // 30 seconds of sustained alpha (10 Hz sine)
  const nSamples = EEG_FS * 30
  const sig = generateEEG(nSamples, 10, [{ freq: 10, amp: 30 }])
  const hist = simulate(sig)
  const postWarmup = hist.filter(h => h.refitCount >= AP_MIN_REFITS)

  const firstFew = postWarmup.slice(0, 3)
  const lastFew  = postWarmup.slice(-3)

  const earlyAlpha = firstFew.reduce((s, h) => s + h.bandPower.alpha, 0) / firstFew.length
  const lateAlpha  = lastFew.reduce((s, h) => s + h.bandPower.alpha, 0) / lastFew.length

  assert(lateAlpha > 0.2, `late alpha = ${lateAlpha.toFixed(3)} (should remain elevated, not decay to zero)`)
  const ratio = lateAlpha / earlyAlpha
  assert(ratio > 0.5, `late/early alpha ratio = ${ratio.toFixed(3)} (should not drastically decay)`)
}

// ── Test 5: Model convergence — first fit is instant ─────────────────────────
console.log('\nTest 5: First aperiodic model fit is instant (no blending with prior)')
{
  const sig = generateEEG(EEG_BUF_SIZE * 20, 20, [{ freq: 10, amp: 10 }])
  const hist = simulate(sig)
  const firstRefit = hist.find(h => h.refitCount === 1)
  assert(firstRefit !== undefined, 'first refit occurred')

  // After instant first fit, model.a should be far from the prior (0)
  // because actual wavelet power of a 20µV signal produces large values
  assert(Math.abs(firstRefit.model.a) > 0.5,
    `model.a = ${firstRefit.model.a.toFixed(3)} after first fit (should diverge from prior a=0)`)
}

// ── Test 6: Pure pink noise — no single band dominates overwhelmingly ────────
// NOTE: delta uses Hann-DFT while theta–gamma use Morlet wavelets, producing
// different absolute scales. The 1/f model is fitted from wavelet powers at
// 6–40 Hz and extrapolated to 2 Hz for delta, so delta's share may be elevated.
// We test that theta–gamma (all wavelet-derived) are balanced, and that no
// single band exceeds 0.8 (overwhelming dominance).
console.log('\nTest 6: Pure pink noise — no single band overwhelmingly dominant')
{
  const sig = generateEEG(EEG_BUF_SIZE * 60, 20)
  const hist = simulate(sig)
  const last5 = hist.slice(-5)
  const avg = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
  for (const h of last5) {
    for (const b of Object.keys(avg)) avg[b] += h.bandPower[b]
  }
  for (const b of Object.keys(avg)) avg[b] /= last5.length

  const noDomination = Object.values(avg).every(v => v < 0.8)
  const waveletBands = [avg.theta, avg.alpha, avg.beta, avg.gamma]
  const waveletReasonable = waveletBands.every(v => v > 0.01)
  assert(noDomination,
    `no band > 0.8: δ=${avg.delta.toFixed(3)} θ=${avg.theta.toFixed(3)} ` +
    `α=${avg.alpha.toFixed(3)} β=${avg.beta.toFixed(3)} γ=${avg.gamma.toFixed(3)}`)
  assert(waveletReasonable, 'all wavelet bands (θ/α/β/γ) are non-negligible')
}

// ── Test 7: State transition — alpha onset after baseline ────────────────────
console.log('\nTest 7: State transition — alpha onset detected after baseline period')
{
  // 25s baseline (pink noise only), then 25s with strong alpha
  // Long enough that warm-up (≈15s) finishes well within the baseline period.
  const baselineSamples = EEG_FS * 25
  const alphaSamples    = EEG_FS * 25
  const baseline = generateEEG(baselineSamples, 20)
  const alpha    = generateEEG(alphaSamples, 20, [{ freq: 10, amp: 30 }])
  const sig = new Float64Array(baselineSamples + alphaSamples)
  sig.set(baseline)
  sig.set(alpha, baselineSamples)

  const hist = simulate(sig)
  const postWarmup = hist.filter(h => h.refitCount >= AP_MIN_REFITS)

  // Split into baseline and alpha periods
  const midSample = baselineSamples
  const baselineHist = postWarmup.filter(h => h.sample < midSample)
  const alphaHist    = postWarmup.filter(h => h.sample >= midSample)

  if (baselineHist.length > 0 && alphaHist.length > 0) {
    const baseAlpha = baselineHist.reduce((s, h) => s + h.bandPower.alpha, 0) / baselineHist.length
    const onsetAlpha = alphaHist.reduce((s, h) => s + h.bandPower.alpha, 0) / alphaHist.length

    assert(onsetAlpha > baseAlpha,
      `alpha increases: baseline=${baseAlpha.toFixed(3)} → onset=${onsetAlpha.toFixed(3)}`)
  } else {
    assert(false, 'not enough post-warmup data for state transition test')
  }
}

// ── Test 8: Wavelet valid sample counts ──────────────────────────────────────
console.log('\nTest 8: Wavelet kernel sizes and valid sample counts')
{
  for (const [band, { halfWin }] of Object.entries(wavelets)) {
    const valid = EEG_BUF_SIZE - 2 * halfWin
    console.log(`  ${band}: halfWin=${halfWin}, valid=${valid}`)
    assert(valid >= 10, `${band} has at least 10 valid samples (got ${valid})`)
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
