/**
 * RecordingManager
 *
 * Captures raw EEG / PPG / IMU samples plus derived band powers, heart rate,
 * entrainment index, and MSE curves into an in-memory JSONL buffer while
 * recording is active. Each line is an independent JSON object; consumers can
 * stream-parse the result.
 *
 * Record types:
 *   meta    — { t, type, startedAt, sampleRates, channels, note? } (header)
 *   eeg     — { t, type, ch:[tp9, af7, af8, tp10] }        @ 256 Hz
 *   ppg     — { t, type, raw }                              @ 64  Hz
 *   accel   — { t, type, x, y, z }                          @ ~52 Hz
 *   gyro    — { t, type, x, y, z }                          @ ~52 Hz
 *   bands   — { t, type, delta, theta, alpha, beta, gamma } @ ~2  Hz
 *   hr      — { t, type, bpm }                              @ ~1  Hz
 *   entrain — { t, type, idx, audio?, eeg? }                @ ~2  Hz
 *   mse     — { t, type, curve:[…] }                        @ ~0.2 Hz
 *
 * t is milliseconds since recording started (performance.now() relative).
 */
export default class RecordingManager {
  isRecording  = false
  startedAtMs  = 0     // wall-clock ms since epoch at start — for file naming
  sampleCount  = 0     // total JSONL lines written (for UI display)

  _lines       = []    // pre-stringified JSONL entries
  _startedPerf = 0     // performance.now() at start

  /**
   * Begin recording. Clears any previous buffer and writes a meta header.
   */
  start() {
    this._lines       = []
    this._startedPerf = performance.now()
    this.startedAtMs  = Date.now()
    this.sampleCount  = 0
    this.isRecording  = true

    this._push({
      t: 0,
      type: 'meta',
      startedAt: new Date(this.startedAtMs).toISOString(),
      sampleRates: { eeg: 256, ppg: 64, imu: 52 },
      channels: ['TP9', 'AF7', 'AF8', 'TP10'],
      app: 'nouscope',
    })
  }

  /**
   * Stop recording and return a JSONL Blob ready for download. The internal
   * buffer is retained until start() is called again so the caller can render
   * the blob without racing the data-producers.
   * @returns {Blob}
   */
  stop() {
    this.isRecording = false
    const content = this._lines.join('\n') + '\n'
    return new Blob([content], { type: 'application/x-ndjson' })
  }

  /** Elapsed wall-clock ms since start(); meaningful only while recording. */
  elapsedMs() {
    return this.isRecording ? performance.now() - this._startedPerf : 0
  }

  // ── Record hooks (cheap no-ops when !isRecording) ──────────────────────────

  recordEeg(ch0, ch1, ch2, ch3) {
    if (!this.isRecording) return
    this._push({ t: this._t(), type: 'eeg', ch: [ch0, ch1, ch2, ch3] })
  }

  recordPpg(raw) {
    if (!this.isRecording) return
    this._push({ t: this._t(), type: 'ppg', raw })
  }

  recordAccel(x, y, z) {
    if (!this.isRecording) return
    this._push({ t: this._t(), type: 'accel', x, y, z })
  }

  recordGyro(x, y, z) {
    if (!this.isRecording) return
    this._push({ t: this._t(), type: 'gyro', x, y, z })
  }

  recordBands(bp) {
    if (!this.isRecording) return
    this._push({
      t: this._t(), type: 'bands',
      delta: bp.delta, theta: bp.theta, alpha: bp.alpha, beta: bp.beta, gamma: bp.gamma,
    })
  }

  recordHr(bpm) {
    if (!this.isRecording) return
    this._push({ t: this._t(), type: 'hr', bpm })
  }

  recordEntrain(idx) {
    if (!this.isRecording) return
    this._push({ t: this._t(), type: 'entrain', idx })
  }

  recordMse(curve, complexity) {
    if (!this.isRecording) return
    this._push({
      t: this._t(),
      type: 'mse',
      curve: Array.from(curve).map(v => +v.toFixed(4)),
      complexity: +complexity.toFixed(4),
    })
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _t() {
    return +(performance.now() - this._startedPerf).toFixed(1)
  }

  _push(obj) {
    this._lines.push(JSON.stringify(obj))
    this.sampleCount++
  }
}
