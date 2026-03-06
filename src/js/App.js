import * as THREE from 'three'
import ReativeParticles from './entities/ReactiveParticles'
import * as dat from 'dat.gui'
import BPMManager from './managers/BPMManager'
import AudioManager from './managers/AudioManager'
import EEGManager from './managers/EEGManager'

const DEMO_TRACK_URL = './audio/demo.mp3'

/**
 * App — top-level orchestrator.
 *
 * Manages the Three.js scene, camera, renderer, and all manager instances.
 * On user interaction (click or file upload), loads audio, detects BPM,
 * then starts the particle visualizer and render loop.
 */
export default class App {
  //THREE objects
  static holder = null
  static gui = null

  //Managers
  static audioManager = null
  static bpmManager = null
  static eegManager = null

  constructor() {
    const overlay = document.querySelector('.user_interaction')
    const input = document.getElementById('audio-upload')

    // File upload: use the uploaded file directly
    input.addEventListener('change', (e) => {
      const file = e.target.files[0]
      if (file) {
        overlay.removeEventListener('click', this._overlayClickHandler)
        this.init(file)
      }
    })

    // Click anywhere on overlay: load demo track
    this._overlayClickHandler = (e) => {
      // Ignore clicks on the file input label (let the browser handle those)
      if (e.target.closest('.upload-btn')) return
      overlay.removeEventListener('click', this._overlayClickHandler)
      this.init(DEMO_TRACK_URL)
    }
    overlay.addEventListener('click', this._overlayClickHandler)
  }

  /**
   * Initialize scene, renderer, camera and kick off audio loading.
   * @param {File|string} source — File object or URL string for the audio
   */
  init(source) {
    document.querySelector('.user_interaction__label').textContent = 'Loading...'
    document.querySelector('.upload-btn').style.display = 'none'

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    })

    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.autoClear = false
    document.querySelector('.content').appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 10000)
    this.camera.position.z = 12
    this.camera.frustumCulled = false

    this.scene = new THREE.Scene()
    this.scene.add(this.camera)

    App.holder = new THREE.Object3D()
    App.holder.name = 'holder'
    this.scene.add(App.holder)
    App.holder.sortObjects = false

    App.gui = new dat.GUI()

    this.createManagers(source)

    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  /**
   * Load audio, detect BPM, then create particles and start the render loop.
   * @param {File|string} source — passed through to AudioManager.loadAudioBuffer()
   */
  async createManagers(source) {
    try {
      App.audioManager = new AudioManager()
      await App.audioManager.loadAudioBuffer(source)
    } catch (err) {
      // Demo track missing or fetch failed — prompt the user to upload
      console.error('Audio load failed:', err)
      document.querySelector('.user_interaction__label').textContent =
        'Could not load demo track. Please upload an audio file.'
      document.querySelector('.upload-btn').style.display = ''
      // Re-attach overlay click handler for the file-upload path only
      return
    }

    App.bpmManager = new BPMManager()
    App.bpmManager.addEventListener('beat', () => {
      this.particles.onBPMBeat()
    })
    await App.bpmManager.detectBPM(App.audioManager.audio.buffer)

    document.querySelector('.user_interaction').remove()

    App.audioManager.play()

    this.particles = new ReativeParticles()
    this.particles.init()

    this._setupEEG()

    this.update()
  }

  /** Wire up EEG connect/disconnect UI and create the EEGManager instance. */
  _setupEEG() {
    App.eegManager = new EEGManager()

    const controls = document.getElementById('eeg-controls')
    const btn = document.getElementById('eeg-connect')
    const dot = document.getElementById('eeg-status')
    this._hrDisplay = document.getElementById('heart-rate')

    controls.style.display = 'flex'

    App.eegManager.onDisconnected = () => {
      btn.textContent = 'Connect EEG'
      btn.disabled = false
      dot.classList.remove('connected')
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
          dot.classList.add('connected')
        } catch (err) {
          console.error('EEG connect failed:', err)
          btn.textContent = 'Connect EEG'
          btn.disabled = false
        }
      }
    })
  }

  /** Handle window resize — update camera aspect and renderer size. */
  resize() {
    this.width = window.innerWidth
    this.height = window.innerHeight

    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(this.width, this.height)
  }

  /** Main render loop — called every animation frame. */
  update() {
    requestAnimationFrame(() => this.update())

    App.eegManager?.update(performance.now())

    if (this._hrDisplay && App.eegManager?.isConnected) {
      const hr = App.eegManager.heartRate
      this._hrDisplay.textContent = hr > 0 ? `♥ ${Math.round(hr)} bpm` : ''
    }

    this.particles?.update(
      App.eegManager?.bandPower,
      App.eegManager?.heartPulse ?? 0,
      App.eegManager?.headPose ?? null,
    )
    App.audioManager.update()

    this.renderer.render(this.scene, this.camera)
  }
}
