import BPMManager from './managers/BPMManager'
import AudioManager from './managers/AudioManager'
import EEGManager from './managers/EEGManager'
import EntrainmentManager from './managers/EntrainmentManager'
import ComplexityManager from './managers/ComplexityManager'
import RecordingManager from './managers/RecordingManager'
import BioDataDisplay from './ui/BioDataDisplay'

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

  constructor() {
    const input = document.getElementById('audio-upload')

    // File upload: first load starts audio; subsequent uploads swap the track.
    input.addEventListener('change', (e) => {
      const file = e.target.files[0]
      if (!file) return
      e.target.value = '' // allow re-selecting the same file
      if (App.audioManager) {
        this._swapAudio(file)
      } else {
        this._startAudio(file)
      }
    })

    this._setupEEG()
    this._setupRecording()
    this._setupFullscreen()

    // Start the update loop immediately so EEG/bio plots work before (or without) audio.
    this.update()
  }

  /**
   * Load a local audio file, detect BPM, and begin the entrainment analysis.
   * Called once on the first file upload; later uploads go through _swapAudio.
   * @param {File} file — audio File from the upload input
   */
  async _startAudio(file) {
    App.audioManager = new AudioManager()
    try {
      await App.audioManager.loadAudioBuffer(file)
    } catch (err) {
      console.error('Audio load failed:', err)
      App.audioManager = null
      return
    }

    App.bpmManager = new BPMManager()
    await App.bpmManager.detectBPM(App.audioManager.audio.buffer)

    App.entrainmentManager = new EntrainmentManager()

    App.audioManager.play()
    this._setupPauseBtn()
  }

  /** Wire up EEG connect/disconnect UI and create the EEGManager instance. */
  _setupEEG() {
    App.eegManager = new EEGManager()
    App.complexityManager = new ComplexityManager()

    const controls    = document.getElementById('eeg-controls')
    const btn         = document.getElementById('eeg-connect')
    const batteryEl   = document.getElementById('eeg-status')
    const batteryFill = batteryEl.querySelector('.battery-fill')
    const toggleBtn   = document.getElementById('bio-toggle')
    const panel       = document.getElementById('bio-panel')
    this._hrDisplay   = document.getElementById('heart-rate')
    this._bioHr       = document.getElementById('bio-hr')
    this._qualityDots = document.querySelectorAll('.quality-dot')
    this._bioPanel    = panel
    this._bioToggle   = toggleBtn
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

    toggleBtn.addEventListener('click', () => {
      this._bioVisible = !this._bioVisible
      panel.hidden = !this._bioVisible
      toggleBtn.classList.toggle('active', this._bioVisible)
    })

    App.eegManager.onBatteryLevel = (level) => updateBattery(level)

    App.eegManager.onDisconnected = () => {
      btn.textContent = 'Connect EEG'
      btn.disabled = false
      updateBattery(null)
      toggleBtn.hidden = true
      panel.hidden = true
      this._bioVisible = false
      toggleBtn.classList.remove('active')
      if (this._recordBtn)     this._recordBtn.hidden = true
      if (this._fullscreenBtn) this._fullscreenBtn.hidden = true
      // Exit fullscreen mode if active, since the panel is now hidden
      document.body.classList.remove('fullscreen-bio')
      this._fullscreenBtn?.classList.remove('active')
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
          toggleBtn.hidden = false
          if (this._recordBtn)     this._recordBtn.hidden = false
          if (this._fullscreenBtn) this._fullscreenBtn.hidden = false
          // Init plots on first connect; reset read pointers on subsequent connects
          if (!this._bioDisplay) {
            this._bioDisplay = new BioDataDisplay()
            this._bioDisplay.init()
          } else {
            this._bioDisplay.resetIndices()
          }
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
      }
    })
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

  /** Wire up the full-screen bio-panel button + Escape-to-exit. */
  _setupFullscreen() {
    const btn = document.getElementById('bio-fullscreen')
    this._fullscreenBtn = btn

    const toggle = () => {
      const active = document.body.classList.toggle('fullscreen-bio')
      btn.classList.toggle('active', active)
      // Make sure the panel is visible when entering fullscreen
      if (active) {
        const panel = document.getElementById('bio-panel')
        panel.hidden = false
        this._bioVisible = true
        this._bioToggle?.classList.add('active')
      }
    }

    btn.addEventListener('click', toggle)

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('fullscreen-bio')) {
        toggle()
      }
    })
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

  /** Swap in a new audio track while playback is running. */
  async _swapAudio(file) {
    if (App.audioManager.isPlaying) {
      App.audioManager.audio.stop()
      App.audioManager.isPlaying = false
    }
    try {
      await App.audioManager.loadAudioBuffer(file)
      await App.bpmManager.detectBPM(App.audioManager.audio.buffer)
      App.audioManager.play()
      if (this._pauseBtn) this._pauseBtn.textContent = '⏸'
    } catch (err) {
      console.error('Audio swap failed:', err)
    }
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

    // Record-time readout (updates ~once per second is plenty; cheap per-frame)
    if (this._recordTimeEl && App.recordingManager?.isRecording) {
      const s = Math.floor(App.recordingManager.elapsedMs() / 1000)
      const mm = Math.floor(s / 60).toString().padStart(2, '0')
      const ss = (s % 60).toString().padStart(2, '0')
      this._recordTimeEl.textContent = `${mm}:${ss}`
    }
  }
}
