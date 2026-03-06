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
    }
    this.influences = {
      eeg: 1.0,
      hr: 1.0,
      imu: 1.0,
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
   * @param {object|null} eegBands — { delta, theta, alpha, beta, gamma } (0–1 each), or null
   * @param {number} heartPulse — heart-rate oscillator value (0–1)
   * @param {object|null} headPose — { pitch, roll } in radians, or null
   */
  update(eegBands = null, heartPulse = 0, headPose = null) {
    if (App.audioManager?.isPlaying) {
      let amplitude   = 0.8 + THREE.MathUtils.mapLinear(App.audioManager.frequencyData.high, 0, 0.6, -0.1, 0.2)
      let offsetGain  = App.audioManager.frequencyData.mid * 0.6
      let size        = BASE_SIZE
      let maxDistance = BASE_MAX_DISTANCE

      if (eegBands) {
        const eegStr = this.influences.eeg
        // theta → particle size (drowsy/relaxed = larger, softer particles)
        size        += eegBands.theta * 2   * eegStr
        // alpha → ring radius (calm/idle state = wider spread)
        maxDistance += eegBands.alpha * 1.8 * eegStr
        // beta → turbulence (focused = more churn)
        offsetGain  += eegBands.beta  * 0.5 * eegStr
        // gamma → amplitude boost (high cognition = intense reactivity)
        amplitude   += eegBands.gamma * 0.3 * eegStr
      }

      this.material.uniforms.amplitude.value   = amplitude
      this.material.uniforms.offsetGain.value  = offsetGain
      this.material.uniforms.size.value        = size
      this.material.uniforms.maxDistance.value = maxDistance

      const t = THREE.MathUtils.mapLinear(App.audioManager.frequencyData.low, 0.6, 1, 0.2, 0.5)
      this.time += THREE.MathUtils.clamp(t, 0.2, 0.5)
    } else {
      this.material.uniforms.frequency.value   = 0.8
      this.material.uniforms.amplitude.value   = 1
      this.material.uniforms.size.value        = BASE_SIZE
      this.material.uniforms.maxDistance.value = BASE_MAX_DISTANCE
      this.time += 0.2
    }

    // Heart-rate pulse colour modulation
    this.material.uniforms.heartPulse.value = heartPulse * this.influences.hr

    // Head-control mode: map IMU pitch/roll directly onto geometry orientation,
    // overriding any GSAP auto-rotate tweens
    if (this.properties.headControl && headPose) {
      gsap.killTweensOf(this.holderObjects.rotation)
      const imuStr = this.influences.imu * 0.8
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

    const buttonShowCylinder = {
      showCylinder: () => {
        this.destroyMesh()
        this.createCylinderMesh()
        this.properties.autoMix = false
      },
    }
    visualizerFolder.add(buttonShowCylinder, 'showCylinder').name('Reset Cylinder')

    const influenceFolder = gui.addFolder('INFLUENCE')
    influenceFolder.add(this.influences, 'eeg', 0, 3).name('EEG Strength')
    influenceFolder.add(this.influences, 'hr',  0, 3).name('HR Strength')
    influenceFolder.add(this.influences, 'imu', 0, 3).name('IMU Strength')
  }
}
