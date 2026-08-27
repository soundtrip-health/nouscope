/**
 * HelixView — the artistic 3D rendering of the session timeline.
 *
 * The last `PANEL_WINDOWS.helix` seconds of raw EEG are laid along a helical
 * form, one strand per electrode, braided 90° apart around the helix axis.
 * Newest data is at the head; time extrudes away at constant speed. By default
 * the form faces the viewer — the axis points at the camera, so the newest
 * samples read as a circle of raw waveform up front; tilting the head swings
 * it toward the side (profile) view. Every visual quantity is derived from the
 * SessionStore at an
 * absolute time, never from live manager state, so the view is scrub-correct:
 * it works following the ● LIVE edge, dragged back through history, and on
 * loaded .jsonl files identically.
 *
 * Frozen history: each segment's spiral tightness (turn rate + radius) is set
 * by the MSE complexity *at the time that segment was written* — higher
 * entropy opens the form (slower turns, larger radius). Because tightness
 * depends only on `complexity(t)`, history never re-shapes as new values
 * arrive.
 *
 * Split of work:
 *  - CPU, throttled to cursor movement (`_rebuild`): integrate the helix
 *    centerline (θ anchored at the head so the newest point is angularly
 *    stable), radial/tangent vectors, normalized EEG values, quality weights.
 *  - GPU, every frame: radial EEG displacement, camera-facing ribbon
 *    expansion, traveling heartbeat brightness pulse, quality ghosting.
 *
 * Owns its own rAF loop (the Scrubber's loop skips idle frames, which would
 * freeze the pose easing and idle spin while paused). `renderAt` — called
 * from the Scrubber's fan-out — only caches the store and cursor.
 */

import * as THREE from 'three'
import { PANEL_WINDOWS, EEG_SCALE, MSE_Y_MAX } from './bioRender'

// ── Sampling ────────────────────────────────────────────────────────────────
const WINDOW_S     = PANEL_WINDOWS.helix   // seconds of history shown
const EEG_FS       = 256
const HELIX_STRIDE = 4                     // 256 Hz → 64 Hz effective
const HELIX_FS     = EEG_FS / HELIX_STRIDE
const N            = WINDOW_S * HELIX_FS   // points per strand (3840)

// ── Form (aesthetic knobs — tune here, structure never depends on them) ─────
const HELIX_HEIGHT    = 6.0    // world units spanned by the full window
const R_MIN           = 0.6    // radius at zero complexity (tight coil)
const R_MAX           = 1.6    // radius at MSE_Y_MAX (open form)
const TURNS_CALM      = 0.28   // turns/s at zero complexity
const TURNS_OPEN      = 0.12   // turns/s at MSE_Y_MAX
const DEFAULT_N       = 0.4    // normalized complexity before any MSE exists
const EEG_GAIN        = 0.70   // world units per EEG_SCALE µV of deflection
const HALF_WIDTH      = 0.03   // ribbon half-width, world units
const BASE_OPACITY    = 0.85
// Motion
const FACE_TILT_X     = Math.PI / 2  // base tilt: axis toward the viewer (face-on default)
const POSE_GAIN       = 2.0    // head pitch/roll → form rotation (~45° tilt = side view)
const POSE_TAU        = 0.25   // s, easing time constant toward target pose
const IDLE_SPIN_RAD_S = 0.05   // slow presentational spin about the helix axis, always on
// Sharp head rotations (gyro above SPIN_THRESH_DPS) impart screen-space spin:
// a rapid head turn (gyro z) spins the form left/right, a quick nod (gyro y)
// tumbles it up/down. SPIN_GAIN is rad/s of spin per degree of sharp rotation,
// sized with SPIN_DAMP_TAU so a brisk ~60–90° movement (velocity · tau ≥ 2π)
// carries the form through at least one full revolution before winding down.
const SPIN_THRESH_DPS = 100    // below this, head motion imparts no spin
const SPIN_GAIN       = 0.05   // deg of sharp rotation → rad/s of spin velocity
const SPIN_DAMP_TAU   = 2.0    // s, spin velocity decay
// Pulse
const PULSE_VEL       = 20.0   // seconds-of-helix-arc traversed per second
const PULSE_AMP       = 0.5    // brightness modulation depth
// Rebuild throttle: geometry only rebuilds when the cursor has moved this far
// (~12 Hz while following live; any seek exceeds it instantly; paused → none).
const REBUILD_EPS_S   = 0.08

const Q_WEIGHT = { good: 1.0, marginal: 0.5, poor: 0.0 }

// ── Strand palettes ─────────────────────────────────────────────────────────
// One themed family per palette, four close-hue colors (TP9, AF7, AF8, TP10 in
// that order) — related enough to read as one form under additive blending on
// the black background, varied enough that a single strand can still be
// followed. The user cycles these with the palette button; the choice persists
// per browser in localStorage.
const PALETTES = [
  { name: 'Aurora', colors: ['#35d0aa', '#2fa8c8', '#55e07a', '#8ae0c0'] },
  { name: 'Ember',  colors: ['#ff9d4d', '#f2694a', '#d94f68', '#ffc37a'] },
  { name: 'Violet', colors: ['#a86ef5', '#7d5ce8', '#c9a1ff', '#e07ad0'] },
  { name: 'Ocean',  colors: ['#4aa8ff', '#3d7de8', '#7ac8ff', '#5ee0d8'] },
  { name: 'Moon',   colors: ['#e8e8f0', '#a8b0c0', '#c8d0e0', '#8890a8'] },
]
const PALETTE_LS_KEY = 'nouscope-helix-palette'

const VERT_SHADER = /* glsl */ `
  uniform float uEegGain;
  uniform float uHalfWidth;
  attribute vec3 aRadial;
  attribute vec3 aTangent;
  attribute vec2 aData;    // (eegNorm, quality)
  attribute vec2 aStatic;  // (side ±1, age seconds)
  varying float vAge;
  varying float vQuality;
  varying float vSide;
  varying float vEegMag;

  void main() {
    vec3 center = position + aRadial * (aData.x * uEegGain);
    vec4 world  = modelMatrix * vec4(center, 1.0);
    vec3 viewDir  = normalize(cameraPosition - world.xyz);
    vec3 tangentW = normalize(mat3(modelMatrix) * aTangent);
    vec3 side     = normalize(cross(tangentW, viewDir));
    float taper   = mix(0.6, 1.0, 1.0 - aStatic.y / ${WINDOW_S.toFixed(1)});
    world.xyz += side * (aStatic.x * uHalfWidth * taper);
    gl_Position = projectionMatrix * viewMatrix * world;
    vAge = aStatic.y; vQuality = aData.y; vSide = aStatic.x; vEegMag = abs(aData.x);
  }
`

const FRAG_SHADER = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uPulsePhase;  // heartbeat phase at the head (radians)
  uniform float uOmega;       // 2π·bpm/60 at the cursor
  uniform float uPulseVel;
  uniform float uPulseAmp;    // 0 when no HR data
  varying float vAge;
  varying float vQuality;
  varying float vSide;
  varying float vEegMag;

  void main() {
    // Cubed-sine pulse traveling down the helix from the newest point — the
    // same waveform shape as EEGManager's live heartPulse oscillator.
    float ph    = uPulsePhase - (vAge / uPulseVel) * uOmega;
    float s     = (sin(ph) + 1.0) * 0.5;
    float pulse = s * s * s * uPulseAmp;
    vec3  rgb   = uColor * (1.0 + pulse + 0.4 * vEegMag);
    float edge  = smoothstep(1.0, 0.6, abs(vSide));   // soft ribbon edges
    float alpha = (uOpacity * edge + 0.3 * pulse) * vQuality;
    gl_FragColor = vec4(rgb, alpha);
  }
`

export default class HelixView {
  constructor() {
    this._inited    = false
    this._suspended = false
    this._visible   = false
    this._raf       = 0
    this._lastMs    = 0
    // Cached by renderAt (the Scrubber fan-out); consumed by _frame.
    this._store  = null
    this._cursor = 0
    this._builtCursor = -Infinity
    // Motion state — gyro-impulse spin velocities (screen-space x/y) and the
    // cursor position spin impulses were last integrated up to.
    this._spinVelX = 0
    this._spinVelY = 0
    this._spinCursor = null
    // Per-second quality-weight cache (60 s × 4 ch), stamped by floor(cursor·2)
    this._qw      = new Float32Array(WINDOW_S * 4)
    this._qwStamp = -1
    // Strand palette — restore the last choice (default: first palette)
    this._paletteIdx = 0
    try {
      const saved = localStorage.getItem(PALETTE_LS_KEY)
      const idx = PALETTES.findIndex((p) => p.name === saved)
      if (idx >= 0) this._paletteIdx = idx
    } catch { /* storage unavailable — keep the default */ }
    // Scratch buffers reused across rebuilds (no per-frame allocation of these)
    this._n     = new Float32Array(N)      // normalized complexity per point
    this._theta = new Float32Array(N)      // integrated angle (before strand phase)
    this._y     = new Float32Array(N)
    this._r     = new Float32Array(N)
    this._cline = new Float32Array(N * 3)  // one strand's centerline, reused
  }

  /** Scrubber fan-out sink — cache only; all work happens in the rAF loop. */
  renderAt(store, cursor) {
    this._store  = store
    this._cursor = cursor
  }

  /** Lazy GL setup; safe to call repeatedly. */
  init() {
    if (this._inited) return
    const canvas = document.getElementById('helix-canvas')
    this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this._renderer.setClearColor(0x000000, 1)
    this._scene  = new THREE.Scene()
    this._camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50)
    this._camera.position.set(0, 0.6, 9)
    this._camera.lookAt(0, 0, 0)
    // Outer group: accumulated screen-space spin from gyro impulses.
    // Inner group: face-on base tilt + eased head pose + idle spin.
    this._spinGroup = new THREE.Group()
    this._scene.add(this._spinGroup)
    this._group = new THREE.Group()
    this._group.rotation.x = FACE_TILT_X
    this._spinGroup.add(this._group)
    const palette = PALETTES[this._paletteIdx]
    this._strands = palette.colors.map((hex) => {
      const mesh = this._makeStrand(new THREE.Color(hex))
      this._group.add(mesh)
      return mesh
    })
    this._builtCursor = -Infinity
    this._qwStamp = -1
    this._inited = true
  }

  /** Show/hide the view; owns the rAF lifecycle. */
  setVisible(on) {
    this._visible = on
    const wrap = document.getElementById('helix-view')
    if (wrap) wrap.hidden = !on
    if (on) {
      if (!this._inited) this.init()
      this.resize()
      this._builtCursor = -Infinity   // force a rebuild on first frame back
      if (!this._raf) {
        this._lastMs = performance.now()
        this._raf = requestAnimationFrame((ms) => this._frame(ms))
      }
    } else if (this._raf) {
      cancelAnimationFrame(this._raf)
      this._raf = 0
    }
  }

  resize() {
    if (!this._inited) return
    const canvas = this._renderer.domElement
    const rect = canvas.parentElement.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this._renderer.setPixelRatio(dpr)
    this._renderer.setSize(rect.width, rect.height, false)
    this._camera.aspect = rect.width / Math.max(1, rect.height)
    this._camera.updateProjectionMatrix()
  }

  /**
   * Free the GL context so another view can use the budget (browsers cap live
   * contexts at ~16). A lost context can never be revived on the same canvas,
   * so the canvas is swapped for a clone — same pattern as AnalysisDisplay.
   */
  suspend() {
    if (!this._inited) return
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0 }
    this._renderer.dispose()
    this._renderer.forceContextLoss()
    const canvas = this._renderer.domElement
    canvas.replaceWith(canvas.cloneNode(true))
    this._renderer = this._scene = this._camera = this._group = this._spinGroup = null
    this._strands = null
    this._inited = false
    this._suspended = true
  }

  /** Recreate GL after suspend(), restoring visibility if it was shown. */
  resume() {
    if (!this._suspended) return
    this._suspended = false
    if (this._visible) this.setVisible(true)
  }

  /** Name of the active strand palette (for the cycle button's label). */
  get paletteName() {
    return PALETTES[this._paletteIdx].name
  }

  /** Advance to the next palette, persist the choice, and return its name. */
  cyclePalette() {
    this._paletteIdx = (this._paletteIdx + 1) % PALETTES.length
    const palette = PALETTES[this._paletteIdx]
    try { localStorage.setItem(PALETTE_LS_KEY, palette.name) } catch { /* ignore */ }
    if (this._strands) {
      this._strands.forEach((mesh, ch) => {
        mesh.material.uniforms.uColor.value.set(palette.colors[ch])
      })
    }
    return palette.name
  }

  // ── Frame loop ────────────────────────────────────────────────────────────

  _frame(nowMs) {
    this._raf = this._visible ? requestAnimationFrame((ms) => this._frame(ms)) : 0
    if (!this._inited || !this._visible) return
    const dt = Math.min(0.1, (nowMs - this._lastMs) / 1000) || 0.016
    this._lastMs = nowMs

    const store = this._store
    if (store) {
      const cursor = this._cursor
      if (Math.abs(cursor - this._builtCursor) > REBUILD_EPS_S) {
        this._rebuild(store, cursor)
        this._builtCursor = cursor
      }

      // Pulse: phase is cursor-derived, so it freezes when playback pauses.
      const phase = store.heartPhaseAt(cursor)
      const hr    = store.sampleAt('hr', cursor)
      const bpm   = hr && hr.bpm > 0 ? hr.bpm : 0
      for (const mesh of this._strands) {
        const u = mesh.material.uniforms
        u.uPulsePhase.value = phase ?? 0
        u.uOmega.value      = (bpm / 60) * 2 * Math.PI
        u.uPulseAmp.value   = phase !== null && bpm > 0 ? PULSE_AMP : 0
      }

      // Head pose (from stored accel, not live EEGManager state) eased toward,
      // as an offset from the face-on base tilt: neutral head = face-on view,
      // ~45° of pitch swings the form all the way to the side (profile) view.
      const pose = store.headPoseAt(cursor)
      const tx = FACE_TILT_X + (pose ? pose.pitch * POSE_GAIN : 0)
      const tz = pose ? pose.roll * POSE_GAIN : 0
      const k = 1 - Math.exp(-dt / POSE_TAU)
      this._group.rotation.x += (tx - this._group.rotation.x) * k
      this._group.rotation.z += (tz - this._group.rotation.z) * k

      // Idle spin about the helix's own axis (in-plane rotation when face-on).
      this._group.rotation.y += IDLE_SPIN_RAD_S * dt

      // Damped spin impulses from sharp head rotations, on the outer group in
      // screen space: a rapid head turn (gyro z) spins the form left/right, a
      // quick nod (gyro y) tumbles it up/down. Impulses integrate over
      // *session* time traversed (dCur), so a paused playhead parked on a
      // sharp movement can't wind the spin up forever and replay reproduces
      // the same kick; the wind-down runs on wall-clock time like idle spin.
      const dCur = this._spinCursor === null
        ? 0 : Math.min(0.1, Math.max(0, cursor - this._spinCursor))
      this._spinCursor = cursor
      const gy = this._gyroMean(store, cursor, 1)
      const gz = this._gyroMean(store, cursor, 2)
      const decay = Math.exp(-dt / SPIN_DAMP_TAU)
      this._spinVelY = (this._spinVelY + this._sharp(gz) * SPIN_GAIN * dCur) * decay
      this._spinVelX = (this._spinVelX + this._sharp(gy) * SPIN_GAIN * dCur) * decay
      this._spinGroup.rotation.y += this._spinVelY * dt
      this._spinGroup.rotation.x += this._spinVelX * dt
    }

    this._renderer.render(this._scene, this._camera)
  }

  /** Gate for spin impulses — only sharp rotations count. */
  _sharp(dps) {
    return Math.abs(dps) > SPIN_THRESH_DPS ? dps : 0
  }

  /** Mean gyro (dps) of one channel over the 0.25 s before the cursor; 0 if none. */
  _gyroMean(store, cursor, ch) {
    const g = store.gyro
    if (!g || !g.length) return 0
    const s1 = Math.min(g.length, Math.floor(cursor * g.fs))
    const slice = g.channelSlice(ch, s1 - Math.round(g.fs * 0.25), s1)
    let sum = 0, cnt = 0
    for (let i = 0; i < slice.length; i++) {
      const v = slice[i]
      if (!Number.isNaN(v)) { sum += v; cnt++ }
    }
    return cnt ? sum / cnt : 0
  }

  // ── Geometry ──────────────────────────────────────────────────────────────

  /**
   * CPU pass, run only when the cursor moved: integrate the centerline and
   * refill the dynamic attributes of all four strands.
   */
  _rebuild(store, cursor) {
    // Clamp to actually-written EEG so the head of the helix isn't a blank
    // stub while following live (same reasoning as the envelope tail clamp).
    const t1 = Math.min(cursor, store.eeg.durationS())
    const s1 = Math.floor(t1 * EEG_FS)
    const s0 = s1 - WINDOW_S * EEG_FS
    const dt = 1 / HELIX_FS

    // Normalized complexity per point — single merge-walk over the sorted MSE
    // records (frozen history: depends only on the absolute time of each point).
    const mse = store.mse
    const nArr = this._n
    let j = 0
    for (let i = 0; i < N; i++) {
      const t = t1 - (N - 1 - i) * dt
      let c = null
      if (mse.length) {
        while (j + 1 < mse.length && mse[j + 1].t <= t) j++
        if (t <= mse[0].t) c = mse[0].complexity
        else if (j + 1 >= mse.length) c = mse[mse.length - 1].complexity
        else {
          const a = mse[j], b = mse[j + 1]
          c = a.complexity + (b.complexity - a.complexity) * ((t - a.t) / (b.t - a.t))
        }
      }
      nArr[i] = c === null ? DEFAULT_N : Math.min(1, Math.max(0, c / MSE_Y_MAX))
    }

    // Centerline basis: y from age, r from complexity, θ integrated downward
    // from the head (θ_head = 0) so the newest point is angularly stable.
    const theta = this._theta, yArr = this._y, rArr = this._r
    theta[N - 1] = 0
    for (let i = N - 1; i > 0; i--) {
      const f = TURNS_CALM - nArr[i] * (TURNS_CALM - TURNS_OPEN)   // turns/s
      theta[i - 1] = theta[i] - 2 * Math.PI * f * dt
    }
    for (let i = 0; i < N; i++) {
      yArr[i] = HELIX_HEIGHT / 2 - ((N - 1 - i) * dt) * (HELIX_HEIGHT / WINDOW_S)
      rArr[i] = R_MIN + nArr[i] * (R_MAX - R_MIN)
    }

    const qw = this._qualityWeights(store, cursor)

    for (let ch = 0; ch < 4; ch++) {
      const raw   = store.eeg.channelSlice(ch, s0, s1)
      const mesh  = this._strands[ch]
      const attrs = mesh.geometry.attributes
      const pos = attrs.position.array
      const rad = attrs.aRadial.array
      const tan = attrs.aTangent.array
      const dat = attrs.aData.array
      const phase = ch * Math.PI / 2
      const cl = this._cline

      for (let i = 0; i < N; i++) {
        const th = theta[i] + phase
        const c = Math.cos(th), s = Math.sin(th)
        cl[i * 3]     = rArr[i] * c
        cl[i * 3 + 1] = yArr[i]
        cl[i * 3 + 2] = rArr[i] * s
        // Radial + EEG value + quality, duplicated across the side pair.
        const v = raw[i * HELIX_STRIDE]
        const eeg = Number.isNaN(v) ? 0 : Math.max(-1.5, Math.min(1.5, v / EEG_SCALE))
        const q   = Number.isNaN(v) ? 0 : qw[Math.min(WINDOW_S - 1, Math.floor((N - 1 - i) * dt)) * 4 + ch]
        for (const k of [i * 2, i * 2 + 1]) {
          rad[k * 3] = c; rad[k * 3 + 1] = 0; rad[k * 3 + 2] = s
          dat[k * 2] = eeg; dat[k * 2 + 1] = q
        }
      }
      for (let i = 0; i < N; i++) {
        const i0 = Math.max(0, i - 1) * 3, i1 = Math.min(N - 1, i + 1) * 3
        let tx = cl[i1] - cl[i0], ty = cl[i1 + 1] - cl[i0 + 1], tz = cl[i1 + 2] - cl[i0 + 2]
        const len = Math.hypot(tx, ty, tz) || 1
        tx /= len; ty /= len; tz /= len
        for (const k of [i * 2, i * 2 + 1]) {
          pos[k * 3] = cl[i * 3]; pos[k * 3 + 1] = cl[i * 3 + 1]; pos[k * 3 + 2] = cl[i * 3 + 2]
          tan[k * 3] = tx; tan[k * 3 + 1] = ty; tan[k * 3 + 2] = tz
        }
      }
      attrs.position.needsUpdate = true
      attrs.aRadial.needsUpdate  = true
      attrs.aTangent.needsUpdate = true
      attrs.aData.needsUpdate    = true
    }
  }

  /**
   * Per-second quality weights over the window (WINDOW_S × 4 channels),
   * recomputed at most twice a second — qualityAt costs a 1 s RMS scan.
   */
  _qualityWeights(store, cursor) {
    const stamp = Math.floor(cursor * 2)
    if (stamp === this._qwStamp) return this._qw
    this._qwStamp = stamp
    for (let m = 0; m < WINDOW_S; m++) {
      const t = cursor - m   // m seconds of age; before the session start there
      const labels = t >= 0 ? store.qualityAt(t) : null   // is nothing to rate
      for (let ch = 0; ch < 4; ch++) {
        this._qw[m * 4 + ch] = labels ? (Q_WEIGHT[labels[ch]] ?? 0) : 0
      }
    }
    return this._qw
  }

  _makeStrand(color) {
    const geo = new THREE.BufferGeometry()
    const verts = N * 2
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aRadial',  new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aTangent', new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aData',    new THREE.BufferAttribute(new Float32Array(verts * 2), 2).setUsage(THREE.DynamicDrawUsage))
    // Static: (side, age). Index i always means the same age in a
    // right-anchored window, so this never needs to change.
    const stat = new Float32Array(verts * 2)
    for (let i = 0; i < N; i++) {
      const age = (N - 1 - i) / HELIX_FS
      stat[(i * 2) * 2] = -1;    stat[(i * 2) * 2 + 1] = age
      stat[(i * 2 + 1) * 2] = 1; stat[(i * 2 + 1) * 2 + 1] = age
    }
    geo.setAttribute('aStatic', new THREE.BufferAttribute(stat, 2))
    const index = new Uint32Array((N - 1) * 6)
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2, o = i * 6
      index[o] = a; index[o + 1] = a + 1; index[o + 2] = a + 2
      index[o + 3] = a + 1; index[o + 4] = a + 3; index[o + 5] = a + 2
    }
    geo.setIndex(new THREE.BufferAttribute(index, 1))

    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT_SHADER,
      fragmentShader: FRAG_SHADER,
      uniforms: {
        uColor:      { value: color },
        uOpacity:    { value: BASE_OPACITY },
        uEegGain:    { value: EEG_GAIN },
        uHalfWidth:  { value: HALF_WIDTH },
        uPulsePhase: { value: 0 },
        uOmega:      { value: 0 },
        uPulseVel:   { value: PULSE_VEL },
        uPulseAmp:   { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geo, mat)
    // Positions churn every rebuild; skip stale bounding-sphere culling.
    mesh.frustumCulled = false
    return mesh
  }
}
