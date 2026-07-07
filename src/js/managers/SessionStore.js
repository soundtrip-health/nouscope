/**
 * SessionStore — the scrubbable session timeline behind the Analysis tab.
 *
 * One store, one schema, two producers:
 *   • Live/DVR — App feeds it the same record objects RecordingManager emits
 *     (via a `_push` sink), plus spectrogram columns tapped from EEGManager.
 *   • File     — `loadFromText()` parses a saved `nouscope-*.jsonl` into the
 *     same records, then recomputes spectrograms from the reconstructed EEG
 *     (the JSONL carries no spectrogram columns).
 *
 * Raw sensor streams (eeg/ppg/accel/gyro) are placed on a regular per-stream
 * grid using their native 16-bit muse-js `index`/`sequenceId` counters — a
 * direct JS port of `analysis/utils.py` (`_unwrap_counter`, `packets_to_grid`).
 * Each raw stream's t=0 is its own first sample; derived streams (bands/hr/
 * mse/entrain/music) carry `t` (ms since record start → seconds). As in the
 * Python pipeline, raw and derived series may sit a small offset apart.
 *
 * All public time values are in **seconds** from session start.
 */

// Spectrogram bin counts are shared with the renderers (bioRender) so the
// file-path recompute and the analysis blit can never disagree on column length.
import { SPEC_BINS as SPEC_MAIN_BINS, SPEC_LO_BINS } from '../ui/bioRender'

const COUNTER_MODULUS = 1 << 16   // muse-js index/sequenceId counters are 16-bit

const EEG_FS = 256
const PPG_FS = 64
const IMU_FS = 52
const PPG_INFRARED = 1            // ppgChannel we keep (matches utils.py)

// Samples per packet (native muse-js reading shape)
const EEG_SPP   = 12
const PPG_SPP   = 6
const IMU_SPP   = 3

// Min/max mip pyramid (see `GriddedStream.envelope`): each level's bucket groups
// MIP_GROUP buckets from the level below it (level 0 groups raw samples), so a
// window spanning the whole session only has to touch a bounded number of coarse
// buckets instead of every raw sample — the cost that made scrubbing/playing a
// wide analysis window laggy.
const MIP_GROUP       = 8
const MIP_LEVEL_COUNT = 4   // bucket sizes: 8, 64, 512, 4096 raw samples

// Spectrogram recompute (file path) — mirrors EEGManager's display pipeline.
// Bin counts (SPEC_MAIN_BINS=50, SPEC_LO_BINS=76) come from bioRender (imported above).
const SPEC_HOP        = 128            // 128 samples @256 Hz → ~2 columns/s
const SPEC_MAIN_WIN   = 256            // 1 s window, 1–50 Hz @ 1 Hz
const SPEC_LO_WIN     = 2560           // 10 s window, 0.5–8.0 Hz @ 0.1 Hz
const SPEC_LO_F0      = 0.5
const SPEC_LO_DF      = 0.1

/**
 * A single raw stream placed on a regular fs-Hz grid. Backed by one growable
 * Float32Array (sample-major for multi-channel); empty slots stay NaN so gaps
 * are visible downstream, exactly like `packets_to_grid`.
 */
class GriddedStream {
  constructor(fs, nChannels) {
    this.fs = fs
    this.nChannels = nChannels
    this._data = null   // Float32Array length _cap*nChannels, NaN-filled
    this._cap = 0       // capacity in samples
    this.length = 0     // logical sample count (max end written)
    this.seqStart = null
    this.startOffset = 0  // grid samples added to every write (re-anchor after reconnect)

    // Min/max mip pyramid — one Float32Array per level, interleaved [min,max]
    // per (bucket, channel). Built lazily/incrementally in `_syncMips`, only as
    // far as `length` has grown, so ingestion itself pays nothing extra.
    this._mipFactors = []
    this._mip = []       // Float32Array per level, or null until first built
    this._mipCap = []    // buckets allocated, per level
    this._mipBuilt = []  // buckets folded in so far, per level
    let factor = MIP_GROUP
    for (let l = 0; l < MIP_LEVEL_COUNT; l++) {
      this._mipFactors.push(factor)
      this._mip.push(null)
      this._mipCap.push(0)
      this._mipBuilt.push(0)
      factor *= MIP_GROUP
    }
  }

  _ensure(samples) {
    if (samples <= this._cap) return
    let cap = this._cap || Math.max(samples, this.fs * 60)
    while (cap < samples) cap *= 2
    const next = new Float32Array(cap * this.nChannels).fill(NaN)
    if (this._data) next.set(this._data.subarray(0, this._cap * this.nChannels))
    this._data = next
    this._cap = cap
  }

  /** Write `k` samples of one channel starting at grid sample `start` (earlier wins). */
  writeChannelBlock(start, channel, samples) {
    const k = samples.length
    this._ensure(start + k)
    const nc = this.nChannels
    for (let i = 0; i < k; i++) {
      const p = (start + i) * nc + channel
      if (Number.isNaN(this._data[p])) this._data[p] = samples[i]
    }
    if (start + k > this.length) this.length = start + k
  }

  /** Write `k` rows (each length nChannels) starting at grid sample `start` (earlier wins). */
  writeRowBlock(start, rows) {
    const k = rows.length
    this._ensure(start + k)
    const nc = this.nChannels
    for (let i = 0; i < k; i++) {
      const base = (start + i) * nc
      if (!Number.isNaN(this._data[base])) continue  // earlier packet wins on overlap
      const row = rows[i]
      for (let c = 0; c < nc; c++) this._data[base + c] = row[c]
    }
    if (start + k > this.length) this.length = start + k
  }

  durationS() { return this.length / this.fs }

  /**
   * Copy one channel over sample range [s0, s1) (clamped). Returns a Float32Array
   * of length (s1-s0); out-of-range / unwritten slots are NaN.
   */
  channelSlice(channel, s0, s1) {
    const out = new Float32Array(s1 - s0).fill(NaN)
    const lo = Math.max(0, s0)
    const hi = Math.min(this.length, s1)
    const nc = this.nChannels
    for (let s = lo; s < hi; s++) out[s - s0] = this._data[s * nc + channel]
    return out
  }

  _ensureMip(level, buckets) {
    if (buckets <= this._mipCap[level]) return
    let cap = this._mipCap[level] || Math.max(buckets, 1024)
    while (cap < buckets) cap *= 2
    const nc = this.nChannels
    const next = new Float32Array(cap * nc * 2).fill(NaN)
    const prev = this._mip[level]
    if (prev) next.set(prev.subarray(0, this._mipCap[level] * nc * 2))
    this._mip[level] = next
    this._mipCap[level] = cap
  }

  /**
   * Extend every mip level up to the current `length`. Level 0 is folded from
   * raw samples; each level above is folded from `MIP_GROUP` buckets of the
   * level below (not from raw data), so the total build cost across all levels
   * is a small constant multiple of the raw sample count — and since only the
   * newly-arrived tail is processed each call, a per-frame call during live
   * capture or playback is essentially free once the pyramid is caught up.
   */
  _syncMips() {
    const nc = this.nChannels
    let sourceIsRaw = true
    let prevBuckets = this.length
    for (let l = 0; l < this._mipFactors.length; l++) {
      const factor = this._mipFactors[l]
      const targetBuckets = sourceIsRaw
        ? Math.floor(this.length / factor)
        : Math.floor(prevBuckets / MIP_GROUP)
      if (targetBuckets <= this._mipBuilt[l]) break   // nothing new here or in any coarser level

      this._ensureMip(l, targetBuckets)
      const mip = this._mip[l]
      const built = this._mipBuilt[l]

      if (sourceIsRaw) {
        const data = this._data
        for (let b = built; b < targetBuckets; b++) {
          const s0 = b * factor, s1 = s0 + factor
          for (let c = 0; c < nc; c++) {
            let mn = Infinity, mx = -Infinity
            for (let s = s0; s < s1; s++) {
              const v = data[s * nc + c]
              if (Number.isNaN(v)) continue
              if (v < mn) mn = v
              if (v > mx) mx = v
            }
            const idx = (b * nc + c) * 2
            if (mn === Infinity) { mip[idx] = NaN; mip[idx + 1] = NaN } else { mip[idx] = mn; mip[idx + 1] = mx }
          }
        }
      } else {
        const below = this._mip[l - 1]
        for (let b = built; b < targetBuckets; b++) {
          const g0 = b * MIP_GROUP, g1 = g0 + MIP_GROUP
          for (let c = 0; c < nc; c++) {
            let mn = Infinity, mx = -Infinity
            for (let g = g0; g < g1; g++) {
              const idx = (g * nc + c) * 2
              const gmn = below[idx]
              if (Number.isNaN(gmn)) continue
              const gmx = below[idx + 1]
              if (gmn < mn) mn = gmn
              if (gmx > mx) mx = gmx
            }
            const idx = (b * nc + c) * 2
            if (mn === Infinity) { mip[idx] = NaN; mip[idx + 1] = NaN } else { mip[idx] = mn; mip[idx + 1] = mx }
          }
        }
      }

      this._mipBuilt[l] = targetBuckets
      prevBuckets = targetBuckets
      sourceIsRaw = false
    }
  }

  /**
   * Min/max-decimate one channel over [t0, t1) seconds into `outN` buckets —
   * a Float32Array of length outN*2 ([min,max] per bucket), the same contract
   * AnalysisDisplay's `_envelope` expects. Uses the mip pyramid when the window
   * is wide enough that a coarse level still covers it with at least 2 buckets
   * per output column, so cost stays roughly O(outN) instead of O(window·fs)
   * even for an "All" window spanning a long session. Falls back to scanning
   * raw samples directly for anything too narrow for the coarsest levels to
   * usefully resolve (ordinary fixed-window scrubbing).
   */
  envelope(channel, t0, t1, outN) {
    const s0 = Math.max(0, Math.floor(t0 * this.fs))
    const s1 = Math.min(this.length, Math.ceil(t1 * this.fs))
    if (s1 <= s0) return new Float32Array(outN * 2)

    this._syncMips()
    for (let l = this._mipFactors.length - 1; l >= 0; l--) {
      const factor = this._mipFactors[l]
      const bStart = Math.floor(s0 / factor)
      const bEnd = Math.min(this._mipBuilt[l], Math.floor(s1 / factor))
      const M = bEnd - bStart
      if (M >= outN * 2) return this._envelopeFromMip(l, channel, bStart, M, outN)
    }
    return this._envelopeFromRaw(channel, s0, s1, outN)
  }

  _envelopeFromMip(level, channel, bStart, M, outN) {
    const mip = this._mip[level]
    const nc = this.nChannels
    const out = new Float32Array(outN * 2)
    for (let i = 0; i < outN; i++) {
      const a = bStart + Math.floor((i * M) / outN)
      const b = bStart + Math.max(1, Math.floor(((i + 1) * M) / outN))
      let mn = Infinity, mx = -Infinity
      for (let bucket = a; bucket < b; bucket++) {
        const idx = (bucket * nc + channel) * 2
        const bmn = mip[idx]
        if (Number.isNaN(bmn)) continue
        const bmx = mip[idx + 1]
        if (bmn < mn) mn = bmn
        if (bmx > mx) mx = bmx
      }
      if (mn === Infinity) { mn = 0; mx = 0 }
      out[i * 2] = mn
      out[i * 2 + 1] = mx
    }
    return out
  }

  _envelopeFromRaw(channel, s0, s1, outN) {
    const nc = this.nChannels
    const data = this._data
    const M = s1 - s0
    const out = new Float32Array(outN * 2)
    for (let i = 0; i < outN; i++) {
      const a = s0 + Math.floor((i * M) / outN)
      const b = s0 + Math.max(1, Math.floor(((i + 1) * M) / outN))
      let mn = Infinity, mx = -Infinity
      for (let s = a; s < b; s++) {
        const v = data[s * nc + channel]
        if (Number.isNaN(v)) continue
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      if (mn === Infinity) { mn = 0; mx = 0 }
      out[i * 2] = mn
      out[i * 2 + 1] = mx
    }
    return out
  }
}

export default class SessionStore {
  constructor() {
    this.reset()
  }

  reset() {
    this.source = null            // 'live' | 'file'
    this.meta = null
    this._liveEpochPerf = null    // performance.now() at live-capture start
    this._continuing = false      // true while re-anchoring after a reconnect

    this.eeg   = new GriddedStream(EEG_FS, 4)
    this.ppg   = new GriddedStream(PPG_FS, 1)
    this.accel = new GriddedStream(IMU_FS, 3)
    this.gyro  = new GriddedStream(IMU_FS, 3)

    // Per-counter unwrap state: { key: [prevRaw, wraps] }
    this._eegState = {}
    this._ppgState = {}
    this._accelState = {}
    this._gyroState = {}

    // Derived timeseries (sorted by t, seconds)
    this.bands   = []   // { t, delta, theta, alpha, beta, gamma }
    this.hr      = []   // { t, bpm }
    this.entrain = []   // { t, idx }
    this.mse     = []   // { t, curve:Float32Array, complexity }
    this.music   = []   // { t, bpm }

    // Spectrogram columns: { t, col:Float32Array }
    this.spec      = []   // main, 1–50 Hz @ 1 Hz (50 bins)
    this.specLo    = []   // 0.5–8.0 Hz @ 0.1 Hz (76 bins)
    this.specAudio = []   // audio tempogram 0.5–5.0 Hz (live only)

    // Stable band-power scale — running max over the whole session so the
    // Analysis y-axis doesn't jump as the visible window changes (incremental).
    this._bandsMax = 0; this._bandsScanned = 0

    // Recording-gap scan state (see `gaps()`/`_scanGaps()`) — incremental like above.
    this._gapList = []; this._gapScanned = 0; this._gapRunStart = null

    this._empty = true
  }

  isEmpty() { return this._empty }

  /**
   * Stable band-power y-scale: running max over every band record (never per
   * window), so scrubbing/playing doesn't rescale the chart. Floored at 0.2.
   */
  bandsScale() {
    for (let i = this._bandsScanned; i < this.bands.length; i++) {
      const r = this.bands[i]
      this._bandsMax = Math.max(this._bandsMax, r.delta, r.theta, r.alpha, r.beta, r.gamma)
    }
    this._bandsScanned = this.bands.length
    return Math.max(this._bandsMax, 0.2)
  }

  /**
   * Begin a fresh live/DVR capture: reset, mark the source live, and stamp the
   * epoch used for derived-record and spectrogram-column times. Raw streams
   * remain counter-based (t=0 at their first sample ≈ this epoch).
   */
  startLive() {
    this.reset()
    this.source = 'live'
    this._liveEpochPerf = performance.now()
  }

  /**
   * Resume live capture after a brief disconnect/reconnect WITHOUT discarding the
   * session already captured (the disconnect handler keeps it for scrubbing). The
   * wall-clock epoch is preserved so derived-record and column times stay
   * continuous; each raw stream re-anchors on its next packet (a NaN gap spans
   * the outage) and counter state is cleared so the fresh BT session's 16-bit
   * counters start clean regardless of whether the device counter reset. Falls
   * back to a fresh session when there is nothing to continue.
   */
  continueLive() {
    if (this.source !== 'live' || this._empty || this._liveEpochPerf == null) {
      this.startLive()
      return
    }
    this._continuing = true
    for (const s of [this.eeg, this.ppg, this.accel, this.gyro]) s.seqStart = null
    this._eegState = {}; this._ppgState = {}; this._accelState = {}; this._gyroState = {}
  }

  /** Seconds since live capture began (for timestamping tapped columns). */
  liveElapsed() {
    return this._liveEpochPerf == null ? 0 : (performance.now() - this._liveEpochPerf) / 1000
  }

  /** Time (s) for a derived record: live → real clock; file → the record's own t. */
  _t(recMs) {
    return this.source === 'live' && this._liveEpochPerf != null
      ? (performance.now() - this._liveEpochPerf) / 1000
      : recMs / 1000
  }

  /** Whole-session duration in seconds (max across every stream). */
  duration() {
    let d = Math.max(
      this.eeg.durationS(), this.ppg.durationS(),
      this.accel.durationS(), this.gyro.durationS(),
    )
    for (const arr of [this.bands, this.hr, this.entrain, this.mse, this.music])
      if (arr.length) d = Math.max(d, arr[arr.length - 1].t)
    for (const arr of [this.spec, this.specLo, this.specAudio])
      if (arr.length) d = Math.max(d, arr[arr.length - 1].t)
    return d
  }

  // ── Ingestion (shared by live + file) ───────────────────────────────────────

  _unwrap(state, key, rawValue) {
    const prev = state[key]
    const wraps = prev === undefined
      ? 0
      : prev[1] + (prev[0] - rawValue > COUNTER_MODULUS / 2 ? 1 : 0)
    state[key] = [rawValue, wraps]
    return rawValue + wraps * COUNTER_MODULUS
  }

  /** Ingest one JSONL record object (from the live sink or the file parser). */
  ingest(r) {
    const tp = r?.type
    if (!tp) return
    this._empty = false

    switch (tp) {
      case 'meta': {
        this.meta = r
        break
      }
      case 'eeg': {
        // Only the 4 headband electrodes are gridded; muse-js (muse3 fork) also
        // emits FPz/AUX (electrode index ≥ 4), which would otherwise write past
        // its row and corrupt channel 0 of the next sample. Ignore them.
        if (r.electrode < 0 || r.electrode >= this.eeg.nChannels) break
        const idx = this._unwrap(this._eegState, r.electrode, r.index)
        this._anchorStream(this.eeg, idx, EEG_FS)
        const start = (idx - this.eeg.seqStart) * EEG_SPP + this.eeg.startOffset
        if (start >= 0) this.eeg.writeChannelBlock(start, r.electrode, r.samples)
        break
      }
      case 'ppg': {
        if (r.ppgChannel !== PPG_INFRARED) break
        const idx = this._unwrap(this._ppgState, r.ppgChannel, r.index)
        this._anchorStream(this.ppg, idx, PPG_FS)
        const start = (idx - this.ppg.seqStart) * PPG_SPP + this.ppg.startOffset
        if (start >= 0) this.ppg.writeChannelBlock(start, 0, r.samples)
        break
      }
      case 'accel':
        this._ingestImu(this.accel, this._accelState, r)
        break
      case 'gyro':
        this._ingestImu(this.gyro, this._gyroState, r)
        break
      case 'bands':
        this.bands.push({ t: this._t(r.t), delta: r.delta, theta: r.theta, alpha: r.alpha, beta: r.beta, gamma: r.gamma })
        break
      case 'hr':
        this.hr.push({ t: this._t(r.t), bpm: r.bpm })
        break
      case 'entrain':
        this.entrain.push({ t: this._t(r.t), idx: r.idx })
        break
      case 'mse':
        this.mse.push({ t: this._t(r.t), curve: Float32Array.from(r.curve), complexity: r.complexity })
        break
      case 'music':
        this.music.push({ t: this._t(r.t), bpm: r.bpm })
        break
    }
  }

  _ingestImu(stream, state, r) {
    const idx = this._unwrap(state, 0, r.sequenceId)
    this._anchorStream(stream, idx, IMU_FS)
    const start = (idx - stream.seqStart) * IMU_SPP + stream.startOffset
    if (start < 0) return
    const rows = r.samples.map(s => [s.x, s.y, s.z])
    stream.writeRowBlock(start, rows)
  }

  /**
   * Fix a raw stream's grid origin on its first packet: t=0 at the first sample
   * for a fresh session, or the current elapsed time when re-anchoring after a
   * reconnect (`continueLive`) so new data appends after the kept session with a
   * NaN gap spanning the outage. Idempotent once `seqStart` is set.
   */
  _anchorStream(stream, idx, fs) {
    if (stream.seqStart !== null) return
    stream.seqStart = idx
    stream.startOffset = this._continuing ? Math.round(this.liveElapsed() * fs) : 0
  }

  /**
   * Add a live spectrogram column tapped from EEGManager / EntrainmentManager.
   * @param {'main'|'lo'|'audio'} kind
   * @param {number} tSeconds
   * @param {ArrayLike<number>} col — copied into a Float32Array
   */
  addSpecColumn(kind, tSeconds, col) {
    const target = kind === 'main' ? this.spec : kind === 'lo' ? this.specLo : this.specAudio
    target.push({ t: tSeconds, col: Float32Array.from(col) })
    this._empty = false
  }

  // ── File loading ────────────────────────────────────────────────────────────

  /**
   * Parse a saved JSONL recording (whole-file text) into this store, then
   * recompute spectrograms from the reconstructed EEG. Resets the store first.
   * @returns {{records:number, duration:number}}
   */
  loadFromText(text) {
    this.reset()
    this.source = 'file'
    let records = 0
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      let obj
      try { obj = JSON.parse(s) } catch { continue }
      this.ingest(obj)
      records++
    }
    this.computeSpectrograms()
    return { records, duration: this.duration() }
  }

  /**
   * Recompute main + low spectrograms from the gridded EEG. Called after a file
   * load, and after a live recording stops (the JSONL/live stream carries no
   * spectrogram columns — only the raw EEG they derive from). The live audio
   * tempogram, captured separately, is left untouched.
   */
  computeSpectrograms() {
    if (this.eeg.length === 0) return
    const avg = this._eegQualityAverage()          // Float32Array, NaN where all channels missing
    this.spec   = this._stft(avg, SPEC_MAIN_WIN, SPEC_MAIN_BINS, (b) => b + 1)          // 1..50 Hz
    this.specLo = this._stft(avg, SPEC_LO_WIN,  SPEC_LO_BINS,  (b) => SPEC_LO_F0 + b * SPEC_LO_DF)  // 0.5..8 Hz
  }

  /**
   * Quality-weighted NaN-aware channel average of the gridded EEG, mirroring the
   * live EEGManager spectrogram path (good=1.0, marginal=0.5, poor=0.0) so a
   * railing/artifact channel doesn't smear the recomputed spectrogram the way the
   * live view never showed it. Weights come from each channel's whole-signal RMS
   * (after mean subtraction), using the same thresholds as `qualityAt`
   * (good<50, marginal<100 µV). If every channel is poor, falls back to an
   * equal-weight mean so something is still shown.
   */
  _eegQualityAverage() {
    const n = this.eeg.length
    const nc = this.eeg.nChannels
    const data = this.eeg._data

    // Per-channel quality weight from whole-signal RMS.
    const w = new Float32Array(nc)
    let wsum = 0
    for (let c = 0; c < nc; c++) {
      let sum = 0, sq = 0, cnt = 0
      for (let s = 0; s < n; s++) {
        const v = data[s * nc + c]
        if (Number.isNaN(v)) continue
        sum += v; sq += v * v; cnt++
      }
      if (!cnt) { w[c] = 0; continue }
      const mean = sum / cnt
      const rms = Math.sqrt(Math.max(0, sq / cnt - mean * mean))
      w[c] = rms < 50 ? 1 : rms < 100 ? 0.5 : 0
      wsum += w[c]
    }
    const useQuality = wsum > 0   // all-poor → equal-weight fallback

    const out = new Float32Array(n)
    for (let s = 0; s < n; s++) {
      let sum = 0, ws = 0
      for (let c = 0; c < nc; c++) {
        const v = data[s * nc + c]
        if (Number.isNaN(v)) continue
        const cw = useQuality ? w[c] : 1
        sum += v * cw; ws += cw
      }
      out[s] = ws ? sum / ws : NaN
    }
    return out
  }

  /**
   * Sliding Hann-DFT of a 1-D signal → spectrogram columns of log₁₀ power.
   * Windows containing any NaN emit an all-NaN column (a visible gap).
   * @param {Float32Array} sig
   * @param {number} win — window length in samples
   * @param {number} bins — number of frequency bins
   * @param {(bin:number)=>number} freqOf — Hz for bin index
   * @returns {{t:number, col:Float32Array}[]}
   */
  _stft(sig, win, bins, freqOf) {
    const cols = []
    const hann = new Float32Array(win)
    for (let n = 0; n < win; n++) hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (win - 1))
    // Precompute cos/sin kernels per bin.
    const cos = [], sin = []
    for (let b = 0; b < bins; b++) {
      const f = freqOf(b)
      const kc = new Float32Array(win), ks = new Float32Array(win)
      for (let n = 0; n < win; n++) {
        const ang = (-2 * Math.PI * f * n) / EEG_FS
        kc[n] = Math.cos(ang) * hann[n]
        ks[n] = Math.sin(ang) * hann[n]
      }
      cos.push(kc); sin.push(ks)
    }
    for (let start = 0; start + win <= sig.length; start += SPEC_HOP) {
      const col = new Float32Array(bins)
      let hasNaN = false
      for (let n = 0; n < win && !hasNaN; n++) if (Number.isNaN(sig[start + n])) hasNaN = true
      if (hasNaN) {
        col.fill(NaN)
      } else {
        for (let b = 0; b < bins; b++) {
          let re = 0, im = 0
          const kc = cos[b], ks = sin[b]
          for (let n = 0; n < win; n++) { const v = sig[start + n]; re += v * kc[n]; im += v * ks[n] }
          col[b] = Math.log10(re * re + im * im + 1e-10)
        }
      }
      // Column time = window centre, in seconds.
      cols.push({ t: (start + win / 2) / EEG_FS, col })
    }
    return cols
  }

  // ── Queries (used by AnalysisDisplay) ────────────────────────────────────────

  /**
   * PPG channel slice over [t0, t1] seconds. EEG/IMU go through
   * `GriddedStream.envelope` instead (mip-backed decimation); PPG keeps a raw
   * slice because its detrend pass needs contiguous samples — see
   * `AnalysisDisplay._ppgSignal`.
   */
  rangePPG(t0, t1) {
    const s0 = Math.floor(t0 * PPG_FS)
    const s1 = Math.ceil(t1 * PPG_FS)
    return { fs: PPG_FS, s0, data: this.ppg.channelSlice(0, s0, s1) }
  }

  /** Spectrogram columns whose time falls in [t0, t1]. */
  specColumns(kind, t0, t1) {
    const arr = kind === 'main' ? this.spec : kind === 'lo' ? this.specLo : this.specAudio
    if (!arr.length) return []
    // arr is sorted by t (grows unbounded). Binary-search the first index with
    // t >= t0, then walk to t1 — cost scales with the window, not the session.
    let lo = 0, hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid].t < t0) lo = mid + 1
      else hi = mid
    }
    const out = []
    for (let i = lo; i < arr.length && arr[i].t <= t1; i++) out.push(arr[i])
    return out
  }

  /** Most recent derived record at or before time t (step/hold); null if none. */
  sampleAt(name, t) {
    const arr = this[name]
    if (!arr || !arr.length) return null
    // Binary search for the last entry with entry.t <= t.
    let lo = 0, hi = arr.length - 1, ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid].t <= t) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return ans >= 0 ? arr[ans] : null
  }

  /**
   * Per-channel signal quality at time t: RMS (after mean subtraction) over the
   * preceding 1 s of EEG. Mirrors EEGManager thresholds (good<50, marginal<100).
   * @returns {('good'|'marginal'|'poor')[]}
   */
  qualityAt(t) {
    // Clamp to the EEG grid end: the follow cursor (epoch-based duration) can sit
    // slightly past the counter-based EEG data, which would otherwise read an
    // all-NaN window and report 'poor'. Always assess the last available 1 s ≤ t.
    const s1 = Math.min(this.eeg.length, Math.floor(t * EEG_FS))
    const s0 = Math.max(0, s1 - EEG_FS)
    const q = []
    for (let c = 0; c < 4; c++) {
      const slice = this.eeg.channelSlice(c, s0, s1)
      let sum = 0, cnt = 0
      for (const v of slice) if (!Number.isNaN(v)) { sum += v; cnt++ }
      if (!cnt) { q.push('poor'); continue }
      const mean = sum / cnt
      let sq = 0
      for (const v of slice) if (!Number.isNaN(v)) sq += (v - mean) * (v - mean)
      const rms = Math.sqrt(sq / cnt)
      q.push(rms < 50 ? 'good' : rms < 100 ? 'marginal' : 'poor')
    }
    return q
  }

  /**
   * Per-channel signal quality sampled at `outN` evenly-spaced points across
   * the whole session, for the scrub-track ribbon. Returns one array per EEG
   * channel (TP9, AF7, AF8, TP10 — the same order as `EEG_OFFSETS`/`EEG_TOKENS`
   * everywhere else) rather than collapsing to a single worst-channel value —
   * a single bad electrode should read as "one bad electrode", not as "the
   * whole signal dropped out".
   * @returns {('good'|'marginal'|'poor')[][]} 4 arrays, each length `outN`
   */
  qualityRibbon(outN) {
    const dur = this.duration()
    const out = [0, 1, 2, 3].map(() => new Array(outN).fill('poor'))
    if (dur <= 0) return out
    for (let i = 0; i < outN; i++) {
      const t = (dur * (i + 0.5)) / outN
      const q = this.qualityAt(t)
      for (let c = 0; c < 4; c++) out[c][i] = q[c]
    }
    return out
  }

  /**
   * Contiguous spans (seconds) where every EEG channel is simultaneously
   * unwritten (NaN) — a real dropout (BT disconnect/reconnect), as opposed to
   * one noisy/railing channel (`qualityAt` already covers that). Scanned
   * incrementally from `_gapScanned` forward, same pattern as `bandsScale()`,
   * so cost stays proportional to new samples, not session length.
   * @returns {{t0:number, t1:number}[]}
   */
  gaps() {
    this._scanGaps()
    return this._gapList
  }

  _scanGaps() {
    const nc = this.eeg.nChannels
    const data = this.eeg._data
    const fs = this.eeg.fs
    const n = this.eeg.length
    const minRunSamples = fs   // ignore dropouts shorter than ~1 s

    let s = this._gapScanned
    let runStart = this._gapRunStart
    for (; s < n; s++) {
      let allNaN = true
      for (let c = 0; c < nc; c++) {
        if (!Number.isNaN(data[s * nc + c])) { allNaN = false; break }
      }
      if (allNaN) {
        if (runStart === null) runStart = s
      } else if (runStart !== null) {
        if (s - runStart >= minRunSamples) this._gapList.push({ t0: runStart / fs, t1: s / fs })
        runStart = null
      }
    }
    this._gapScanned = n
    this._gapRunStart = runStart   // may still be open at the tail (live growing)
  }
}
