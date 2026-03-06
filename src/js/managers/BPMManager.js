import { EventDispatcher } from 'three'
import { guess } from 'web-audio-beat-detector'

// --- Constants ---
const BEAT_EVENT = 'beat'
const DEFAULT_BPM = 120
const DEFAULT_BPM_INTERVAL_MS = 60000 / DEFAULT_BPM

/**
 * BPMManager
 *
 * Detects BPM from a decoded AudioBuffer using `web-audio-beat-detector`,
 * then fires a 'beat' event at the detected interval via Three.js EventDispatcher.
 *
 * Falls back to 120 BPM if detection fails.
 *
 * @fires beat — dispatched at each detected beat interval
 *
 * @example
 *   const mgr = new BPMManager()
 *   mgr.addEventListener('beat', () => console.log('beat!'))
 *   await mgr.detectBPM(audioBuffer)
 */
export default class BPMManager extends EventDispatcher {
  constructor() {
    super()
    this.interval = DEFAULT_BPM_INTERVAL_MS // ms between beat events
    this.intervalId = null
    this.bpmValue = 0
  }

  /**
   * Set a new BPM value and restart the beat interval timer.
   * @param {number} bpm
   */
  setBPM(bpm) {
    this.bpmValue = bpm
    this.interval = 60000 / bpm
    clearInterval(this.intervalId)
    this.intervalId = setInterval(this.updateBPM.bind(this), this.interval)
  }

  updateBPM() {
    this.dispatchEvent({ type: BEAT_EVENT })
  }

  /**
   * Analyze an AudioBuffer to detect BPM and start the beat timer.
   * Falls back to 120 BPM if detection throws.
   * @param {AudioBuffer} audioBuffer
   * @returns {Promise<void>}
   */
  async detectBPM(audioBuffer) {
    try {
      const { bpm } = await guess(audioBuffer)
      this.setBPM(bpm)
    } catch {
      this.setBPM(DEFAULT_BPM) // fallback if detection fails
    }
  }

  /**
   * Returns the duration of one beat in milliseconds.
   * @returns {number}
   */
  getBPMDuration() {
    return this.interval
  }
}
