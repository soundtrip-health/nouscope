/**
 * HelixView — the artistic 3D rendering of the session timeline.
 *
 * The last `PANEL_WINDOWS.helix` seconds of raw EEG are laid along a helical
 * form, one strand per electrode, braided 90° apart around the helix axis.
 * Newest data is at the head; time extrudes away at constant speed. By default
 * the form faces the viewer — the axis points at the camera, so the newest
 * samples read as a circle of raw waveform up front; tilting the head swings
 * it toward the side (profile) view, and both the pose offset and any gyro
 * spin always settle back to that face-on default. Recency is emphasized:
 * older coils fade, thin, and recede with perspective while the newest few
 * seconds glow. Behind the form, slowly swirling palette-tinted clouds fill
 * the frame — their swirl loosely follows the EEG's multiscale entropy (calm
 * → long laminar bands, complex → tight turbulent curls) — and a
 * palette-tinted particle field drifts through them toward the viewer.
 * Clouds, motes and strands all breathe on the heartbeat, whose phase comes
 * from `SessionStore.pulseAt` (a beat-locked, accelerometer-conditioned
 * harmonic fit of the stored PPG — §4b) rather than a free-running rate
 * oscillator. Every visual quantity is derived from the SessionStore at an
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
 *    expansion, traveling heartbeat brightness pulse, quality ghosting; the
 *    cloud backdrop (a reduced-resolution render target) and particle field.
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
// Once the spin has wound down, the outer group eases back to the nearest full
// revolution (identity, shortest way round) so the form always settles face-on
// again instead of being left stranded at whatever angle the spin ended on.
const SPIN_SETTLE_VEL = 0.3    // rad/s of remaining spin below which the return engages
const SPIN_RETURN_TAU = 1.2    // s, easing back to face-on after a spin
// The pose target is the *offset* from a slowly-adapting baseline, not from
// absolute gravity — so a headset worn at an angle, or a tilt the user holds,
// relaxes back to the face-on view over ~POSE_REF_TAU instead of parking the
// form off-axis forever. Transient tilts still swing the view immediately.
const POSE_REF_TAU    = 6.0    // s, neutral-pose baseline adaptation
// Pulse — phase/rate/reliability from SessionStore.pulseAt (beat-locked)
const PULSE_VEL       = 20.0   // seconds-of-helix-arc traversed per second
const PULSE_AMP       = 0.5    // brightness modulation depth
// Pulse amplitude follows fit reliability: fully on above PULSE_W_HI, off
// below PULSE_W_LO (motion artifact / no PPG), eased over PULSE_GAIN_TAU so the
// pulse fades rather than cutting out. PULSE_JUMP_TAU: while playing
// continuously, any discontinuity in the phase source (the live edge's next
// fit landing) is absorbed into an offset that decays away, so the visible
// pulse never skips; a seek resets the offset so the phase snaps instead.
const PULSE_W_LO      = 0.25
const PULSE_W_HI      = 0.55
const PULSE_GAIN_TAU  = 1.0    // s
const PULSE_JUMP_TAU  = 1.5    // s
const PULSE_SEEK_S    = 0.25   // cursor jump beyond this counts as a seek
// Recency emphasis: the newest data is the subject — older coils fade toward
// FADE_MIN alpha, thin toward TAIL_TAPER width, and the head few seconds get
// an extra brightness lift. Combined with the perspective camera (old data is
// farther away in the face-on view) history recedes but is still there,
// regaining prominence when the form swings to the side.
const FADE_MIN        = 0.15   // alpha multiplier at the oldest sample
const TAIL_TAPER      = 0.3    // ribbon width multiplier at the oldest sample
const HEAD_GLOW_S     = 4.0    // seconds of extra brightness at the head
const HEAD_GLOW       = 0.35   // brightness lift at age 0
// Background particle field: palette-tinted motes drifting slowly toward the
// viewer (the same direction time flows along the helix), twinkling, and
// breathing brighter on the heartbeat pulse. Entirely shader-animated — the
// CPU only advances uTime.
const PARTICLE_COUNT  = 1400
const PARTICLE_SPREAD = 9      // x/y half-extent of the field, world units
const PARTICLE_NEAR   = 5.0    // wrap plane nearest the camera (world z)
const PARTICLE_FAR    = -24.0  // wrap plane farthest from the camera (world z)
const PARTICLE_DRIFT  = 0.3    // world units/s toward the viewer
// Cloud backdrop: domain-warped value-noise clouds on a fullscreen quad,
// rendered at CLOUD_RES × the canvas's CSS size (clouds are smooth, so the
// upsample is invisible and the fill cost stays small). Swirl shape follows
// the normalized MSE complexity at the cursor, eased over CLOUD_SWIRL_TAU
// ("loosely coupled"): low entropy stretches the field into long laminar
// bands with gentle warping; high entropy tightens it into turbulent curls
// with stronger rotation and rougher detail. Cloud time runs on the wall
// clock (presentational, like idle spin), paced slightly faster with entropy.
const CLOUD_RES         = 0.4
const CLOUD_SWIRL_TAU   = 5.0  // s, entropy → swirl easing
const CLOUD_PACE_CALM   = 0.7  // cloud-seconds per wall second at n = 0
const CLOUD_PACE_OPEN   = 1.4  // at n = 1
const CLOUD_PULSE_LIFT  = 0.22 // brightness lift at systole
const CLOUD_PULSE_DILATE= 0.03 // radial dilation of the field at systole
// Rebuild throttle: geometry only rebuilds when the cursor has moved this far
// (~12 Hz while following live; any seek exceeds it instantly; paused → none).
const REBUILD_EPS_S   = 0.08

const Q_WEIGHT = { good: 1.0, marginal: 0.5, poor: 0.0 }

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
/** Wrap an angle to (−π, π]. */
function wrapPi(x) {
  const TWO_PI = 2 * Math.PI
  x %= TWO_PI
  if (x < 0) x += TWO_PI
  return x > Math.PI ? x - TWO_PI : x
}

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
    float taper   = mix(${TAIL_TAPER.toFixed(2)}, 1.0, 1.0 - aStatic.y / ${WINDOW_S.toFixed(1)});
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
    // Cubed-cosine pulse traveling down the helix from the newest point:
    // phase 0 ≡ systolic peak (SessionStore.pulseAt convention), sharp rise
    // and slow decay like the systolic/diastolic shape of a PPG cycle.
    float ph    = uPulsePhase - (vAge / uPulseVel) * uOmega;
    float s     = (cos(ph) + 1.0) * 0.5;
    float pulse = s * s * s * uPulseAmp;
    // Recency: newest few seconds glow, old coils fade toward FADE_MIN.
    float head  = ${HEAD_GLOW.toFixed(2)} * smoothstep(${HEAD_GLOW_S.toFixed(1)}, 0.0, vAge);
    float fade  = mix(1.0, ${FADE_MIN.toFixed(2)}, smoothstep(0.0, 0.9, vAge / ${WINDOW_S.toFixed(1)}));
    vec3  rgb   = uColor * (1.0 + pulse + 0.4 * vEegMag + head);
    float edge  = smoothstep(1.0, 0.6, abs(vSide));   // soft ribbon edges
    float alpha = (uOpacity * edge + 0.3 * pulse) * vQuality * fade;
    gl_FragColor = vec4(rgb, alpha);
  }
`

// Background particle field. Each mote's motion is a pure function of its
// static seed/position attributes and uTime, so the whole field animates on
// the GPU: a slow constant drift toward the viewer (wrapping between the far
// and near planes), a gentle per-mote sideways sway, and a seeded twinkle.
// Motes fade in at the far plane and out before reaching the camera.
const PARTICLE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aSeed;
  varying float vFade;
  varying float vMix;

  void main() {
    vec3 p = position;
    float span = ${(PARTICLE_NEAR - PARTICLE_FAR).toFixed(1)};
    p.z  = ${PARTICLE_FAR.toFixed(1)} + mod(p.z - ${PARTICLE_FAR.toFixed(1)} + uTime * ${PARTICLE_DRIFT.toFixed(2)}, span);
    p.x += sin(uTime * 0.05 + aSeed * 6.2832)  * 0.5;
    p.y += cos(uTime * 0.04 + aSeed * 12.566)  * 0.4;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position  = projectionMatrix * mv;
    gl_PointSize = mix(1.5, 4.0, fract(aSeed * 5.1)) * uPixelRatio
                 * clamp(9.0 / -mv.z, 0.2, 2.2);
    float tw   = 0.55 + 0.45 * sin(uTime * mix(0.3, 1.5, fract(aSeed * 7.31)) + aSeed * 40.0);
    float far  = smoothstep(${PARTICLE_FAR.toFixed(1)}, ${(PARTICLE_FAR + 6).toFixed(1)}, p.z);
    float near = 1.0 - smoothstep(${(PARTICLE_NEAR - 4).toFixed(1)}, ${PARTICLE_NEAR.toFixed(1)}, p.z);
    vFade = tw * far * near;
    vMix  = fract(aSeed * 3.7);
  }
`

const PARTICLE_FRAG = /* glsl */ `
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform float uPulse;    // heartbeat pulse at the cursor (0–1), 0 without HR
  varying float vFade;
  varying float vMix;

  void main() {
    float d    = length(gl_PointCoord - 0.5);
    float disc = smoothstep(0.5, 0.08, d);      // soft round sprite
    vec3  col  = mix(uColorA, uColorB, vMix) * (0.85 + 0.5 * uPulse);
    gl_FragColor = vec4(col, disc * vFade * (0.35 + 0.3 * uPulse));
  }
`

// Cloud backdrop. Rendered off-screen at reduced resolution into a render
// target, then blitted as the first thing in the main scene. Domain-warped
// fbm (Quilez-style p → fbm(p + warp·rot(q)) → fbm(p + warp·rot(r))) with a
// large-scale rotation field: the per-point warp direction is rotated by an
// angle drawn from a slowly-evolving low-frequency noise, scaled by uSwirl —
// that rotation is what turns drifting bands into eddies. Every shape
// parameter (anisotropic stretch, warp amplitude, swirl angle, octave gain)
// is a mix on uSwirl, so the coupling to entropy is continuous.
const CLOUD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const CLOUD_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;     // cloud time (entropy-paced seconds)
  uniform vec2  uAspect;   // (width/height, 1)
  uniform float uSwirl;    // eased normalized entropy, 0–1
  uniform float uPulse;    // heartbeat pulse 0–1, already reliability-gated
  uniform vec3  uColorA;   // body tint
  uniform vec3  uColorB;   // bright tint
  uniform vec3  uColorC;   // highlight tint in turbulent regions
  varying vec2 vUv;

  float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic — no visible cells
    float n000 = hash(i),                   n100 = hash(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash(i + vec3(0.0, 1.0, 0.0)), n110 = hash(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash(i + vec3(0.0, 0.0, 1.0)), n101 = hash(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash(i + vec3(0.0, 1.0, 1.0)), n111 = hash(i + vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
               mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }
  float fbm(vec3 p, float gain) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= gain;
    }
    return v;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * 2.0 * uAspect;    // centered, aspect-correct
    float n = uSwirl;
    // Heartbeat breath: the whole field dilates from the center at systole.
    vec2 p = uv / (1.0 + ${CLOUD_PULSE_DILATE.toFixed(3)} * uPulse);
    // Entropy → form: calm = long horizontal bands, complex = isotropic curls.
    p.x *= mix(0.55, 1.0, n);
    p *= 1.5;
    float gain = mix(0.46, 0.58, n);         // roughness of fine detail
    float t = uTime;
    // Large-scale rotation field — the swirl. Its angle range grows with n.
    float ang = mix(0.5, 3.4, n) * (fbm(vec3(p * 0.3, t * 0.02), 0.5) - 0.5) * 2.0;
    mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
    float warp = mix(1.0, 2.8, n);
    vec2 q = vec2(fbm(vec3(p, t * 0.05), gain),
                  fbm(vec3(p + vec2(5.2, 1.3), t * 0.05 + 3.0), gain)) - 0.5;
    q = R * q;
    vec2 pq = p + warp * q;
    vec2 r = vec2(fbm(vec3(pq + vec2(1.7, 9.2), t * 0.04), gain),
                  fbm(vec3(pq + vec2(8.3, 2.8), t * 0.04 + 7.0), gain)) - 0.5;
    r = R * r;
    float f = fbm(vec3(p + warp * r, t * 0.03), gain);
    // Density and tinting
    float body   = smoothstep(0.28, 0.80, f);
    float bright = smoothstep(0.55, 0.95, f);
    float eddy   = clamp(length(r) * 2.2, 0.0, 1.0) * body;   // highlights where the warp is strongest
    vec3 col = uColorA * 0.42 * body;
    col = mix(col, uColorB * 0.55, bright * 0.75);
    col += uColorC * 0.22 * eddy;
    // Keep the center darker so the helix stays the subject; soft vignette.
    float rad = length(uv);
    col *= mix(0.35, 1.0, smoothstep(0.0, 1.25, rad));
    col *= 1.0 - 0.45 * smoothstep(1.1, 2.0, rad);
    col *= 1.0 + ${CLOUD_PULSE_LIFT.toFixed(3)} * uPulse;
    gl_FragColor = vec4(col, 1.0);
  }
`

// Blit of the cloud render target as the main scene's backdrop (drawn first,
// no depth), so the additive strands and motes composite over it.
const BACKDROP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`
const BACKDROP_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(uMap, vUv).rgb, 1.0); }
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
    // Slow-adapting neutral-pose baseline (pose offsets are measured from it)
    this._poseRef = null
    // Wall-clock seconds driving the particle field's shader animation
    this._timeS = 0
    // Cloud backdrop state: eased normalized entropy and entropy-paced time
    this._swirl  = DEFAULT_N
    this._cloudT = 0
    // Pulse state: eased reliability gain, jump-absorbing phase offset, and
    // the (phase, cursor) the previous frame showed
    this._pulseGain   = 0
    this._pulseOffset = 0
    this._pulsePrev   = null   // { phase, cursor }
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
    // Wide FOV + close camera exaggerate depth: in the face-on view the oldest
    // coils (farthest away) shrink markedly, emphasizing the newest data.
    this._camera = new THREE.PerspectiveCamera(60, 1, 0.1, 50)
    this._camera.position.set(0, 0.6, 7.2)
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
    // Cloud backdrop (off-screen pass) and its blit quad, then the particle
    // field — both sit directly on the scene as fixed fields the helix
    // rotates within, not something that swings with head pose.
    this._makeClouds(palette)
    this._particles = this._makeParticles(palette)
    this._scene.add(this._particles)
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
    if (this._particles) this._particles.material.uniforms.uPixelRatio.value = dpr
    if (this._cloudRT) {
      this._cloudRT.setSize(Math.max(1, Math.round(rect.width * CLOUD_RES)),
                            Math.max(1, Math.round(rect.height * CLOUD_RES)))
      this._cloudMat.uniforms.uAspect.value.set(rect.width / Math.max(1, rect.height), 1)
    }
  }

  /**
   * Free the GL context so another view can use the budget (browsers cap live
   * contexts at ~16). A lost context can never be revived on the same canvas,
   * so the canvas is swapped for a clone — same pattern as AnalysisDisplay.
   */
  suspend() {
    if (!this._inited) return
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0 }
    if (this._cloudRT) { this._cloudRT.dispose(); this._cloudRT = null }
    this._cloudScene = this._cloudCamera = this._cloudMat = null
    this._renderer.dispose()
    this._renderer.forceContextLoss()
    const canvas = this._renderer.domElement
    canvas.replaceWith(canvas.cloneNode(true))
    this._renderer = this._scene = this._camera = this._group = this._spinGroup = null
    this._strands = null
    this._particles = null
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
    if (this._particles) {
      const u = this._particles.material.uniforms
      u.uColorA.value.set(palette.colors[0])
      u.uColorB.value.set(palette.colors[3])
    }
    if (this._cloudMat) this._setCloudColors(palette)
    return palette.name
  }

  // ── Frame loop ────────────────────────────────────────────────────────────

  _frame(nowMs) {
    this._raf = this._visible ? requestAnimationFrame((ms) => this._frame(ms)) : 0
    if (!this._inited || !this._visible) return
    const dt = Math.min(0.1, (nowMs - this._lastMs) / 1000) || 0.016
    this._lastMs = nowMs
    this._timeS += dt
    let pulseNow = 0   // heartbeat pulse at the cursor, fed to the particles

    const store = this._store
    if (store) {
      const cursor = this._cursor
      if (Math.abs(cursor - this._builtCursor) > REBUILD_EPS_S) {
        this._rebuild(store, cursor)
        this._builtCursor = cursor
      }

      // Pulse: beat-locked phase from the stored PPG (cursor-derived, so it
      // freezes when playback pauses). Amplitude follows the fit's
      // reliability, eased; a phase discontinuity during continuous playback
      // is absorbed into a decaying offset rather than shown as a skip.
      const pulse = store.pulseAt(cursor)
      const gainTarget = pulse ? smoothstep(PULSE_W_LO, PULSE_W_HI, pulse.w) : 0
      this._pulseGain += (gainTarget - this._pulseGain) * (1 - Math.exp(-dt / PULSE_GAIN_TAU))
      let phase = 0, omega = 0
      if (pulse) {
        omega = pulse.hz * 2 * Math.PI
        const prev = this._pulsePrev
        if (prev && Math.abs(cursor - prev.cursor) < PULSE_SEEK_S) {
          // Continuous playback: any jump beyond what the rate predicts over
          // the cursor step goes into the offset (which then decays away).
          const predicted = prev.phase + omega * (cursor - prev.cursor)
          const jump = wrapPi(pulse.phase + this._pulseOffset - predicted)
          this._pulseOffset -= jump
          this._pulseOffset *= Math.exp(-dt / PULSE_JUMP_TAU)
        } else {
          this._pulseOffset = 0   // seek (or first frame): snap
        }
        phase = pulse.phase + this._pulseOffset
        this._pulsePrev = { phase, cursor }
      } else {
        this._pulsePrev = null
        this._pulseOffset = 0
      }
      for (const mesh of this._strands) {
        const u = mesh.material.uniforms
        u.uPulsePhase.value = phase
        u.uOmega.value      = omega
        u.uPulseAmp.value   = PULSE_AMP * this._pulseGain
      }
      {
        const s = (Math.cos(phase) + 1) * 0.5
        pulseNow = s * s * s * this._pulseGain   // same cubed-cosine shape as the strands
      }

      // Clouds: swirl follows the normalized MSE complexity at the cursor,
      // eased over CLOUD_SWIRL_TAU (loose coupling — the form drifts toward
      // the new regime rather than snapping with each 5 s MSE update).
      const c = store.complexityAt(cursor)
      const nTarget = c === null ? DEFAULT_N : Math.min(1, Math.max(0, c / MSE_Y_MAX))
      this._swirl += (nTarget - this._swirl) * (1 - Math.exp(-dt / CLOUD_SWIRL_TAU))

      // Head pose (from stored accel, not live EEGManager state) eased toward,
      // as an offset from the face-on base tilt: neutral head = face-on view,
      // ~45° of pitch swings the form all the way to the side (profile) view.
      // The offset is measured from a slowly-adapting baseline rather than
      // absolute gravity, so a held tilt (or a headset worn at an angle)
      // relaxes back to face-on over ~POSE_REF_TAU while transient movement
      // still swings the view immediately.
      const pose = store.headPoseAt(cursor)
      if (pose) {
        if (!this._poseRef) this._poseRef = { pitch: pose.pitch, roll: pose.roll }
        const kb = 1 - Math.exp(-dt / POSE_REF_TAU)
        this._poseRef.pitch += (pose.pitch - this._poseRef.pitch) * kb
        this._poseRef.roll  += (pose.roll  - this._poseRef.roll)  * kb
      }
      const tx = FACE_TILT_X + (pose ? (pose.pitch - this._poseRef.pitch) * POSE_GAIN : 0)
      const tz = pose ? (pose.roll - this._poseRef.roll) * POSE_GAIN : 0
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

      // Once the spin has wound down, ease the accumulated rotation back to
      // the nearest full revolution (shortest way to identity) so the form
      // always settles into the face-on default instead of staying stranded
      // wherever the spin happened to stop.
      if (Math.abs(this._spinVelX) + Math.abs(this._spinVelY) < SPIN_SETTLE_VEL) {
        const kr = 1 - Math.exp(-dt / SPIN_RETURN_TAU)
        const TWO_PI = 2 * Math.PI
        const rx = this._spinGroup.rotation.x
        const ry = this._spinGroup.rotation.y
        this._spinGroup.rotation.x += (Math.round(rx / TWO_PI) * TWO_PI - rx) * kr
        this._spinGroup.rotation.y += (Math.round(ry / TWO_PI) * TWO_PI - ry) * kr
      }
    }

    const pu = this._particles.material.uniforms
    pu.uTime.value  = this._timeS
    pu.uPulse.value = pulseNow

    // Cloud pass (reduced-resolution render target), then the main scene.
    this._cloudT += dt * (CLOUD_PACE_CALM + this._swirl * (CLOUD_PACE_OPEN - CLOUD_PACE_CALM))
    const cu = this._cloudMat.uniforms
    cu.uTime.value  = this._cloudT
    cu.uSwirl.value = this._swirl
    cu.uPulse.value = pulseNow
    this._renderer.setRenderTarget(this._cloudRT)
    this._renderer.render(this._cloudScene, this._cloudCamera)
    this._renderer.setRenderTarget(null)
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

  /** Cloud render target + off-screen scene, and the backdrop quad that blits it. */
  _makeClouds(palette) {
    this._cloudRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false })
    this._cloudMat = new THREE.ShaderMaterial({
      vertexShader:   CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: {
        uTime:   { value: 0 },
        uAspect: { value: new THREE.Vector2(1, 1) },
        uSwirl:  { value: DEFAULT_N },
        uPulse:  { value: 0 },
        uColorA: { value: new THREE.Color() },
        uColorB: { value: new THREE.Color() },
        uColorC: { value: new THREE.Color() },
      },
      depthTest: false,
      depthWrite: false,
    })
    this._setCloudColors(palette)
    this._cloudScene  = new THREE.Scene()
    this._cloudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const cloudQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._cloudMat)
    cloudQuad.frustumCulled = false
    this._cloudScene.add(cloudQuad)

    const blit = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader:   BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        uniforms: { uMap: { value: this._cloudRT.texture } },
        depthTest: false,
        depthWrite: false,
      }),
    )
    blit.frustumCulled = false
    blit.renderOrder = -1
    this._scene.add(blit)
  }

  _setCloudColors(palette) {
    const u = this._cloudMat.uniforms
    u.uColorA.value.set(palette.colors[1])
    u.uColorB.value.set(palette.colors[0])
    u.uColorC.value.set(palette.colors[3])
  }

  _makeParticles(palette) {
    const geo  = new THREE.BufferGeometry()
    const pos  = new Float32Array(PARTICLE_COUNT * 3)
    const seed = new Float32Array(PARTICLE_COUNT)
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      pos[i * 3]     = (Math.random() * 2 - 1) * PARTICLE_SPREAD
      pos[i * 3 + 1] = (Math.random() * 2 - 1) * PARTICLE_SPREAD
      pos[i * 3 + 2] = PARTICLE_FAR + Math.random() * (PARTICLE_NEAR - PARTICLE_FAR)
      seed[i] = Math.random()
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aSeed',    new THREE.BufferAttribute(seed, 1))
    const mat = new THREE.ShaderMaterial({
      vertexShader:   PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uTime:       { value: 0 },
        uPulse:      { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uColorA:     { value: new THREE.Color(palette.colors[0]) },
        uColorB:     { value: new THREE.Color(palette.colors[3]) },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const points = new THREE.Points(geo, mat)
    // The shader wraps z past the static positions' bounds — skip culling.
    points.frustumCulled = false
    return points
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
