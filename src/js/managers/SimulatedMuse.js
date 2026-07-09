import { Subject, BehaviorSubject } from 'rxjs'

/**
 * SimulatedMuse — a drop-in stand-in for muse-js `MuseClient`.
 *
 * Emits synthetic EEG / PPG / IMU / telemetry packets in the *native muse-js
 * reading shape*, on the same observable names `EEGManager` subscribes to. That
 * means the entire downstream pipeline runs unchanged: `zipSamples`, band
 * powers, spectrograms, MSPTD heart rate, MSE, entrainment, the JSONL recorder
 * and the SessionStore all see data indistinguishable in form from a headset.
 *
 * The point is to be able to develop and debug the UI with no hardware present,
 * so the signals are chosen to exercise every panel:
 *   • EEG   — 1/f background + a slowly waxing/waning 10 Hz alpha rhythm,
 *             steady theta/beta/gamma, a 2 Hz (120 BPM) beat-locked component
 *             so the entrainment meter has something to lock onto, a slow
 *             baseline drift, and periodic eye-blink artifacts on the frontal
 *             electrodes (AF7/AF8) only.
 *   • PPG   — the raw infrared DC level a real Muse reports (~370 000) with a
 *             cardiac ripple (systolic peak + dicrotic notch), respiratory
 *             baseline sway, and respiratory sinus arrhythmia on the rate.
 *   • IMU   — gravity vector plus a slow head sway; gyro is its derivative.
 *
 * Packets are generated from an absolute sample index rather than from wall
 * clock deltas, so the signal is continuous across timer jitter and a
 * backgrounded tab simply produces a burst of catch-up packets — exactly how a
 * real BLE stream behaves after a stall.
 */

// Native Muse stream rates and packet shapes (samples per packet).
const EEG_FS = 256, EEG_SPP = 12
const PPG_FS = 64,  PPG_SPP = 6
const IMU_FS = 52,  IMU_SPP = 3

const COUNTER_MODULUS = 1 << 16   // muse-js index / sequenceId are 16-bit
const TICK_MS         = 40        // packet-pump cadence (~2 EEG packets per tick)
const TELEMETRY_MS    = 10000     // battery updates, matching the real device

// A tab that has been backgrounded for minutes shouldn't dump an unbounded
// burst of packets into the pipeline on return; cap the catch-up per tick.
const MAX_CATCHUP_PACKETS = 64

// PPG channel indices, matching the device: 0 ambient, 1 infrared, 2 red.
// Only channel 1 carries the cardiac signal anyone downstream reads.
const PPG_AMBIENT_DC  = 397000
const PPG_INFRARED_DC = 370000
const PPG_RED_DC      = 320000

const BLINK_PERIOD_S = 4.7   // eye blinks, roughly every ~5 s
const BLINK_WIDTH_S  = 0.09  // Gaussian half-width of the blink deflection
const BLINK_UV       = 70

/** Per-electrode blink coupling — frontal sensors see the eyes, temporal ones barely do. */
const BLINK_GAIN = [0.12, 1.0, 1.0, 0.12]   // TP9, AF7, AF8, TP10
/** Alpha is a posterior rhythm: strongest at TP9/TP10. */
const ALPHA_GAIN = [1.0, 0.45, 0.45, 1.0]

/** Approximately-Gaussian white noise in [-1, 1]-ish (sum of uniforms). */
function white() {
  return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.7
}

/**
 * Paul Kellet's pink-noise filter — a cheap 1/f source, which is what makes
 * synthetic EEG look like EEG instead of like hiss.
 */
class PinkNoise {
  constructor() { this._b = new Float64Array(7) }
  next() {
    const w = white()
    const b = this._b
    b[0] = 0.99886 * b[0] + w * 0.0555179
    b[1] = 0.99332 * b[1] + w * 0.0750759
    b[2] = 0.96900 * b[2] + w * 0.1538520
    b[3] = 0.86650 * b[3] + w * 0.3104856
    b[4] = 0.55000 * b[4] + w * 0.5329522
    b[5] = -0.7616 * b[5] - w * 0.0168980
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362
    b[6] = w * 0.115926
    return out * 0.11
  }
}

const TAU = Math.PI * 2

export default class SimulatedMuse {
  // ── MuseClient-compatible surface ────────────────────────────────────────
  enablePpg = false
  deviceName = 'MuseS-SIM'

  eegReadings       = new Subject()
  ppgReadings       = new Subject()
  accelerometerData = new Subject()
  gyroscopeData     = new Subject()
  telemetryData     = new Subject()
  connectionStatus  = new BehaviorSubject(false)

  constructor() {
    this._timer = null
    this._epochMs = 0
    this._perf0 = 0

    // Packets emitted so far, per stream — drives both the 16-bit counters and
    // the absolute sample index each packet's samples are synthesized from.
    this._eegPackets = 0
    this._ppgPackets = 0
    this._imuPackets = 0
    this._lastTelemetry = 0

    this._pink = [new PinkNoise(), new PinkNoise(), new PinkNoise(), new PinkNoise()]
    this._ppgPhase = 0   // integrated cardiac phase (rad)
  }

  async connect() {
    this._epochMs = Date.now()
    this._perf0 = performance.now()
    return true
  }

  /** Best-effort device metadata, same shape the real client returns. */
  async deviceInfo() {
    return { ap: 'headset', sp: 'Simulator', tp: 'consumer', hw: '00.0', fw: 'sim', bn: 0 }
  }

  async start() {
    this._eegPackets = 0
    this._ppgPackets = 0
    this._imuPackets = 0
    this._lastTelemetry = 0
    this._ppgPhase = 0
    this._epochMs = Date.now()
    this._perf0 = performance.now()
    this.connectionStatus.next(true)
    this._timer = setInterval(() => this._tick(), TICK_MS)
  }

  /**
   * Stop the packet pump. Deliberately does NOT push `false` onto
   * `connectionStatus`: EEGManager.disconnect() calls this and then runs its own
   * teardown, and a status emission here would run that teardown twice.
   */
  disconnect() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }

  // ── Packet pump ──────────────────────────────────────────────────────────

  _elapsedS() { return (performance.now() - this._perf0) / 1000 }

  _tick() {
    const elapsed = this._elapsedS()
    this._pump(elapsed, EEG_FS, EEG_SPP, '_eegPackets', (n0, ts, p) => this._emitEeg(n0, ts, p))
    this._pump(elapsed, PPG_FS, PPG_SPP, '_ppgPackets', (n0, ts, p) => this._emitPpg(n0, ts, p))
    this._pump(elapsed, IMU_FS, IMU_SPP, '_imuPackets', (n0, ts, p) => this._emitImu(n0, p))

    const nowMs = elapsed * 1000
    if (nowMs - this._lastTelemetry >= TELEMETRY_MS) {
      this._lastTelemetry = nowMs
      // Drain slowly from 86% so the battery indicator has something to show.
      this.telemetryData.next({ batteryLevel: Math.max(5, 86 - elapsed / 600) })
    }
  }

  /** Emit however many whole packets of one stream are due by `elapsed`. */
  _pump(elapsed, fs, spp, counterKey, emit) {
    const due = Math.floor((elapsed * fs) / spp)
    let behind = due - this[counterKey]
    if (behind > MAX_CATCHUP_PACKETS) {
      // Skip the backlog rather than flooding the pipeline; the resulting jump
      // in `index` is exactly the packet loss SessionStore already renders as a gap.
      this[counterKey] = due - MAX_CATCHUP_PACKETS
      behind = MAX_CATCHUP_PACKETS
    }
    for (let i = 0; i < behind; i++) {
      const packet = this[counterKey]++
      const n0 = packet * spp
      emit(n0, this._epochMs + (n0 / fs) * 1000, packet % COUNTER_MODULUS)
    }
  }

  // ── EEG ──────────────────────────────────────────────────────────────────

  /**
   * One 12-sample packet per electrode, all four sharing an `index` and a
   * `timestamp` — `zipSamples` groups electrodes by timestamp, so they must
   * match within a packet and differ between packets.
   */
  _emitEeg(n0, timestamp, index) {
    for (let ch = 0; ch < 4; ch++) {
      const samples = new Array(EEG_SPP)
      for (let i = 0; i < EEG_SPP; i++) samples[i] = this._eegSample(ch, (n0 + i) / EEG_FS)
      this.eegReadings.next({ index, electrode: ch, timestamp, samples })
    }
  }

  /** Synthetic EEG for one electrode at time `t` (seconds), in µV. */
  _eegSample(ch, t) {
    // Alpha waxes and wanes on a ~20 s cycle, out of phase across the head.
    const alphaEnv = 12 * (0.5 + 0.5 * Math.sin(TAU * 0.05 * t + ch)) * ALPHA_GAIN[ch]

    let v = alphaEnv * Math.sin(TAU * 10 * t + ch * 0.7)
    v += 8   * Math.sin(TAU * 6  * t + ch * 1.3)    // theta
    v += 3   * Math.sin(TAU * 20 * t + ch * 0.4)    // beta
    v += 1.5 * Math.sin(TAU * 40 * t + ch * 2.1)    // gamma
    // A 2 Hz component (120 BPM) so the EEG tempogram — and therefore the
    // entrainment index — has a real periodicity to find.
    v += 9   * Math.sin(TAU * 2 * t)
    v += 20  * Math.sin(TAU * 0.02 * t + ch)        // slow baseline drift
    v += 14  * this._pink[ch].next()                // 1/f background

    // Eye blinks: a sharp positive deflection seen mainly at AF7/AF8.
    const sinceBlink = t - Math.round(t / BLINK_PERIOD_S) * BLINK_PERIOD_S
    const g = sinceBlink / BLINK_WIDTH_S
    v += BLINK_UV * BLINK_GAIN[ch] * Math.exp(-g * g)

    return v
  }

  // ── PPG ──────────────────────────────────────────────────────────────────

  /** All three PPG channels, as the device sends them (only ch 1 is read downstream). */
  _emitPpg(n0, timestamp, index) {
    const ir = new Array(PPG_SPP)
    const ambient = new Array(PPG_SPP)
    const red = new Array(PPG_SPP)

    for (let i = 0; i < PPG_SPP; i++) {
      const t = (n0 + i) / PPG_FS
      // Respiratory sinus arrhythmia: heart rate breathes with the ~0.25 Hz cycle.
      const hr = 62 + 4 * Math.sin(TAU * 0.05 * t)
      this._ppgPhase += (TAU * hr) / 60 / PPG_FS

      const p = this._ppgPhase
      // Systolic peak plus a dicrotic notch on the falling edge.
      const pulse = Math.sin(p) + 0.35 * Math.sin(2 * p - 0.9) + 0.12 * Math.sin(3 * p + 0.4)
      const resp = 1200 * Math.sin(TAU * 0.25 * t)   // breathing baseline sway

      ir[i]      = PPG_INFRARED_DC + 900 * pulse + resp + 60 * white()
      red[i]     = PPG_RED_DC      + 600 * pulse + resp * 0.8 + 60 * white()
      ambient[i] = PPG_AMBIENT_DC  + 40 * white()
    }

    this.ppgReadings.next({ index, ppgChannel: 0, timestamp, samples: ambient })
    this.ppgReadings.next({ index, ppgChannel: 1, timestamp, samples: ir })
    this.ppgReadings.next({ index, ppgChannel: 2, timestamp, samples: red })
  }

  // ── IMU ──────────────────────────────────────────────────────────────────

  /** Accelerometer (g) and gyroscope (deg/s) share a sequenceId, as on the device. */
  _emitImu(n0, sequenceId) {
    const accel = new Array(IMU_SPP)
    const gyro = new Array(IMU_SPP)

    for (let i = 0; i < IMU_SPP; i++) {
      const t = (n0 + i) / IMU_FS
      // A slow two-frequency head sway; gravity dominates z as the head is upright.
      const sway = Math.sin(TAU * 0.07 * t)
      const nod  = Math.sin(TAU * 0.11 * t + 1)
      accel[i] = {
        x: 0.043 + 0.03 * sway + 0.002 * white(),
        y: 0.042 + 0.03 * nod  + 0.002 * white(),
        z: 1.012 + 0.01 * sway * nod + 0.002 * white(),
      }
      // Gyro reads the derivative of that sway (deg/s), plus sensor noise.
      gyro[i] = {
        x: -6 * Math.cos(TAU * 0.07 * t) + 0.3 * white(),
        y: -4 * Math.cos(TAU * 0.11 * t + 1) + 0.3 * white(),
        z: -5 * Math.sin(TAU * 0.05 * t) + 0.3 * white(),
      }
    }

    this.accelerometerData.next({ sequenceId, samples: accel })
    this.gyroscopeData.next({ sequenceId, samples: gyro })
  }
}
