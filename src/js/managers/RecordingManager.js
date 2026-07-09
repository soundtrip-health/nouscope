/**
 * RecordingManager
 *
 * Captures raw Muse EEG / PPG / IMU packets — plus nouscope's derived metrics
 * (band powers, heart rate, entrainment, MSE, music tempo) — into a JSONL file.
 *
 * Raw sensor records mirror the **native muse-js reading shape** so the files
 * are byte-compatible with the tested `eeg-recorder` analysis pipeline
 * (`eeg-recorder/analysis/utils.py`, `refs/eeg.py`). Those tools key off the
 * packet `index` / `sequenceId` and the per-packet `samples` array to
 * reconstruct the timeline, so we store whole readings rather than decimated
 * per-sample rows.
 *
 * Record types (one JSON object per line):
 *   meta    — { type, startedAt, app, device, deviceInfo, electrodeNames, sampleRates, audioBpm }
 *   eeg     — { type, index, electrode, timestamp, samples:[12 µV] }        @ ~21 packets/s ×4 ch
 *   ppg     — { type, index, ppgChannel, timestamp, samples:[6] }            @ ~11 packets/s ×3 ch
 *   accel   — { type, sequenceId, samples:[{x,y,z}×3] }                      @ ~17 packets/s
 *   gyro    — { type, sequenceId, samples:[{x,y,z}×3] }                      @ ~17 packets/s
 *   bands   — { type, t, delta, theta, alpha, beta, gamma }                  @ ~2  Hz
 *   hr      — { type, t, bpm }                                               @ ~1  Hz
 *   entrain — { type, t, idx }                                               @ ~2  Hz
 *   mse     — { type, t, curve:[…], complexity }                             @ ~0.2 Hz
 *   music   — { type, t, bpm }                                               on track load / BPM change
 *
 * `t` (derived records only) is milliseconds since recording started. Raw
 * sensor records carry the native muse-js `index`/`sequenceId`/`timestamp`
 * fields the analysis tools already understand, so they omit `t`.
 *
 * Persistence — two modes, chosen at start():
 *   • stream  — File System Access API (Chrome/Edge). Lines accumulate in a
 *               small pending buffer, are flushed to a long-lived writable
 *               stream every FLUSH_INTERVAL_MS, and the buffer is cleared each
 *               flush. RAM stays bounded regardless of session length, and data
 *               is streamed to disk incrementally instead of being held until
 *               Stop. The file is finalized on stop().
 *   • memory  — fallback when the API is unavailable. Lines are batched in RAM
 *               and downloaded as a Blob on stop() (legacy behaviour).
 *
 * Pressing ⏺ does not start collecting data — capture is already running, and
 * has been since the headset connected. It starts *saving* it, and the file it
 * writes begins at the start of the captured session, not at the button press.
 * That is what `_backlog` is for: every record produced while capture is active
 * is retained as a serialized line, and `start()` writes the whole backlog to
 * the new file before streaming continues into it. So `t = 0` in the file is
 * always the moment capture began.
 */

// Flush cadence for the streaming path. Short enough that a crash loses at most
// a few seconds of data; long enough that disk writes stay batched and cheap.
const FLUSH_INTERVAL_MS = 4000

// Ceiling on the retained pre-record backlog. Raw packets serialize to roughly
// 30 KB/s, so this holds a bit over half an hour; past that the oldest lines are
// dropped and the saved file simply begins later than the session did. Without a
// cap, an all-day session would grow the backlog until the tab died.
const BACKLOG_MAX_BYTES = 64 * 1024 * 1024

export default class RecordingManager {
  isRecording  = false
  startedAtMs  = 0     // wall-clock ms since epoch at start — for file naming
  sampleCount  = 0     // total JSONL lines recorded (for UI display)

  // Optional live sink: called with every record object as it is produced, so a
  // consumer (e.g. SessionStore, powering the Analysis tab) can build a
  // scrubbable timeline in parallel with — and independent of — the JSONL file.
  // `captureActive` lets records flow to the sink even when not writing a file,
  // so the Analysis tab shows live Muse data (DVR) without an explicit recording.
  onRecord      = null
  captureActive = false

  /**
   * Begin forwarding records to `onRecord` and retaining them in the backlog,
   * independent of disk recording. The epoch stamped here is the session's true
   * t=0 — the origin every derived record's `t` is measured from, and the point
   * a later `start()` makes the file begin at.
   *
   * `resume` re-arms capture after a brief headset dropout without disturbing
   * either the epoch or the backlog, so the session either side of the outage
   * stays one continuous timeline.
   */
  enableCapture({ resume = false } = {}) {
    this.captureActive = true
    if (resume && this._epochPerf) return
    this._epochPerf    = performance.now()
    this._epochMs      = Date.now()
    this.resetCapture()
  }

  /** Stop forwarding records. The backlog is kept — the session is still on screen. */
  disableCapture() {
    this.captureActive = false
  }

  /** Drop the retained backlog (e.g. a saved file replaced the live session). */
  resetCapture() {
    this._backlog        = []
    this._backlogBytes   = 0
    this._backlogTrimmed = false
  }

  _mode        = 'memory' // 'stream' | 'memory'
  _pending     = []       // pre-stringified lines awaiting flush
  _lines       = []       // memory-mode: flushed chunks (joined on stop)
  _epochPerf   = 0        // performance.now() at the start of the captured session
  _epochMs     = 0        // Date.now() at the start of the captured session

  _backlog       = []     // serialized lines produced since capture began
  _backlogBytes  = 0
  _backlogTrimmed = false // true once the cap forced us to drop the oldest lines

  _fileHandle  = null     // FileSystemFileHandle (stream mode)
  _writable    = null     // FileSystemWritableFileStream (stream mode)
  _flushTimer  = null
  _writeChain  = Promise.resolve()  // serializes writes so they never overlap

  /**
   * Begin recording. In stream mode this prompts for a save location (requires
   * a user gesture — call from a click handler). Writes a meta header followed
   * by everything captured since `enableCapture()`, then keeps streaming.
   *
   * @param {object} [meta] — { device, deviceInfo, channels, audioBpm }
   * @returns {Promise<boolean>} true if recording started, false if the user
   *   cancelled the file picker.
   */
  async start(meta = {}) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')

    // Prefer streaming to disk so RAM stays bounded for long sessions.
    if (typeof window !== 'undefined' && window.showSaveFilePicker) {
      try {
        this._fileHandle = await window.showSaveFilePicker({
          suggestedName: `nouscope-${ts}.jsonl`,
          types: [{
            description: 'JSON Lines',
            accept: { 'application/x-ndjson': ['.jsonl'] },
          }],
        })
        this._writable = await this._fileHandle.createWritable()
        this._mode = 'stream'
      } catch (err) {
        // AbortError → user dismissed the picker; treat as "don't record".
        if (err?.name === 'AbortError') return false
        console.warn('File System Access unavailable, recording to memory:', err)
        this._mode = 'memory'
      }
    } else {
      this._mode = 'memory'
    }

    this._lines      = []
    this._writeChain = Promise.resolve()
    this.sampleCount = 0

    // With capture running, the file spans the whole captured session; its epoch
    // is when capture began, not when the button was pressed. Without capture
    // (a saved file is loaded for review), the recording starts here.
    if (!this.captureActive) {
      this._epochPerf = performance.now()
      this._epochMs   = Date.now()
    }
    this.startedAtMs = this._epochMs

    const header = JSON.stringify({
      type: 'meta',
      startedAt: new Date(this.startedAtMs).toISOString(),
      app: 'nouscope',
      device: meta.device ?? null,
      deviceInfo: meta.deviceInfo ?? null,
      electrodeNames: meta.channels ?? ['TP9', 'AF7', 'AF8', 'TP10'],
      sampleRates: { eeg: 256, ppg: 64, imu: 52 },
      audioBpm: meta.audioBpm ?? null,
    })

    // Header first, then everything captured before the button was pressed. The
    // backlog is kept (not spliced out) so a later second recording still starts
    // from the top of the session.
    this._pending = [header, ...this._backlog]
    this.sampleCount = this._pending.length
    this.isRecording = true
    if (this._backlogTrimmed) {
      console.warn(`Recording: pre-record backlog exceeded ${BACKLOG_MAX_BYTES >> 20} MB; the file starts partway into the session.`)
    }

    // Write the header + backlog immediately so the file is valid even if
    // nothing else arrives, then start the periodic flush loop.
    await this._flush()
    if (this._mode === 'stream') {
      this._flushTimer = setInterval(() => { this._flush() }, FLUSH_INTERVAL_MS)
    }
    return true
  }

  /**
   * Stop recording, flush any pending lines, and finalize the file.
   *
   * @returns {Promise<Blob|null>} a JSONL Blob in memory mode (caller triggers
   *   the download), or null in stream mode (the file is already on disk).
   */
  async stop() {
    this.isRecording = false
    if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null }

    // Queue the final batch, then wait for the whole write chain (including any
    // in-flight timer flush) to settle before closing — so no tail is lost.
    await this._flush()

    if (this._mode === 'stream') {
      try { await this._writable?.close() } catch (err) { console.error('Recording close failed:', err) }
      this._writable   = null
      this._fileHandle = null
      return null
    }

    const content = this._lines.join('')
    return new Blob([content], { type: 'application/x-ndjson' })
  }

  /**
   * Length of the data written to the file so far, in ms — which is the elapsed
   * time since capture began, not since the button was pressed, because the
   * backlog put the earlier part of the session in the file too.
   */
  elapsedMs() {
    return this.isRecording ? performance.now() - this._epochPerf : 0
  }

  // ── Raw sensor hooks — store native muse-js readings verbatim ──────────────
  // (cheap no-ops when !isRecording)

  /** @param {{index, electrode, timestamp, samples:number[]}} reading */
  recordEeg(reading) {
    if (!this.isRecording && !this.captureActive) return
    this._push({
      type: 'eeg',
      index: reading.index,
      electrode: reading.electrode,
      timestamp: reading.timestamp,
      samples: reading.samples,
    })
  }

  /** @param {{index, ppgChannel, timestamp, samples:number[]}} reading */
  recordPpg(reading) {
    if (!this.isRecording && !this.captureActive) return
    this._push({
      type: 'ppg',
      index: reading.index,
      ppgChannel: reading.ppgChannel,
      timestamp: reading.timestamp,
      samples: reading.samples,
    })
  }

  /** @param {{sequenceId, samples:{x,y,z}[]}} reading */
  recordAccel(reading) {
    if (!this.isRecording && !this.captureActive) return
    this._push({ type: 'accel', sequenceId: reading.sequenceId, samples: reading.samples })
  }

  /** @param {{sequenceId, samples:{x,y,z}[]}} reading */
  recordGyro(reading) {
    if (!this.isRecording && !this.captureActive) return
    this._push({ type: 'gyro', sequenceId: reading.sequenceId, samples: reading.samples })
  }

  // ── Derived-metric hooks ───────────────────────────────────────────────────

  recordBands(bp) {
    if (!this.isRecording && !this.captureActive) return
    this._push({
      type: 'bands', t: this._t(),
      delta: bp.delta, theta: bp.theta, alpha: bp.alpha, beta: bp.beta, gamma: bp.gamma,
    })
  }

  recordHr(bpm) {
    if (!this.isRecording && !this.captureActive) return
    this._push({ type: 'hr', t: this._t(), bpm })
  }

  recordEntrain(idx) {
    if (!this.isRecording && !this.captureActive) return
    this._push({ type: 'entrain', t: this._t(), idx })
  }

  recordMse(curve, complexity) {
    if (!this.isRecording && !this.captureActive) return
    this._push({
      type: 'mse', t: this._t(),
      curve: Array.from(curve).map(v => +v.toFixed(4)),
      complexity: +complexity.toFixed(4),
    })
  }

  recordMusicTempo(bpm) {
    if (!this.isRecording && !this.captureActive) return
    this._push({ type: 'music', t: this._t(), bpm: +bpm.toFixed(2) })
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _t() {
    return +(performance.now() - this._epochPerf).toFixed(1)
  }

  _push(obj) {
    // Fan out to the live/DVR sink only while capture is active. Gating on
    // captureActive (not just "always") is essential: when a saved file is loaded
    // for review, capture is disabled but the user may still press ⏺ to record a
    // fresh file — those live records must NOT leak into the loaded session's
    // store, whose counter state would mis-place them and corrupt the timeline.
    if (this.captureActive) this.onRecord?.(obj)
    if (!this.isRecording && !this.captureActive) return

    const line = JSON.stringify(obj)
    if (this.isRecording) {
      this._pending.push(line)
      this.sampleCount++
    }
    // The same string goes in both places, so retaining the backlog during a
    // recording costs one array slot per record, not a second copy of the data.
    if (this.captureActive) this._backlogPush(line)
  }

  /** Append to the pre-record backlog, dropping the oldest lines past the cap. */
  _backlogPush(line) {
    this._backlog.push(line)
    this._backlogBytes += line.length + 1
    if (this._backlogBytes <= BACKLOG_MAX_BYTES) return

    let dropped = 0
    while (this._backlogBytes > BACKLOG_MAX_BYTES && dropped < this._backlog.length) {
      this._backlogBytes -= this._backlog[dropped].length + 1
      dropped++
    }
    this._backlog.splice(0, dropped)
    this._backlogTrimmed = true
  }

  /**
   * Flush pending lines: append them to the disk stream (stream mode) or to the
   * in-memory buffer, then clear the pending buffer to free RAM. Writes are
   * appended to a single serialized promise chain so concurrent flushes (timer
   * tick + stop()) never overlap on the writable stream.
   *
   * @returns {Promise} resolves when every queued write (including this one) is done.
   */
  _flush() {
    if (this._pending.length === 0) return this._writeChain

    const chunk = this._pending.join('\n') + '\n'
    this._pending = []   // free RAM immediately; new records accumulate fresh

    this._writeChain = this._writeChain.then(async () => {
      try {
        if (this._mode === 'stream' && this._writable) {
          await this._writable.write(chunk)
        } else {
          this._lines.push(chunk)
        }
      } catch (err) {
        console.error('Recording flush failed:', err)
      }
    })
    return this._writeChain
  }
}
