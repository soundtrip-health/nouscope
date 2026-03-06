import { MuseClient, zipSamples } from 'muse-js'

// ── Constants ─────────────────────────────────────────────────────────────────

const PPG_FS = 64
const PPG_INFRARED = 1          // ppgChannel 1 = infrared, best cardiac signal
const PPG_BUF_SECS = 6          // seconds of PPG history to keep
const PPG_BUF_MAX = PPG_FS * PPG_BUF_SECS

// Online IIR bandpass (HP 0.5 Hz + LP 3.5 Hz) — covers 30–210 BPM
// First-order high-pass: α = 1 / (1 + 2π·fc/fs)
const HP_ALPHA = 1 / (1 + (2 * Math.PI * 0.5) / PPG_FS)    // ≈ 0.953
// First-order low-pass: α = 2π·fc/fs / (1 + 2π·fc/fs)
const LP_ALPHA = ((2 * Math.PI * 3.5) / PPG_FS) / (1 + (2 * Math.PI * 3.5) / PPG_FS) // ≈ 0.255

// Peak detection
const MIN_PEAK_DIST = Math.round(0.3 * PPG_FS)  // 300 ms min = ~200 BPM max ≈ 19 samples
const LOOKAHEAD = 5             // look-back window for online peak detection
const HR_MIN = 30
const HR_MAX = 200
const IBI_MEDIAN_SIZE = 5       // median filter kernel (must be odd)

// Accelerometer head-pose smoothing
const ACC_ALPHA = 0.08           // low-pass coefficient — keeps only slow head movements

// EEG spectral analysis
const EEG_BUF_SIZE = 256

export default class EEGManager {
  // Public state
  isConnected = false
  bandPower   = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
  heartRate   = 70               // BPM (initialised to resting nominal)
  heartPulse  = 0                // 0–1 oscillator synced to heartRate
  headPose    = { pitch: 0, roll: 0 }  // radians from accelerometer

  onDisconnected = null          // optional callback

  // ── Private ─────────────────────────────────────────────────────────────────
  _client    = null
  _eegSub    = null
  _ppgSub    = null
  _accelSub  = null

  // EEG
  _eegBuffer = []

  // PPG / heart rate
  _ppgBuffer      = []           // ring buffer of bandpass-filtered samples
  _hpPrevX        = 0            // high-pass: previous raw input
  _hpPrevY        = 0            // high-pass: previous output
  _lpPrevY        = 0            // low-pass: previous output
  _ppgCount       = 0            // global sample counter (for peak distance)
  _lastPeakCount  = -MIN_PEAK_DIST
  _ibiHistory     = []           // recent valid IBIs (seconds) for median filter

  // Heart-pulse oscillator
  _heartPhase    = 0
  _lastFrameTime = null

  // Accelerometer (head pose)
  _accSmooth = { x: 0, y: 0, z: 1 }  // starts pointing down (gravity reference)

  // ── Public API ───────────────────────────────────────────────────────────────

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
    this._eegBuffer     = []
    this._ppgBuffer     = []
    this._ppgCount      = 0
    this._lastPeakCount = -MIN_PEAK_DIST
    this._ibiHistory    = []
    this._hpPrevX = this._hpPrevY = this._lpPrevY = 0
    this.bandPower  = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
    this.heartRate  = 70
    this.heartPulse = 0
    this.headPose   = { pitch: 0, roll: 0 }
  }

  _handleDisconnect() {
    this.isConnected = false
    this._resetState()
    this.onDisconnected?.()
  }

  // ── EEG spectral band powers ──────────────────────────────────────────────

  _processEEGSample(channelData) {
    const avg = (channelData[0] + channelData[1] + channelData[2] + channelData[3]) / 4
    if (isNaN(avg)) return

    this._eegBuffer.push(avg)
    if (this._eegBuffer.length >= EEG_BUF_SIZE) {
      this._computeBandPower()
      this._eegBuffer = this._eegBuffer.slice(EEG_BUF_SIZE / 2)  // 50% overlap
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
   * Process one raw PPG sample through the filter pipeline.
   *
   * Pipeline (mirrors utils.py _bandpass_filter_ppg + detect_ppg_peaks):
   *   1. First-order IIR high-pass  @ 0.5 Hz — removes DC & baseline wander
   *   2. First-order IIR low-pass   @ 3.5 Hz — removes motion artifacts
   *   3. Local-maximum peak detection with adaptive threshold
   *   4. Median filter (kernel=5) on inter-beat intervals
   */
  _processPPGSample(raw) {
    // 1. High-pass (detrend baseline)
    const hp = HP_ALPHA * (this._hpPrevY + raw - this._hpPrevX)
    this._hpPrevX = raw
    this._hpPrevY = hp

    // 2. Low-pass (smooth noise)
    const lp = (1 - LP_ALPHA) * this._lpPrevY + LP_ALPHA * hp
    this._lpPrevY = lp

    // Maintain ring buffer
    this._ppgBuffer.push(lp)
    if (this._ppgBuffer.length > PPG_BUF_MAX) {
      this._ppgBuffer.shift()
      this._lastPeakCount--   // keep relative to current buffer tail
    }

    this._ppgCount++

    const bufLen = this._ppgBuffer.length
    if (bufLen < PPG_FS * 2) return   // need at least 2 seconds before detecting

    // 3. Look-back peak detection
    //    We declare a peak at index (bufLen-1-LOOKAHEAD) once LOOKAHEAD newer
    //    samples have arrived, so we can confirm it's a local maximum.
    const peakBufIdx = bufLen - 1 - LOOKAHEAD
    if (peakBufIdx < LOOKAHEAD) return

    const v = this._ppgBuffer[peakBufIdx]

    // Must be strictly greater than nearest 2 neighbours on each side
    if (!(v > this._ppgBuffer[peakBufIdx - 1] &&
          v > this._ppgBuffer[peakBufIdx + 1] &&
          v > this._ppgBuffer[peakBufIdx - 2] &&
          v > this._ppgBuffer[peakBufIdx + 2])) return

    // Adaptive threshold: mean + 0.3σ over the last 4 seconds
    const win4 = this._ppgBuffer.slice(-PPG_FS * 4)
    const mean = win4.reduce((s, x) => s + x, 0) / win4.length
    const std  = Math.sqrt(win4.reduce((s, x) => s + (x - mean) ** 2, 0) / win4.length)
    if (v < mean + 0.3 * std) return

    // Minimum refractory distance from previous peak
    const globalPeakIdx = this._ppgCount - LOOKAHEAD
    if (globalPeakIdx - this._lastPeakCount < MIN_PEAK_DIST) return

    // 4. Valid peak — compute IBI and update HR estimate
    if (this._lastPeakCount > 0) {
      const ibi    = (globalPeakIdx - this._lastPeakCount) / PPG_FS  // seconds
      const instHR = 60 / ibi

      if (instHR >= HR_MIN && instHR <= HR_MAX) {
        this._ibiHistory.push(ibi)
        if (this._ibiHistory.length > IBI_MEDIAN_SIZE) this._ibiHistory.shift()

        // Median filter to reject outlier beats (e.g. from motion artifact)
        if (this._ibiHistory.length >= 3) {
          const sorted = [...this._ibiHistory].sort((a, b) => a - b)
          const medianIBI = sorted[Math.floor(sorted.length / 2)]
          this.heartRate = Math.round(60 / medianIBI)
        }
      }
    }

    this._lastPeakCount = globalPeakIdx
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
}
