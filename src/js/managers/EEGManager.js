import { MuseClient, zipSamples } from 'muse-js'

// ── Constants ─────────────────────────────────────────────────────────────────

const PPG_FS       = 64
const PPG_INFRARED = 1          // ppgChannel 1 = infrared, best cardiac signal
const PPG_WIN_SAMP = PPG_FS * 6 // 6-second MSPTDfast analysis window = 384 samples
const PPG_RUN_STEP = PPG_FS     // re-run MSPTD every ~1 s of new data

// Online IIR bandpass (HP 0.5 Hz + LP 3.5 Hz) — covers 30–210 BPM
// First-order high-pass: α = 1 / (1 + 2π·fc/fs)
const HP_ALPHA = 1 / (1 + (2 * Math.PI * 0.5) / PPG_FS)    // ≈ 0.953
// First-order low-pass: α = 2π·fc/fs / (1 + 2π·fc/fs)
const LP_ALPHA = ((2 * Math.PI * 3.5) / PPG_FS) / (1 + (2 * Math.PI * 3.5) / PPG_FS) // ≈ 0.255

// MSPTDfast v2 downsampling (ds_freq = 20 Hz)
const DS_FACTOR = Math.floor(PPG_FS / 20)   // 3 — decimation factor
const DS_FS     = PPG_FS / DS_FACTOR        // ≈ 21.33 Hz for analysis

// Plausible heart rate bounds
const HR_MIN = 30    // bpm
const HR_MAX = 200   // bpm

// Peak refinement tolerance after upsampling (tol_durn = 0.05 s, ds_fs ≥ 20 Hz)
const REFINE_TOL    = Math.ceil(PPG_FS * 0.05)   // 4 samples
// Refractory: reject peaks closer than 300 ms (mirrors MIN_PEAK_DIST in original)
const MIN_PEAK_DIST = Math.round(0.3 * PPG_FS)   // 19 samples

// Accelerometer head-pose smoothing
const ACC_ALPHA = 0.08           // low-pass coefficient — keeps only slow head movements

// EEG spectral analysis
const EEG_BUF_SIZE = 256

// Display ring-buffer lengths
const EEG_DISPLAY_LEN = 256 * 4    // 4 s of raw EEG at 256 Hz
const IMU_DISPLAY_LEN = 52 * 4     // 4 s of IMU at ~52 Hz

// Signal quality RMS thresholds (µV, after mean subtraction)
const SQ_WIN  = 256   // samples per RMS window
const SQ_LOW  = 50     // below → 'good'
const SQ_HIGH = 100    // above → 'poor'; in between → 'marginal'

// ── MSPTDfast v2 helpers ───────────────────────────────────────────────────────

/** Remove best-fit linear trend from a signal (mirrors MATLAB detrend). */
function _detrend(sig) {
  const N = sig.length
  if (N < 2) return sig.slice()
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0
  for (let i = 0; i < N; i++) {
    sumX += i; sumY += sig[i]; sumXX += i * i; sumXY += i * sig[i]
  }
  const denom = N * sumXX - sumX * sumX
  if (denom === 0) return sig.slice()
  const slope     = (N * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / N
  return sig.map((v, i) => v - (slope * i + intercept))
}

/**
 * MSPTDfast v2 core detector (port of msptdpcref_beat_detector).
 * Detects peaks and onsets in a short PPG window via multi-scale scalograms.
 *
 * @param {number[]} sig     — bandpass-filtered PPG samples
 * @param {number}   fs      — sampling frequency of sig (Hz)
 * @param {number}   minHrHz — lower HR bound in Hz (default 30 bpm → 0.5 Hz)
 * @returns {{ peaks: number[], onsets: number[] }} — 0-based indices
 */
function _msptdDetect(sig, fs, minHrHz = HR_MIN / 60) {
  const N = sig.length
  if (N < 4) return { peaks: [], onsets: [] }

  const L      = Math.ceil(N / 2) - 1
  const durn   = N / fs

  // Limit scales to those representing plausible HRs (use_reduced_lms_scales=true)
  // Scale k corresponds to frequency (L/k)/durn Hz; keep where that >= minHrHz
  // → k <= L / (durn * minHrHz)
  const maxScale = Math.min(L, Math.floor(L / (durn * minHrHz)))
  if (maxScale < 1) return { peaks: [], onsets: [] }

  // Detrend (Step 1 of MSPTD)
  const x = _detrend(sig)

  // Build Local Maxima/Minima Scalograms as flat Uint8Arrays [maxScale × N]
  const mMax = new Uint8Array(maxScale * N)
  const mMin = new Uint8Array(maxScale * N)
  for (let k = 1; k <= maxScale; k++) {
    const row = (k - 1) * N
    for (let i = k; i < N - k; i++) {
      const xi = x[i], xL = x[i - k], xR = x[i + k]
      if (xi > xL && xi > xR) mMax[row + i] = 1
      if (xi < xL && xi < xR) mMin[row + i] = 1
    }
  }

  // Step 2: find scale lambda with maximum row-sum (most detections)
  let lambdaMax = 0, lambdaMin = 0, bestMax = 0, bestMin = 0
  for (let k = 0; k < maxScale; k++) {
    const row = k * N
    let sMax = 0, sMin = 0
    for (let i = 0; i < N; i++) { sMax += mMax[row + i]; sMin += mMin[row + i] }
    if (sMax > bestMax) { bestMax = sMax; lambdaMax = k }
    if (sMin > bestMin) { bestMin = sMin; lambdaMin = k }
  }

  // Steps 3–4: collect columns where ALL rows 0..lambda agree (intersection)
  const peaks = [], onsets = []
  for (let i = 0; i < N; i++) {
    let isPk = true, isTr = true
    for (let k = 0; k <= lambdaMax && isPk; k++) { if (!mMax[k * N + i]) isPk = false }
    for (let k = 0; k <= lambdaMin && isTr; k++) { if (!mMin[k * N + i]) isTr = false }
    if (isPk) peaks.push(i)
    if (isTr) onsets.push(i)
  }

  return { peaks, onsets }
}

export default class EEGManager {
  // Public state
  isConnected = false
  bandPower   = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
  heartRate   = 70               // BPM (initialised to resting nominal)
  heartPulse  = 0                // 0–1 oscillator synced to heartRate
  headPose    = { pitch: 0, roll: 0 }  // radians from accelerometer

  onDisconnected = null          // optional callback

  // Display buffers — raw data for live plots (populated only when connected)
  eegChannels   = [[], [], [], []]        // per-channel raw EEG, rolling EEG_DISPLAY_LEN
  accelDisplay  = { x: [], y: [], z: [] } // rolling IMU_DISPLAY_LEN
  gyroDisplay   = { x: [], y: [], z: [] } // rolling IMU_DISPLAY_LEN
  signalQuality = ['poor', 'poor', 'poor', 'poor'] // per EEG channel

  // Monotonically increasing sample counters — never reset by the rolling window
  eegSampleCount  = 0
  ppgSampleCount  = 0
  imuSampleCount  = 0

  // ── Private ─────────────────────────────────────────────────────────────────
  _client    = null
  _eegSub    = null
  _ppgSub    = null
  _accelSub  = null
  _gyroSub   = null

  // EEG
  _eegBuffer = []

  // PPG / heart rate
  _ppgBuffer      = []           // rolling buffer of bandpass-filtered samples
  _ppgStepCount   = 0            // samples since last MSPTD run
  _hpPrevX        = 0            // high-pass: previous raw input
  _hpPrevY        = 0            // high-pass: previous output
  _lpPrevY        = 0            // low-pass: previous output

  // Heart-pulse oscillator
  _heartPhase    = 0
  _lastFrameTime = null

  // Accelerometer (head pose)
  _accSmooth = { x: 0, y: 0, z: 1 }  // starts pointing down (gravity reference)

  // Signal quality update counter
  _sqSampleCount = 0

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Filtered PPG waveform for display — same rolling buffer used by MSPTD. */
  get ppgDisplay() { return this._ppgBuffer }

  /**
   * Connect to a Muse headset via Web Bluetooth and start streaming.
   * Subscribes to EEG, PPG (infrared), and accelerometer data.
   * Requires a user gesture and HTTPS (Web Bluetooth requirement).
   * @returns {Promise<void>}
   */
  async connect() {
    this._client = new MuseClient()
    this._client.enablePpg = true   // must set BEFORE connect()

    await this._client.connect()
    await this._client.start()
    this.isConnected = true

    this._resetState()

    // EEG bands
    this._eegSub = zipSamples(this._client.eegReadings).subscribe((sample) => {
      this._processEEGSample(sample.data)
    })

    // PPG — infrared channel for cleanest cardiac waveform
    this._ppgSub = this._client.ppgReadings.subscribe((reading) => {
      if (reading.ppgChannel === PPG_INFRARED) {
        for (const s of reading.samples) this._processPPGSample(s)
      }
    })

    // IMU — accelerometer for head-tilt estimation
    this._accelSub = this._client.accelerometerData.subscribe((accel) => {
      this._processAccel(accel.samples)
    })

    // IMU — gyroscope
    this._gyroSub = this._client.gyroscopeData.subscribe((gyro) => {
      this._processGyro(gyro.samples)
    })

    // Detect hardware-initiated disconnects
    this._client.connectionStatus.subscribe((connected) => {
      if (!connected && this.isConnected) this._handleDisconnect()
    })
  }

  /**
   * Gracefully disconnect from the Muse headset and reset all state.
   * Fires the onDisconnected callback if set.
   */
  disconnect() {
    this._eegSub?.unsubscribe()
    this._ppgSub?.unsubscribe()
    this._accelSub?.unsubscribe()
    this._gyroSub?.unsubscribe()
    this._client?.disconnect()
    this._handleDisconnect()
  }

  /**
   * Must be called every animation frame from App.update().
   * Advances the heart-pulse oscillator based on elapsed wall-clock time.
   * @param {number} now — performance.now() timestamp (ms)
   */
  update(now) {
    if (this._lastFrameTime === null) {
      this._lastFrameTime = now
    }
    const dt = Math.min((now - this._lastFrameTime) / 1000, 0.1)  // clamp to 100 ms
    this._lastFrameTime = now

    if (this.isConnected) {
      // Advance phase at current heartRate
      this._heartPhase += (this.heartRate / 60) * 2 * Math.PI * dt
      // Shape into a cardiac-like spike: sharp systolic peak, slow diastolic decay
      const s = (Math.sin(this._heartPhase) + 1) / 2
      this.heartPulse = s * s * s              // cube sharpens the peak
    } else {
      this.heartPulse = 0
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  _resetState() {
    this._eegBuffer    = []
    this._ppgBuffer    = []
    this._ppgStepCount = 0
    this._hpPrevX = this._hpPrevY = this._lpPrevY = 0
    this._sqSampleCount = 0
    this.bandPower    = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
    this.heartRate    = 70
    this.heartPulse   = 0
    this.headPose     = { pitch: 0, roll: 0 }
    this.eegChannels   = [[], [], [], []]
    this.accelDisplay  = { x: [], y: [], z: [] }
    this.gyroDisplay   = { x: [], y: [], z: [] }
    this.signalQuality = ['poor', 'poor', 'poor', 'poor']
    this.eegSampleCount = 0
    this.ppgSampleCount = 0
    this.imuSampleCount = 0
  }

  _handleDisconnect() {
    this.isConnected = false
    this._resetState()
    this.onDisconnected?.()
  }

  // ── EEG spectral band powers ──────────────────────────────────────────────

  _processEEGSample(channelData) {
    // Per-channel display buffers (raw µV)
    this.eegSampleCount++
    for (let ch = 0; ch < 4; ch++) {
      const v = channelData[ch]
      if (!isNaN(v)) {
        this.eegChannels[ch].push(v)
        if (this.eegChannels[ch].length > EEG_DISPLAY_LEN) this.eegChannels[ch].shift()
      }
    }

    // Update signal quality ~4× per second (every 64 samples at 256 Hz)
    this._sqSampleCount++
    if (this._sqSampleCount >= 64) {
      this._sqSampleCount = 0
      this._updateSignalQuality()
    }

    // Spectral analysis on averaged signal
    const avg = (channelData[0] + channelData[1] + channelData[2] + channelData[3]) / 4
    if (isNaN(avg)) return

    this._eegBuffer.push(avg)
    if (this._eegBuffer.length >= EEG_BUF_SIZE) {
      this._computeBandPower()
      this._eegBuffer = this._eegBuffer.slice(EEG_BUF_SIZE / 2)  // 50% overlap
    }
  }

  _updateSignalQuality() {
    for (let ch = 0; ch < 4; ch++) {
      const buf = this.eegChannels[ch]
      const n = Math.min(buf.length, SQ_WIN)
      if (n < 10) { this.signalQuality[ch] = 'poor'; continue }
      const slice = buf.slice(-n)
      const mean = slice.reduce((a, b) => a + b, 0) / n
      const rms = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
      if (rms < SQ_LOW)       this.signalQuality[ch] = 'good'
      else if (rms < SQ_HIGH) this.signalQuality[ch] = 'marginal'
      else                    this.signalQuality[ch] = 'poor'
    }
  }

  _computeBandPower() {
    const N = EEG_BUF_SIZE
    const sig = this._eegBuffer.slice(0, N)
    // Hann window to reduce spectral leakage
    const win = sig.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))))

    // DFT for bins 1–50 Hz (1 Hz resolution at 256 Hz / 256 samples)
    const psd = new Float32Array(51)
    for (let k = 1; k <= 50; k++) {
      let re = 0, im = 0
      for (let n = 0; n < N; n++) {
        const angle = (2 * Math.PI * k * n) / N
        re += win[n] * Math.cos(angle)
        im -= win[n] * Math.sin(angle)
      }
      psd[k] = re * re + im * im
    }

    const delta = this._sumBins(psd, 1, 4)
    const theta = this._sumBins(psd, 4, 8)
    const alpha = this._sumBins(psd, 8, 13)
    const beta  = this._sumBins(psd, 13, 30)
    const gamma = this._sumBins(psd, 30, 50)
    const total = delta + theta + alpha + beta + gamma || 1

    this.bandPower = {
      delta: delta / total,
      theta: theta / total,
      alpha: alpha / total,
      beta:  beta  / total,
      gamma: gamma / total,
    }
  }

  _sumBins(psd, lo, hi) {
    let s = 0
    for (let k = lo; k < hi; k++) s += psd[k]
    return s
  }

  // ── PPG / heart rate ──────────────────────────────────────────────────────

  /**
   * Process one raw PPG sample through the filter pipeline, then trigger
   * MSPTDfast v2 batch detection every PPG_RUN_STEP samples.
   *
   * Pipeline:
   *   1. First-order IIR high-pass  @ 0.5 Hz — removes DC & baseline wander
   *   2. First-order IIR low-pass   @ 3.5 Hz — removes motion artifacts
   *   3. Accumulate into rolling 6-second buffer
   *   4. Every ~1 second, run MSPTDfast on the buffer to update heartRate
   */
  _processPPGSample(raw) {
    // 1. High-pass (remove DC & baseline wander)
    const hp = HP_ALPHA * (this._hpPrevY + raw - this._hpPrevX)
    this._hpPrevX = raw
    this._hpPrevY = hp

    // 2. Low-pass (smooth noise)
    const lp = (1 - LP_ALPHA) * this._lpPrevY + LP_ALPHA * hp
    this._lpPrevY = lp

    // Rolling 6-second window
    this.ppgSampleCount++
    this._ppgBuffer.push(lp)
    if (this._ppgBuffer.length > PPG_WIN_SAMP) this._ppgBuffer.shift()

    // Run MSPTDfast every PPG_RUN_STEP new samples once the window is full
    this._ppgStepCount++
    if (this._ppgStepCount >= PPG_RUN_STEP) {
      this._ppgStepCount = 0
      this._runMSPTD()
    }
  }

  /**
   * Run MSPTDfast v2 on the current 6-second PPG buffer.
   * Downsamples to ~20 Hz, detects peaks, corrects back to original fs,
   * then computes heart rate from the median inter-beat interval.
   */
  _runMSPTD() {
    if (this._ppgBuffer.length < PPG_WIN_SAMP) return

    const win = this._ppgBuffer.slice(-PPG_WIN_SAMP)

    // Downsample: simple decimation (bandpass already limits aliasing)
    const ds = []
    for (let i = 0; i < win.length; i += DS_FACTOR) ds.push(win[i])

    // Detect peaks in downsampled signal
    const { peaks: dsPeaks } = _msptdDetect(ds, DS_FS)
    if (dsPeaks.length < 2) return

    // Upsample indices and refine to true local maximum in original-fs window
    const refined = dsPeaks.map(p => {
      const center = p * DS_FACTOR
      const lo = Math.max(0, center - REFINE_TOL)
      const hi = Math.min(win.length - 1, center + REFINE_TOL)
      let maxVal = -Infinity, maxIdx = center
      for (let i = lo; i <= hi; i++) {
        if (win[i] > maxVal) { maxVal = win[i]; maxIdx = i }
      }
      return maxIdx
    })

    // Sort and enforce refractory period (removes duplicates from refinement)
    refined.sort((a, b) => a - b)
    const peaks = [refined[0]]
    for (let i = 1; i < refined.length; i++) {
      if (refined[i] - peaks[peaks.length - 1] >= MIN_PEAK_DIST) peaks.push(refined[i])
    }

    if (peaks.length < 2) return

    // Compute IBIs from all consecutive peak pairs in this window
    const ibis = []
    for (let i = 1; i < peaks.length; i++) {
      const ibi = (peaks[i] - peaks[i - 1]) / PPG_FS
      const hr  = 60 / ibi
      if (hr >= HR_MIN && hr <= HR_MAX) ibis.push(ibi)
    }
    if (ibis.length === 0) return

    // Median IBI → stable heart rate estimate
    const sorted = [...ibis].sort((a, b) => a - b)
    const medIBI = sorted[Math.floor(sorted.length / 2)]
    this.heartRate = Math.round(60 / medIBI)
  }

  // ── IMU / head pose ──────────────────────────────────────────────────────

  /**
   * Derive head tilt angles from the accelerometer gravity vector.
   * Applies exponential low-pass (α=0.08) to reject vibration/jerk.
   *
   * Angles (radians, relative to upright neutral position):
   *   pitch — forward/backward nod   (rotation around X)
   *   roll  — left/right side tilt   (rotation around Z)
   */
  _processAccel(samples) {
    // Average all samples in the reading (3 per packet at 52 Hz)
    let ax = 0, ay = 0, az = 0
    for (const s of samples) { ax += s.x; ay += s.y; az += s.z }
    ax /= samples.length
    ay /= samples.length
    az /= samples.length

    // Push raw average to display buffer
    this.imuSampleCount++
    this.accelDisplay.x.push(ax)
    this.accelDisplay.y.push(ay)
    this.accelDisplay.z.push(az)
    if (this.accelDisplay.x.length > IMU_DISPLAY_LEN) {
      this.accelDisplay.x.shift()
      this.accelDisplay.y.shift()
      this.accelDisplay.z.shift()
    }

    // Exponential moving average — only slow head movements pass through
    this._accSmooth.x = (1 - ACC_ALPHA) * this._accSmooth.x + ACC_ALPHA * ax
    this._accSmooth.y = (1 - ACC_ALPHA) * this._accSmooth.y + ACC_ALPHA * ay
    this._accSmooth.z = (1 - ACC_ALPHA) * this._accSmooth.z + ACC_ALPHA * az

    const { x, y, z } = this._accSmooth
    this.headPose = {
      pitch: Math.atan2(-x, Math.sqrt(y * y + z * z)),
      roll:  Math.atan2(y, z),
    }
  }

  _processGyro(samples) {
    let gx = 0, gy = 0, gz = 0
    for (const s of samples) { gx += s.x; gy += s.y; gz += s.z }
    gx /= samples.length
    gy /= samples.length
    gz /= samples.length

    this.gyroDisplay.x.push(gx)
    this.gyroDisplay.y.push(gy)
    this.gyroDisplay.z.push(gz)
    if (this.gyroDisplay.x.length > IMU_DISPLAY_LEN) {
      this.gyroDisplay.x.shift()
      this.gyroDisplay.y.shift()
      this.gyroDisplay.z.shift()
    }
  }
}
