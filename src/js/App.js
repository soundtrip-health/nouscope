import BPMManager from './managers/BPMManager'
import AudioManager from './managers/AudioManager'
import EEGManager from './managers/EEGManager'
import EntrainmentManager from './managers/EntrainmentManager'
import ComplexityManager from './managers/ComplexityManager'
import RecordingManager from './managers/RecordingManager'
import SessionStore from './managers/SessionStore'
import TrackManager from './ui/TrackManager'
import Scrubber from './ui/Scrubber'

/**
 * App — top-level orchestrator.
 *
 * A Muse EEG/PPG/IMU biometric visualizer. There is one data view, and it is
 * always the scrubbable one: connecting a headset starts an always-on capture
 * into a `SessionStore`, and `AnalysisDisplay` draws that store at whatever time
 * the `Scrubber`'s playhead sits at. Parked at the leading edge it behaves as a
 * live monitor; dragged backwards it replays the session so far. Loading a saved
 * `.jsonl` fills the same store and drives the same panels.
 *
 * Audio playback is optional — loading a local file enables the neural-entrainment
 * analysis (music tempo vs. EEG tempogram). There is no 3D scene.
 */
export default class App {
  //Managers
  static audioManager = null
  static bpmManager = null
  static eegManager = null
  static entrainmentManager = null
  static complexityManager = null
  static recordingManager = null
  static sessionStore = null
  static trackManager = null

  constructor() {
    // Managers first (no DOM) — the live track's header, created in
    // _setupAnalysis, is what the DOM wiring below (_wireLiveControls) needs,
    // and it in turn needs App.recordingManager to already exist.
    App.eegManager = new EEGManager()
    App.complexityManager = new ComplexityManager()
    App.recordingManager = new RecordingManager()
    this._setupSimulator()

    this._setupAnalysis()      // sessionStore, track stack, master scrubber, live track (+ its header DOM)
    this._wireLiveControls()   // connect/battery/record/pause/mic/audio-upload, within the live track's header

    // Start the update loop immediately so EEG/bio plots work before (or without) audio.
    this.update()

    if (this._autoSim) this._connectEEG(true)
  }

  /** Lazily create the audio + entrainment managers (idempotent). */
  _ensureAudioInfra() {
    if (!App.audioManager) App.audioManager = new AudioManager()
    if (!App.entrainmentManager) App.entrainmentManager = new EntrainmentManager()
  }

  /**
   * Load a local audio file as the (looping) buffer source, detect its BPM, and
   * play it. Replaces any current source, including live-mic input.
   * @param {File} file — audio File from the upload input
   */
  async _loadAudioFile(file) {
    this._ensureAudioInfra()
    try {
      await App.audioManager.loadAudioBuffer(file)
    } catch (err) {
      console.error('Audio load failed:', err)
      return
    }

    if (!App.bpmManager) App.bpmManager = new BPMManager()
    await App.bpmManager.detectBPM(App.audioManager.audio.buffer)

    App.audioManager.play()
    this._setupPauseBtn()
    this._updateMicButton()
  }

  /** Toggle live microphone input as the (muted, analysis-only) audio source. */
  async _toggleMic() {
    this._ensureAudioInfra()
    const am = App.audioManager

    if (am.isMic) {
      am.stopMic()
    } else {
      this._micBtn.disabled = true
      try {
        await am.startMic()
      } catch (err) {
        // Permission denied or no device — leave the current source untouched.
        console.error('Microphone access failed:', err)
        this._micBtn.disabled = false
        return
      }
      this._micBtn.disabled = false
      // Live input can't be paused — hide the buffer pause button while mic is on.
      if (this._pauseBtn) this._pauseBtn.hidden = true
    }
    this._updateMicButton()
  }

  /** Reflect the current mic state in the mic button + pause button visibility. */
  _updateMicButton() {
    if (!this._micBtn) return
    const active = !!App.audioManager?.isMic
    this._micBtn.classList.toggle('active', active)
    this._micBtn.title = active ? 'Stop microphone input' : 'Use microphone as audio source'
    // Restore the pause button when a buffer source is (again) active.
    if (!active && this._pauseBtn && App.audioManager?.source === 'buffer') {
      this._pauseBtn.hidden = false
    }
  }

  /**
   * Wire every control that lives in the live track's header: EEG connect/
   * battery/heart-rate, record, pause, mic, and audio-upload. Runs once,
   * after `_setupAnalysis` has created the live track (and cloned
   * `#track-live-controls-template` into its header) — see the constructor.
   */
  _wireLiveControls() {
    const root = App.trackManager.liveTrack.controlsEl

    const btn         = root.querySelector('.track-eeg-connect')
    const batteryEl   = root.querySelector('.eeg-battery')
    const batteryFill = batteryEl.querySelector('.battery-fill')
    this._hrDisplay    = root.querySelector('.track-heart-rate')
    this._recordBtn    = root.querySelector('.track-record-btn')
    this._recordTimeEl = root.querySelector('.track-record-time')
    this._pauseBtn     = root.querySelector('.track-pause-btn')
    this._micBtn       = root.querySelector('.track-mic-btn')
    const audioInput  = root.querySelector('.track-audio-upload')

    const updateBattery = (level) => {
      // level: 0–100 or null (disconnected)
      // Vertical battery: fill grows upward inside body (body: y=2.5, height=19, inner max=17)
      const maxH    = 17
      const fillH   = level != null ? Math.round(maxH * level / 100) : 0
      batteryFill.setAttribute('height', fillH)
      batteryFill.setAttribute('y', (21 - fillH).toFixed(1))
      batteryEl.dataset.level = level != null ? level : ''
      batteryEl.title = level != null ? `Battery: ${level}%` : 'Battery'
      // Color: green ≥50, yellow 20–49, red <20, gray when disconnected
      batteryEl.dataset.state = level == null ? 'off'
        : level >= 50 ? 'good'
        : level >= 20 ? 'warn'
        : 'low'
    }
    updateBattery(null)

    App.eegManager.onBatteryLevel = (level) => updateBattery(level)

    App.eegManager.onDisconnected = () => {
      btn.textContent = 'Connect EEG'
      btn.disabled = false
      updateBattery(null)
      // Keep it visible/clickable while a recording is in flight — otherwise a
      // disconnect (BT dropout, or just clicking "Disconnect EEG" mid-recording)
      // hides the only way to stop and download it until the user reconnects.
      if (this._recordBtn && !App.recordingManager?.isRecording) this._recordBtn.hidden = true
      // Stop feeding the store, but keep the captured session on screen: the
      // panel stays up so the user can scrub back through what was recorded.
      App.recordingManager?.disableCapture()
      this._scrubber?.stopFollowing()
      // Hide the whole multi-track panel only if there's genuinely nothing to
      // review anywhere — a loaded file track should stay up even if the live
      // track never captured anything.
      if (App.trackManager.tracks.every(t => t.store.isEmpty())) this._hidePanel()
    }

    this._connectBtn = btn
    btn.addEventListener('click', () => {
      if (App.eegManager.isConnected) App.eegManager.disconnect()
      else this._connectEEG(this._simulate)
    })

    this._recordBtn.addEventListener('click', async () => {
      const rm = App.recordingManager
      if (rm.isRecording) {
        this._recordBtn.disabled = true
        const blob = await rm.stop()
        // Stream mode writes straight to disk and returns null; memory-mode
        // fallback returns a Blob the browser must download.
        if (blob) this._downloadRecording(blob, rm.startedAtMs)
        this._recordBtn.disabled = false
        this._recordBtn.classList.remove('active')
        this._recordBtn.title = 'Record raw data to JSONL'
        this._recordTimeEl.hidden = true
        // Catch up on a hide the disconnect handler deferred while this recording
        // was in flight (see onDisconnected above).
        if (!App.eegManager?.isConnected) this._recordBtn.hidden = true
      } else {
        const eeg = App.eegManager
        const started = await rm.start({
          device:     eeg?.deviceName,
          deviceInfo: eeg?.deviceInfo,
          channels:   ['TP9', 'AF7', 'AF8', 'TP10'],
          audioBpm:   App.bpmManager?.bpmValue || null,
        })
        if (!started) return   // user cancelled the save-file picker
        this._recordBtn.classList.add('active')
        this._recordBtn.title = 'Stop recording'
        this._recordTimeEl.hidden = false
      }
    })

    this._pauseBtn.addEventListener('click', () => {
      if (App.audioManager.isPlaying) {
        App.audioManager.pause()
        this._pauseBtn.textContent = '▶'
      } else {
        App.audioManager.play()
        this._pauseBtn.textContent = '⏸'
      }
    })

    this._micBtn.addEventListener('click', () => this._toggleMic())

    // Audio file upload: loads (or replaces) the buffer audio source.
    audioInput.addEventListener('change', (e) => {
      const file = e.target.files[0]
      if (!file) return
      e.target.value = '' // allow re-selecting the same file
      this._loadAudioFile(file)
    })
  }

  /**
   * The data simulator is a developer option with no UI: `?sim` in the URL makes
   * `Connect EEG` stream synthetic Muse packets through the real pipeline instead
   * of talking to Web Bluetooth, which is what makes the bio panels developable
   * and debuggable without a headset. `?sim=auto` connects on load — handy for
   * screenshots and automated checks, and safe because the simulator needs no
   * user gesture.
   */
  _setupSimulator() {
    const param = new URLSearchParams(location.search).get('sim')
    this._simulate = param !== null
    // Deferred to the end of the constructor: _connectEEG needs the recording
    // manager and analysis wiring that _setupAnalysis/_wireLiveControls install.
    this._autoSim = param === 'auto'
  }

  /**
   * Connect the EEG pipeline to a real headset or to the simulator, then bring
   * up the live data view and start the always-on capture that backs the
   * timeline.
   * @param {boolean} simulate
   */
  async _connectEEG(simulate) {
    const btn = this._connectBtn
    btn.textContent = 'Connecting...'
    btn.disabled = true
    try {
      await App.eegManager.connect({ simulate })
    } catch (err) {
      console.error('EEG connect failed:', err)
      btn.textContent = 'Connect EEG'
      btn.disabled = false
      return
    }
    btn.textContent = simulate ? 'Disconnect Sim' : 'Disconnect EEG'
    btn.disabled = false
    if (this._recordBtn) this._recordBtn.hidden = false

    // Begin the always-on capture into the SessionStore. Nothing is written to
    // disk yet — this is what the panels draw from, and what ⏺ later flushes.
    this._startLiveCapture()
    this._showPanel({ follow: true })
  }

  /** Bring up the data panel and start the scrubber over the current store. */
  _showPanel({ follow = false } = {}) {
    document.body.classList.add('analysis-mode')
    this._analysisPanel.hidden = false
    App.trackManager.resizeAll()
    this._scrubber.setActive(true, follow ? { follow: true } : { atStart: true })
    this._scrubber.resize()   // #scrubber just became visible; size the ribbon canvas now
  }

  _hidePanel() {
    document.body.classList.remove('analysis-mode')
    this._analysisPanel.hidden = true
    this._scrubber.setActive(false)
  }

  /** Wire the data panel: session store, track stack, scrubber, recording file load. */
  _setupAnalysis() {
    App.sessionStore = new SessionStore()
    // Every produced record flows into the scrubbable timeline as it is recorded.
    App.recordingManager.onRecord = (obj) => App.sessionStore.ingest(obj)

    this._analysisPanel = document.getElementById('analysis-panel')

    // Master scrubber: renders every track (live + any loaded files) each frame,
    // each at its own effective cursor (masterCursor + offset, or its own free-
    // running cursor when unlinked — see Track).
    this._scrubber = new Scrubber((cursor) => {
      App.trackManager.renderAll(cursor)
      App.trackManager.renderAllTimelines(cursor)
    })
    this._scrubber.attach()

    App.trackManager = new TrackManager(this._analysisPanel, {
      getMasterDuration: () => this._scrubber.getDuration(),
      seekMaster: (t) => this._scrubber.seek(t),
      markDirty: () => this._scrubber.refresh(),
    })
    this._scrubber.setDurationSource(() => App.trackManager.maxDuration())
    // "● LIVE" follows the live track's own leading edge specifically — not
    // just whichever track happens to be longest.
    this._scrubber.setLiveDurationSource(() => {
      const lt = App.trackManager.liveTrack
      return lt && lt.store.source === 'live' ? lt.duration() : null
    })
    this._scrubber.setFocusedTrackSource(() => App.trackManager.focusedTrack)

    const liveTrack = App.trackManager.addLiveTrack(App.sessionStore)
    this._analysisDisplay = liveTrack.display   // alias kept for the single-track code paths below

    const recInput = document.getElementById('recording-upload')
    recInput.addEventListener('change', (e) => {
      const file = e.target.files[0]
      if (!file) return
      e.target.value = ''
      this._loadRecordingFile(file)
    })

    this._lastAudioTapMs = 0

    // Keep canvas drawing buffers matched to their on-screen size (crisp graphs).
    window.addEventListener('resize', () => {
      if (this._analysisPanel.hidden) return
      App.trackManager.resizeAll()
      this._scrubber.resize()
      this._scrubber.refresh()
    })
  }

  /** Begin an always-on live capture into the SessionStore (DVR). */
  _startLiveCapture() {
    const store = App.sessionStore
    // Preserve a prior live session across a brief disconnect/reconnect by
    // continuing to append, rather than wiping the reviewable timeline the
    // disconnect handler deliberately kept. Start fresh in any other case
    // (first connect, or re-arming live after a loaded file).
    const resume = store.source === 'live' && !store.isEmpty()
    if (resume) store.continueLive()
    else store.startLive()
    App.recordingManager.enableCapture({ resume })
    const eeg = App.eegManager
    this._specTapIdx     = eeg?.spectrumSampleCount ?? 0
    this._specLoTapIdx   = eeg?.spectrumLoSampleCount ?? 0
    // Time of the previous tap. Seeded to the capture epoch, not null: the first
    // tap's columns were produced between capture start and now, so they must be
    // spread across that span. Leaving it null stamps them all at "now", which
    // piles a whole tab-was-backgrounded backlog onto a single output pixel.
    this._specTapT       = store.liveElapsed()
    this._specLoTapT     = this._specTapT
    this._lastAudioTapMs = 0
    if (App.trackManager?.liveTrack) App.trackManager.liveTrack._ribbonDirty = true
    this._scrubber?.refresh()
  }

  /**
   * Copy new spectrogram / audio-tempogram columns from the live managers into
   * the store (the JSONL stream carries no spectrogram columns). Called each
   * frame while live capture is active.
   */
  _tapLiveColumns() {
    const eeg = App.eegManager
    if (!eeg?.isConnected) return
    const store = App.sessionStore
    const t = store.liveElapsed()

    this._tapSpec(store, 'main', eeg.spectrumDisplay, eeg.spectrumSampleCount, '_specTapIdx', '_specTapT', t)
    this._tapSpec(store, 'lo', eeg.spectrumLoDisplay, eeg.spectrumLoSampleCount, '_specLoTapIdx', '_specLoTapT', t)

    const now = performance.now()
    if (now - this._lastAudioTapMs > 500) {
      const at = App.entrainmentManager?.audioTempogram
      if (at) store.addSpecColumn('audio', t, at)
      this._lastAudioTapMs = now
    }
  }

  /**
   * Copy the newly-available columns of one spectrogram buffer into the store,
   * spreading their timestamps evenly from the previous tap up to `t`. When
   * several columns arrive in a single frame (backgrounded tab, GC pause,
   * catch-up), stamping them all with the same `t` would collapse them onto one
   * output pixel in AnalysisDisplay and desync from the counter-based EEG trace;
   * interpolating keeps them spaced at roughly their true production times.
   */
  _tapSpec(store, kind, buf, count, idxKey, tKey, t) {
    const avail = Math.min(count - this[idxKey], buf.length)
    if (avail <= 0) return
    const prevT = this[tKey] ?? t
    const start = buf.length - avail
    for (let k = 0; k < avail; k++) {
      const frac = avail === 1 ? 1 : (k + 1) / avail
      store.addSpecColumn(kind, prevT + (t - prevT) * frac, buf[start + k])
    }
    this[idxKey] = count
    this[tKey] = t
  }

  /** Load a saved .jsonl recording as a new track, additive to any live/other tracks. */
  async _loadRecordingFile(file) {
    let text
    try { text = await file.text() } catch (err) { console.error('Recording read failed:', err); return }

    let track
    try {
      track = App.trackManager.addFileTrack(text, file.name)
      console.log(`Loaded recording: ${file.name}, ${track.duration().toFixed(1)} s`)
    } catch (err) {
      console.error('Recording parse failed:', err)
      return
    }

    // Label the track with the filename + recording date so it isn't anonymous
    // in the stack — the user can tell which file each lane is reviewing.
    const ts = track.store.meta?.startedAt
    const when = ts ? new Date(ts).toLocaleString() : 'unknown date'
    track.setLabel(`${file.name} — ${when}`)
    this._showPanel({ follow: false })
  }

  /** Trigger a browser download of the JSONL blob. */
  _downloadRecording(blob, startedAtMs) {
    const ts    = new Date(startedAtMs).toISOString().replace(/[:.]/g, '-').replace('Z', '')
    const url   = URL.createObjectURL(blob)
    const a     = document.createElement('a')
    a.href      = url
    a.download  = `nouscope-${ts}.jsonl`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  /** Show the pause button, reset to its playing icon (click handler is wired once in _wireLiveControls). */
  _setupPauseBtn() {
    this._pauseBtn.textContent = '⏸'
    this._pauseBtn.hidden = false
  }

  /** Main update loop — called every animation frame. */
  update() {
    requestAnimationFrame(() => this.update())

    App.eegManager?.update(performance.now())

    if (this._hrDisplay && App.eegManager?.isConnected) {
      const hr = App.eegManager.heartRate
      this._hrDisplay.textContent = hr > 0 ? `♥ ${Math.round(hr)} bpm` : ''
    }

    App.audioManager?.update()
    App.entrainmentManager?.update(performance.now())
    App.complexityManager?.update(performance.now())

    // Feed the scrubbable session with spectrogram/tempogram columns while the
    // live/DVR capture is active (raw + derived records flow via the record hooks).
    if (App.recordingManager?.captureActive) this._tapLiveColumns()

    // Record-time readout (updates ~once per second is plenty; cheap per-frame)
    if (this._recordTimeEl && App.recordingManager?.isRecording) {
      const s = Math.floor(App.recordingManager.elapsedMs() / 1000)
      const mm = Math.floor(s / 60).toString().padStart(2, '0')
      const ss = (s % 60).toString().padStart(2, '0')
      this._recordTimeEl.textContent = `${mm}:${ss}`
    }
  }
}
