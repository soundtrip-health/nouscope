import * as THREE from 'three'

// --- Constants ---
const FFT_SIZE = 1024
const HALF_FFT = FFT_SIZE / 2          // 512 magnitude bins
const NOVELTY_RING_LEN = 768           // ~12.8 s at 60 fps — exceeds 8 s analysis window

/**
 * AudioManager
 *
 * Wraps Three.js AudioListener / AudioAnalyser to load and play a local audio
 * file, and computes a spectral-flux novelty curve each frame. The novelty ring
 * buffer feeds EntrainmentManager's audio tempogram (music-tempo vs. EEG).
 *
 * Usage:
 *   const mgr = new AudioManager()
 *   await mgr.loadAudioBuffer(file)   // File object from <input>
 *   mgr.play()
 *   // each frame:
 *   mgr.update()
 *   // read: mgr.noveltyRing
 */
export default class AudioManager {
  constructor() {
    this.frequencyArray = []
    this.isPlaying = false
    this.audioContext = null

    // Spectral flux novelty curve (for entrainment tempogram)
    this._prevMagnitudes = new Float32Array(HALF_FFT)
    this._noveltyRing = {
      times:  new Float64Array(NOVELTY_RING_LEN),
      values: new Float32Array(NOVELTY_RING_LEN),
      head:   0,
      count:  0,
    }
  }

  /** Ring buffer of (timestamp, spectralFlux) pairs for EntrainmentManager. */
  get noveltyRing() { return this._noveltyRing }

  /**
   * Load and decode an audio source.
   * @param {File|string} source — a File object (from <input type="file">)
   *   or a URL string (path to audio file)
   * @returns {Promise<void>} resolves when buffer is ready for playback
   */
  async loadAudioBuffer(source) {
    const audioListener = new THREE.AudioListener()
    this.audio = new THREE.Audio(audioListener)
    this.audioAnalyser = new THREE.AudioAnalyser(this.audio, FFT_SIZE)

    let arrayBuffer

    if (source instanceof File) {
      // Read File object into ArrayBuffer
      arrayBuffer = await source.arrayBuffer()
    } else {
      // Fetch URL string
      const response = await fetch(source)
      if (!response.ok) {
        throw new Error(`Failed to fetch audio: ${response.status} ${response.statusText}`)
      }
      arrayBuffer = await response.arrayBuffer()
    }

    const audioContext = this.audioAnalyser.analyser.context
    const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer)

    this.audio.setBuffer(decodedBuffer)
    this.audio.setLoop(true)
    this.audio.setVolume(0.5)
    this.audioContext = audioContext
    this.bufferLength = this.audioAnalyser.data.length
  }

  /** Start playback. */
  play() {
    this.audio.play()
    this.isPlaying = true
  }

  /** Pause playback. */
  pause() {
    this.audio.pause()
    this.isPlaying = false
  }

  collectAudioData() {
    this.frequencyArray = this.audioAnalyser.getFrequencyData()
  }

  /**
   * Compute half-wave rectified spectral flux from successive FFT frames.
   * One novelty sample per render frame (~60 Hz), stored in a timestamped
   * ring buffer for EntrainmentManager to resample to a uniform grid.
   */
  _sampleNovelty() {
    const freq = this.frequencyArray
    let flux = 0
    for (let i = 0; i < HALF_FFT; i++) {
      const diff = freq[i] - this._prevMagnitudes[i]
      if (diff > 0) flux += diff
      this._prevMagnitudes[i] = freq[i]
    }

    const ring = this._noveltyRing
    const idx = ring.head
    ring.times[idx]  = performance.now() / 1000   // seconds
    ring.values[idx] = flux
    ring.head  = (idx + 1) % NOVELTY_RING_LEN
    ring.count = Math.min(ring.count + 1, NOVELTY_RING_LEN)
  }

  /** Called every frame from App.update(). */
  update() {
    if (!this.isPlaying) return

    this.collectAudioData()
    this._sampleNovelty()
  }
}
