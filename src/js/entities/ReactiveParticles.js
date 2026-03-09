import * as THREE from 'three'
import gsap from 'gsap'
import vertex from './glsl/vertex.glsl'
import fragment from './glsl/fragment.glsl'
import App from '../App'

// --- Constants ---
const BASE_SIZE = 1.1
const BASE_MAX_DISTANCE = 1.8
const BEAT_ROTATE_CHANCE = 0.3
const BEAT_RESET_CHANCE = 0.3
const CAMERA_Z = 10          // nominal camera depth (for z-position tweens)
const CAMERA_Z_RANGE = 1     // ±range for random z placement

/**
 * Bio feature sources available for mapping to viz parameters.
 * EEG band values are relative powers (0–1, sum = 1).
 * 'hr' is the heart-rate phase oscillator (0–1, cubed-sine shape).
 * 'none' produces zero contribution.
 */
const BIO_SOURCES = ['none', 'delta', 'theta', 'alpha', 'beta', 'gamma', 'hr']

/**
 * Per viz-parameter bio mapping ranges.
 *   min     — weight slider left edge  (no contribution)
 *   max     — weight slider right edge (maximum contribution)
 *   default — midpoint; preserves the original hardcoded behavior
 *
 * Formula each frame:  uniform += sources[source] * weight
 */
const BIO_RANGE = {
  amplitude:   { min: 0.0, max: 0.6, default: 0.3 },  // was: gamma * 0.3
  offsetGain:  { min: 0.0, max: 1.0, default: 0.5 },  // was: beta  * 0.5
  size:        { min: 0.0, max: 4.0, default: 2.0 },  // was: theta * 2.0
  maxDistance: { min: 0.0, max: 3.6, default: 1.8 },  // was: alpha * 1.8
  heartPulse:  { min: 0.0, max: 2.0, default: 1.0 },  // was: hr    * 1.0
}

/**
 * Per-band audio gain ranges.
 *   min     — slider left  (silence the band's contribution)
 *   max     — slider right (2× the default contribution)
 *   default — 1.0 = original hardcoded behavior
 *
 * bass → animation speed (time increment)
 * mid  → turbulence (offsetGain baseline)
 * high → displacement amplitude baseline
 */
const AUDIO_RANGE = {
  bass: { min: 0.0, max: 2.0, default: 1.0 },
  mid:  { min: 0.0, max: 2.0, default: 1.0 },
  high: { min: 0.0, max: 2.0, default: 1.0 },
}

/**
 * ReactiveParticles
 *
 * A Three.js Object3D that renders an audio-reactive particle system.
 * Each frame, audio frequency data and optional EEG band powers are mapped
 * to ShaderMaterial uniforms controlling particle size, displacement, and color.
 *
 * On each BPM beat, geometry is randomly replaced (box ↔ cylinder) and
 * rotations are tweened via GSAP.
 *
 * Optional: IMU head-pose (pitch/roll) overrides auto-rotate when headControl is enabled.
 */
export default class ReactiveParticles extends THREE.Object3D {
  constructor() {
    super()
    this.name = 'ReactiveParticles'
    this.time = 0
    this.properties = {
      startColor: 0xff00ff,
      endColor: 0x00ffff,
      autoMix: true,
      autoRotate: true,
      headControl: false,
      imuStrength: 1.0,
    }

    // Per-band audio gain: 1.0 = default behavior; slider range defined in AUDIO_RANGE
    this.audioGains = {
      bass: AUDIO_RANGE.bass.default,
      mid:  AUDIO_RANGE.mid.default,
      high: AUDIO_RANGE.high.default,
    }

    // Bio→viz mapping: source selects the input signal; weight scales its contribution.
    // Defaults preserve the original hardcoded behavior (weight = BIO_RANGE[param].default).
    this.bioMapping = {
      amplitude:   { source: 'gamma', weight: BIO_RANGE.amplitude.default },
      offsetGain:  { source: 'beta',  weight: BIO_RANGE.offsetGain.default },
      size:        { source: 'theta', weight: BIO_RANGE.size.default },
      maxDistance: { source: 'alpha', weight: BIO_RANGE.maxDistance.default },
      heartPulse:  { source: 'hr',    weight: BIO_RANGE.heartPulse.default },
    }
  }

  /** Attach to the scene holder, create ShaderMaterial, build initial mesh, add GUI. */
  init() {
    App.holder.add(this)

    this.holderObjects = new THREE.Object3D()
    this.add(this.holderObjects)

    this.material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      uniforms: {
        time:        { value: 0 },
        offsetSize:  { value: 2 },
        size:        { value: BASE_SIZE },
        frequency:   { value: 2 },
        amplitude:   { value: 1 },
        offsetGain:  { value: 0 },
        maxDistance: { value: BASE_MAX_DISTANCE },
        startColor:  { value: new THREE.Color(this.properties.startColor) },
        endColor:    { value: new THREE.Color(this.properties.endColor) },
        heartPulse:  { value: 0 },
      },
    })

    this.addGUI()
    this.resetMesh()
  }

  /** Create a randomized box-geometry particle mesh and tween it into view. */
  createBoxMesh() {
    const widthSeg  = Math.floor(THREE.MathUtils.randInt(5, 20))
    const heightSeg = Math.floor(THREE.MathUtils.randInt(1, 40))
    const depthSeg  = Math.floor(THREE.MathUtils.randInt(5, 80))
    this.geometry = new THREE.BoxGeometry(1, 1, 1, widthSeg, heightSeg, depthSeg)

    this.material.uniforms.offsetSize.value = Math.floor(THREE.MathUtils.randInt(30, 60))
    this.material.needsUpdate = true

    this.pointsMesh = new THREE.Object3D()
    this.pointsMesh.rotateX(Math.PI / 2)
    this.holderObjects.add(this.pointsMesh)

    const pointsMesh = new THREE.Points(this.geometry, this.material)
    this.pointsMesh.add(pointsMesh)

    gsap.to(this.pointsMesh.rotation, {
      duration: 3,
      x: Math.random() * Math.PI,
      z: Math.random() * Math.PI * 2,
      ease: 'none',
    })

    gsap.to(this.position, {
      duration: 0.6,
      z: THREE.MathUtils.randInt(CAMERA_Z - CAMERA_Z_RANGE, CAMERA_Z + CAMERA_Z_RANGE),
      ease: 'elastic.out(0.8)',
    })
  }

  /** Create a randomized cylinder-geometry particle mesh and tween it into view. */
  createCylinderMesh() {
    const radialSeg = Math.floor(THREE.MathUtils.randInt(1, 3))
    const heightSeg = Math.floor(THREE.MathUtils.randInt(1, 5))
    this.geometry = new THREE.CylinderGeometry(1, 1, 4, 64 * radialSeg, 64 * heightSeg, true)

    this.material.uniforms.offsetSize.value = Math.floor(THREE.MathUtils.randInt(30, 60))
    this.material.uniforms.size.value = 2
    this.material.needsUpdate = true

    this.pointsMesh = new THREE.Points(this.geometry, this.material)
    this.pointsMesh.rotation.set(Math.PI / 2, 0, 0)
    this.holderObjects.add(this.pointsMesh)

    let rotY = 0
    let posZ = THREE.MathUtils.randInt(CAMERA_Z - CAMERA_Z_RANGE, CAMERA_Z + CAMERA_Z_RANGE)

    if (Math.random() < 0.2) {
      rotY = Math.PI / 2
      posZ = THREE.MathUtils.randInt(10, 11.5)
    }

    gsap.to(this.holderObjects.rotation, {
      duration: 0.2,
      y: rotY,
      ease: 'elastic.out(0.2)',
    })

    gsap.to(this.position, {
      duration: 0.6,
      z: posZ,
      ease: 'elastic.out(0.8)',
    })
  }

  /**
   * Called on each BPM beat. Randomly triggers an auto-rotate tween and/or
   * a geometry reset. Skips auto-rotate when head-control (IMU) is active.
   */
  onBPMBeat() {
    const duration = App.bpmManager.getBPMDuration() / 1000

    if (App.audioManager.isPlaying) {
      if (Math.random() < BEAT_ROTATE_CHANCE && this.properties.autoRotate && !this.properties.headControl) {
        gsap.to(this.holderObjects.rotation, {
          duration: Math.random() < 0.8 ? 15 : duration,
          z: Math.random() * Math.PI,
          ease: 'elastic.out(0.2)',
        })
      }

      if (Math.random() < BEAT_RESET_CHANCE) {
        this.resetMesh()
      }
    }
  }

  /** Replace the current mesh with a new cylinder if autoMix is enabled. */
  resetMesh() {
    if (this.properties.autoMix) {
      this.destroyMesh()
      this.createCylinderMesh()

      gsap.to(this.material.uniforms.frequency, {
        duration: App.bpmManager ? (App.bpmManager.getBPMDuration() / 1000) * 2 : 2,
        value: THREE.MathUtils.randFloat(0.5, 3),
        ease: 'expo.easeInOut',
      })
    }
  }

  /** Remove the current points mesh and dispose its GPU resources. */
  destroyMesh() {
    if (this.pointsMesh) {
      gsap.killTweensOf(this.pointsMesh)
      gsap.killTweensOf(this.pointsMesh.rotation)
      this.holderObjects.remove(this.pointsMesh)
      this.pointsMesh.geometry?.dispose()
      this.pointsMesh.material?.dispose()
      this.pointsMesh = null
    }
  }

  /**
   * Update shader uniforms from audio and EEG data. Called every frame.
   * @param {object|null} eegBands  — { delta, theta, alpha, beta, gamma } (0–1 each), or null
   * @param {number}      heartPulse — heart-rate oscillator value (0–1)
   * @param {object|null} headPose  — { pitch, roll } in radians, or null
   */
  update(eegBands = null, heartPulse = 0, headPose = null) {
    // Build bio source lookup once; used in both the audio and heartPulse paths below
    const sources = {
      none:  0,
      delta: eegBands?.delta ?? 0,
      theta: eegBands?.theta ?? 0,
      alpha: eegBands?.alpha ?? 0,
      beta:  eegBands?.beta  ?? 0,
      gamma: eegBands?.gamma ?? 0,
      hr:    heartPulse,
    }

    if (App.audioManager?.isPlaying) {
      // Audio baseline — audioGains scale each band's contribution (0 = none, 1 = default, 2 = double)
      let amplitude   = 0.8 + THREE.MathUtils.mapLinear(App.audioManager.frequencyData.high, 0, 0.6, -0.1, 0.2) * this.audioGains.high
      let offsetGain  = App.audioManager.frequencyData.mid * 0.6 * this.audioGains.mid
      let size        = BASE_SIZE
      let maxDistance = BASE_MAX_DISTANCE

      // Bio additive contributions — each viz parameter takes one source signal × weight
      amplitude   += sources[this.bioMapping.amplitude.source]   * this.bioMapping.amplitude.weight
      offsetGain  += sources[this.bioMapping.offsetGain.source]  * this.bioMapping.offsetGain.weight
      size        += sources[this.bioMapping.size.source]        * this.bioMapping.size.weight
      maxDistance += sources[this.bioMapping.maxDistance.source] * this.bioMapping.maxDistance.weight

      this.material.uniforms.amplitude.value   = amplitude
      this.material.uniforms.offsetGain.value  = offsetGain
      this.material.uniforms.size.value        = size
      this.material.uniforms.maxDistance.value = maxDistance

      // Bass gain scales animation speed; floor of 0.1 keeps animation ticking at low gain
      const t = THREE.MathUtils.mapLinear(App.audioManager.frequencyData.low, 0.6, 1, 0.2, 0.5)
      this.time += Math.max(0.1, THREE.MathUtils.clamp(t, 0.2, 0.5) * this.audioGains.bass)
    } else {
      this.material.uniforms.frequency.value   = 0.8
      this.material.uniforms.amplitude.value   = 1
      this.material.uniforms.size.value        = BASE_SIZE
      this.material.uniforms.maxDistance.value = BASE_MAX_DISTANCE
      this.time += 0.2
    }

    // Color flush — driven by bio mapping, applied regardless of audio state
    this.material.uniforms.heartPulse.value =
      sources[this.bioMapping.heartPulse.source] * this.bioMapping.heartPulse.weight

    // Head-control mode: map IMU pitch/roll directly onto geometry orientation,
    // overriding any GSAP auto-rotate tweens
    if (this.properties.headControl && headPose) {
      gsap.killTweensOf(this.holderObjects.rotation)
      const imuStr = this.properties.imuStrength * 0.8
      this.holderObjects.rotation.x = headPose.pitch * imuStr
      this.holderObjects.rotation.y = headPose.roll  * imuStr
    }

    this.material.uniforms.time.value = this.time
  }

  addGUI() {
    const gui = App.gui

    const particlesFolder = gui.addFolder('PARTICLES')
    particlesFolder
      .addColor(this.properties, 'startColor')
      .listen()
      .name('Start Color')
      .onChange((e) => {
        this.material.uniforms.startColor.value = new THREE.Color(e)
      })
    particlesFolder
      .addColor(this.properties, 'endColor')
      .listen()
      .name('End Color')
      .onChange((e) => {
        this.material.uniforms.endColor.value = new THREE.Color(e)
      })

    const visualizerFolder = gui.addFolder('VISUALIZER')
    visualizerFolder.add(this.properties, 'autoMix').listen().name('Auto Mix')
    visualizerFolder.add(this.properties, 'autoRotate').listen().name('Auto Rotate')
    visualizerFolder
      .add(this.properties, 'headControl')
      .listen()
      .name('Head Control (IMU)')
      .onChange((enabled) => {
        if (!enabled) {
          gsap.to(this.holderObjects.rotation, { duration: 1.5, x: 0, y: 0, ease: 'power2.out' })
        }
      })
    visualizerFolder.add(this.properties, 'imuStrength', 0, 3).name('IMU Strength')
    const buttonShowCylinder = {
      showCylinder: () => {
        this.destroyMesh()
        this.createCylinderMesh()
        this.properties.autoMix = false
      },
    }
    visualizerFolder.add(buttonShowCylinder, 'showCylinder').name('Reset Cylinder')

    const audioFolder = gui.addFolder('AUDIO')
    audioFolder.add(this.audioGains, 'bass', AUDIO_RANGE.bass.min, AUDIO_RANGE.bass.max).name('Bass Gain')
    audioFolder.add(this.audioGains, 'mid',  AUDIO_RANGE.mid.min,  AUDIO_RANGE.mid.max).name('Mid Gain')
    audioFolder.add(this.audioGains, 'high', AUDIO_RANGE.high.min, AUDIO_RANGE.high.max).name('High Gain')

    // MAPPING — one sub-folder per viz parameter with source dropdown + weight slider
    const mappingFolder = gui.addFolder('MAPPING')
    const paramLabels = {
      amplitude:   'Amplitude',
      offsetGain:  'Turbulence',
      size:        'Particle Size',
      maxDistance: 'Spread Radius',
      heartPulse:  'Color Flush',
    }
    for (const [param, label] of Object.entries(paramLabels)) {
      const sub = mappingFolder.addFolder(label)
      sub.add(this.bioMapping[param], 'source', BIO_SOURCES).name('Source')
      sub.add(this.bioMapping[param], 'weight', BIO_RANGE[param].min, BIO_RANGE[param].max).name('Weight')
    }
  }
}
