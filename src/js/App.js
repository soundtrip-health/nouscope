import BPMManager from './managers/BPMManager'
import AudioManager from './managers/AudioManager'
import EEGManager from './managers/EEGManager'
import EntrainmentManager from './managers/EntrainmentManager'
import ComplexityManager from './managers/ComplexityManager'
import RecordingManager from './managers/RecordingManager'
import SessionStore from './managers/SessionStore'
import BioDataDisplay from './ui/BioDataDisplay'
import AnalysisDisplay from './ui/AnalysisDisplay'
import Scrubber from './ui/Scrubber'

/**
 * App — top-level orchestrator.
 *
 * A Muse EEG/PPG/IMU biometric visualizer. The live bio-data panel is the
 * visualization; there is no 3D scene. Audio playback is optional — loading a
 * local file enables the neural-entrainment analysis (music tempo vs. EEG
 * tempogram). The render loop runs immediately so EEG plots work with no audio.
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

  constructor() {
    const input = document.getElementById('audio-upload')

    // File upload: loads (or replaces) the buffer audio source.
    input.addEventListener('change', (e) => {
      const file = e.target.files[0]
      if (!file) return
      e.target.value = '' // allow re-selecting the same file
      this._loadAudioFile(file)
    })

    // Mic button: toggle live microphone input as the (muted) audio source.
    this._micBtn = document.getElementById('mic-btn')
    this._micBtn.addEventListener('click', () => this._toggleMic())

    this._setupEEG()
    this._setupRecording()
    this._setupAnalysis()

    // Start the update loop immediately so EEG/bio plots work before (or without) audio.
    this.update()
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

  /** Wire up EEG connect/disconnect UI and create the EEGManager instance. */
  _setupEEG() {
    App.eegManager = new EEGManager()
    App.complexityManager = new ComplexityManager()

    const controls    = document.getElementById('eeg-controls')
    const btn         = document.getElementById('eeg-connect')
    const batteryEl   = document.getElementById('eeg-status')
    const batteryFill = batteryEl.querySelector('.battery-fill')
    const panel       = document.getElementById('bio-panel')
    this._hrDisplay   = document.getElementById('heart-rate')
    this._bioHr       = document.getElementById('bio-hr')
    // Scope to the LIVE panel's dots only — the Analysis panel owns its own dots
    // (AnalysisDisplay, via SessionStore.qualityAt). An unscoped '.quality-dot'
    // would also write signalQuality (indices 4–7 undefined) to the analysis dots.
    this._qualityDots = document.querySelectorAll('#eeg-quality-dots .quality-dot')
    this._bioPanel    = panel
    this._bioVisible  = false

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

    controls.style.display = 'flex'

    App.eegManager.onBatteryLevel = (level) => updateBattery(level)

    App.eegManager.onDisconnected = () => {
      btn.textContent = 'Connect EEG'
      btn.disabled = false
      updateBattery(null)
      // Hide the data view and exit full-screen mode.
      panel.hidden = true
      this._bioVisible = false
      document.body.classList.remove('fullscreen-bio')
      if (this._recordBtn) this._recordBtn.hidden = true
      // Stop feeding the store, but keep the captured session for scrubbing.
      App.recordingManager?.disableCapture()
      // Keep the Analysis tab available if there is still a session to scrub
      // (the just-captured live session or a loaded file); otherwise hide the tabs.
      this._maybeShowTabs()
    }

    btn.addEventListener('click', async () => {
      if (App.eegManager.isConnected) {
        App.eegManager.disconnect()
      } else {
        btn.textContent = 'Connecting...'
        btn.disabled = true
        try {
          await App.eegManager.connect()
          btn.textContent = 'Disconnect EEG'
          btn.disabled = false
          if (this._recordBtn) this._recordBtn.hidden = false
          // Init plots on first connect; reset read pointers on subsequent connects
          if (!this._bioDisplay) {
            this._bioDisplay = new BioDataDisplay()
            this._bioDisplay.init()
          } else {
            this._bioDisplay.resetIndices()
          }
          // The full-screen data view is the default: show it automatically.
          panel.hidden = false
          this._bioVisible = true
          document.body.classList.add('fullscreen-bio')
          // Size the drawing buffers to the now-visible fullscreen layout.
          this._bioDisplay.resize()
          // Begin an always-on live/DVR capture into the SessionStore so the
          // Analysis tab reflects the live session (no explicit recording needed).
          this._startLiveCapture()
          this._maybeShowTabs()
        } catch (err) {
          console.error('EEG connect failed:', err)
          btn.textContent = 'Connect EEG'
          btn.disabled = false
        }
      }
    })
  }

  /** Wire up the record button + download-on-stop flow. */
  _setupRecording() {
    App.recordingManager = new RecordingManager()

    const btn     = document.getElementById('bio-record')
    const timeEl  = document.getElementById('bio-record-time')
    this._recordBtn    = btn
    this._recordTimeEl = timeEl

    btn.addEventListener('click', async () => {
      const rm = App.recordingManager
      if (rm.isRecording) {
        btn.disabled = true
        const blob = await rm.stop()
        // Stream mode writes straight to disk and returns null; memory-mode
        // fallback returns a Blob the browser must download.
        if (blob) this._downloadRecording(blob, rm.startedAtMs)
        btn.disabled = false
        btn.classList.remove('active')
        btn.title = 'Record raw data to JSONL'
        timeEl.hidden = true
      } else {
        const eeg = App.eegManager
        const started = await rm.start({
          device:     eeg?.deviceName,
          deviceInfo: eeg?.deviceInfo,
          channels:   ['TP9', 'AF7', 'AF8', 'TP10'],
          audioBpm:   App.bpmManager?.bpmValue || null,
        })
        if (!started) return   // user cancelled the save-file picker
        btn.classList.add('active')
        btn.title = 'Stop recording'
        timeEl.hidden = false
        this._maybeShowTabs()
      }
    })
  }

  /** Wire the Analysis tab: session store, scrubber, tab switch, file load. */
  _setupAnalysis() {
    App.sessionStore = new SessionStore()
    // Every produced record flows into the scrubbable timeline as it recorded.
    App.recordingManager.onRecord = (obj) => App.sessionStore.ingest(obj)

    this._analysisDisplay = new AnalysisDisplay()
    this._scrubber = new Scrubber((store, t0, t1, cursor) => this._analysisDisplay.renderWindow(store, t0, t1, cursor))
    this._scrubber.attach()
    this._scrubber.setStore(App.sessionStore)

    this._viewTabs      = document.getElementById('view-tabs')
    this._analysisPanel = document.getElementById('analysis-panel')
    document.getElementById('tab-live').addEventListener('click', () => this._setView('live'))
    document.getElementById('tab-analysis').addEventListener('click', () => this._setView('analysis'))

    const recInput = document.getElementById('recording-upload')
    recInput.addEventListener('change', (e) => {
      const file = e.target.files[0]
      if (!file) return
      e.target.value = ''
      this._loadRecordingFile(file)
    })

    this._view = 'live'
    this._lastAudioTapMs = 0

    // Keep canvas drawing buffers matched to their on-screen size (crisp graphs).
    window.addEventListener('resize', () => {
      if (this._view === 'analysis') {
        this._analysisDisplay.resize()
        this._scrubber.resize()
        this._scrubber.refresh()
      } else if (this._bioVisible) {
        this._bioDisplay?.resize()
      }
    })
  }

  /** Begin an always-on live capture into the SessionStore (DVR). */
  _startLiveCapture() {
    const store = App.sessionStore
    // Preserve a prior live session across a brief disconnect/reconnect by
    // continuing to append, rather than wiping the reviewable timeline the
    // disconnect handler deliberately kept. Start fresh in any other case
    // (first connect, or re-arming live after a loaded file).
    if (store.source === 'live' && !store.isEmpty()) store.continueLive()
    else store.startLive()
    App.recordingManager.enableCapture()
    const eeg = App.eegManager
    this._specTapIdx     = eeg?.spectrumSampleCount ?? 0
    this._specLoTapIdx   = eeg?.spectrumLoSampleCount ?? 0
    this._specTapT       = null   // wall-clock of previous main-spec tap
    this._specLoTapT     = null   // wall-clock of previous lo-spec tap
    this._lastAudioTapMs = 0
    this._scrubber?.setStore(App.sessionStore)
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

  /** Show the Live/Analysis tabs when there's anything to look at. */
  _maybeShowTabs() {
    const has = App.eegManager?.isConnected || !App.sessionStore.isEmpty()
    if (this._viewTabs) this._viewTabs.hidden = !has
    // The Live view only has content with a connected Muse; disable its tab
    // otherwise so a loaded-file session can't switch to a blank live panel.
    const liveTab = document.getElementById('tab-live')
    if (liveTab) {
      const canLive = !!App.eegManager?.isConnected
      liveTab.disabled = !canLive
      liveTab.title = canLive ? '' : 'Live view needs a connected Muse'
    }
    if (!has && this._view === 'analysis') this._setView('live')
  }

  /** Switch between the live panel and the scrubbable analysis panel. */
  _setView(view) {
    // Live needs a connected Muse. With only a loaded file (nothing live to
    // show), stay in analysis rather than hiding both panels into a blank view.
    if (view === 'live' && !App.eegManager?.isConnected && !App.sessionStore.isEmpty()) {
      view = 'analysis'
    }
    this._view = view
    document.getElementById('tab-live').classList.toggle('active', view === 'live')
    document.getElementById('tab-analysis').classList.toggle('active', view === 'analysis')

    if (view === 'analysis') {
      document.body.classList.remove('fullscreen-bio')
      document.body.classList.add('analysis-mode')
      this._bioPanel.hidden = true
      this._bioVisible = false
      this._analysisPanel.hidden = false
      if (!this._analysisDisplay._inited) this._analysisDisplay.init()
      this._analysisDisplay.resize()
      // A live/DVR session (Muse connected, data streaming) defaults to
      // following the leading edge; a loaded file opens at its start.
      const live = App.sessionStore.source === 'live' && App.eegManager?.isConnected
      this._scrubber.setStore(App.sessionStore)
      this._scrubber.setActive(true, live ? { follow: true } : { atStart: true })
      this._scrubber.resize()   // #scrubber just became visible; size the ribbon canvas now
    } else {
      document.body.classList.remove('analysis-mode')
      this._scrubber.setActive(false)
      this._analysisPanel.hidden = true
      // Restore the live fullscreen view if EEG is still connected.
      if (App.eegManager?.isConnected) {
        document.body.classList.add('fullscreen-bio')
        this._bioPanel.hidden = false
        this._bioVisible = true
        this._bioDisplay?.resize()
        // If the store was showing a loaded file, re-arm live/DVR capture so
        // the Analysis tab reflects the ongoing session again.
        if (App.sessionStore.source !== 'live') this._startLiveCapture()
      }
    }
  }

  /** Load a saved .jsonl recording into the store and open the Analysis tab. */
  async _loadRecordingFile(file) {
    // Don't mix a live recording with a loaded file.
    if (App.recordingManager?.isRecording) {
      const blob = await App.recordingManager.stop()
      if (blob) this._downloadRecording(blob, App.recordingManager.startedAtMs)
      if (this._recordBtn) { this._recordBtn.classList.remove('active'); this._recordBtn.hidden = !App.eegManager?.isConnected }
      if (this._recordTimeEl) this._recordTimeEl.hidden = true
    }
    // Pause live/DVR capture so it doesn't overwrite the loaded file.
    App.recordingManager?.disableCapture()
    let text
    try { text = await file.text() } catch (err) { console.error('Recording read failed:', err); return }
    try {
      const { records, duration } = App.sessionStore.loadFromText(text)
      console.log(`Loaded recording: ${records} records, ${duration.toFixed(1)} s`)
    } catch (err) {
      console.error('Recording parse failed:', err)
      return
    }
    this._maybeShowTabs()
    this._setView('analysis')
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

  /** Show the pause button and wire its click handler (idempotent). */
  _setupPauseBtn() {
    if (this._pauseBtn) {
      this._pauseBtn.textContent = '⏸'
      return
    }
    this._pauseBtn = document.getElementById('pause-btn')
    this._pauseBtn.addEventListener('click', () => {
      if (App.audioManager.isPlaying) {
        App.audioManager.pause()
        this._pauseBtn.textContent = '▶'
      } else {
        App.audioManager.play()
        this._pauseBtn.textContent = '⏸'
      }
    })
    this._pauseBtn.hidden = false
  }

  /** Update signal quality dots, bio-panel HR readout, and plots each frame. */
  _updateBioPanel() {
    if (!App.eegManager?.isConnected) return

    // Signal quality dots (always update when connected, even if panel hidden)
    const sq = App.eegManager.signalQuality
    this._qualityDots.forEach((dot, i) => {
      dot.classList.remove('good', 'marginal', 'poor')
      dot.classList.add(sq[i])
    })

    // HR in panel
    const hr = App.eegManager.heartRate
    if (this._bioHr) this._bioHr.textContent = hr > 0 ? `${Math.round(hr)} bpm` : ''

    // Plots — only render when panel is visible
    if (this._bioVisible) this._bioDisplay?.update()
  }

  /** Main update loop — called every animation frame. */
  update() {
    requestAnimationFrame(() => this.update())

    App.eegManager?.update(performance.now())

    if (this._hrDisplay && App.eegManager?.isConnected) {
      const hr = App.eegManager.heartRate
      this._hrDisplay.textContent = hr > 0 ? `♥ ${Math.round(hr)} bpm` : ''
    }

    this._updateBioPanel()

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
