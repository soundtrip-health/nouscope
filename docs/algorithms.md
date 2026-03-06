# Nouscope — Algorithm & Signal Processing Guide

This document explains the key algorithms that drive the Nouscope visualization: how raw audio and biometric signals are processed into the numbers that control the shaders, and exactly how those numbers map to visual parameters. Intended for developers (human or AI) modifying the internals.

---

## Table of Contents

1. [Audio Frequency Analysis](#1-audio-frequency-analysis)
2. [BPM Detection & Beat Events](#2-bpm-detection--beat-events)
3. [EEG Spectral Band Powers](#3-eeg-spectral-band-powers)
4. [PPG Heart Rate Detection](#4-ppg-heart-rate-detection)
5. [IMU Head Pose Estimation](#5-imu-head-pose-estimation)
6. [Parameter Mapping — Biometrics → Shader Uniforms](#6-parameter-mapping--biometrics--shader-uniforms)
7. [Vertex Shader — Curl Noise Displacement](#7-vertex-shader--curl-noise-displacement)
8. [Fragment Shader — Color & Heartbeat Flush](#8-fragment-shader--color--heartbeat-flush)
9. [Beat Reactions — Geometry & Rotation](#9-beat-reactions--geometry--rotation)

---

## 1. Audio Frequency Analysis

**File:** `src/js/managers/AudioManager.js`

Three.js wraps the Web Audio API's `AnalyserNode`. The analyser runs an FFT of size 1024, yielding 512 frequency bins. Each bin covers `sampleRate / FFT_SIZE` Hz (typically `44100 / 1024 ≈ 43 Hz/bin`).

`getFrequencyData()` returns unsigned bytes (0–255), where 255 ≈ 0 dBFS. These are averaged over three fixed Hz ranges and normalized to 0–1:

| Band | Frequency range | Visual role |
|------|----------------|-------------|
| `low` | 10–250 Hz | Time speed, beat energy |
| `mid` | 250–2000 Hz | Turbulence (`offsetGain`) |
| `high` | 2000–20000 Hz | Displacement amplitude |

**Bin calculation** (computed fresh each frame from actual sample rate):
```js
binIndex = Math.floor(hz * bufferLength / audioContext.sampleRate)
```

**Normalization:**
```js
normalizeValue(value) { return value / 255 }
```

`AudioManager.update()` is called every animation frame; `frequencyData.low/mid/high` are updated in place.

---

## 2. BPM Detection & Beat Events

**File:** `src/js/managers/BPMManager.js`

BPM is detected once at startup by passing the fully decoded `AudioBuffer` to `web-audio-beat-detector`'s `guess()`. This runs offline (not in real time) and returns a single BPM estimate.

After detection, a `setInterval` fires a Three.js `'beat'` event at the detected interval:

```
interval = 60000 / bpm  (milliseconds)
```

Falls back to 120 BPM if `guess()` throws. The interval-based approach means beats stay locked to the initial estimate for the full track — there is no adaptive re-detection.

`getBPMDuration()` returns the interval in ms; `ReactiveParticles` uses it to set GSAP tween durations relative to musical tempo.

---

## 3. EEG Spectral Band Powers

**File:** `src/js/managers/EEGManager.js`, `_processEEGSample()` / `_computeBandPower()`

### Signal pipeline

muse-js delivers EEG samples via `zipSamples()` which synchronizes the four electrode channels (TP9, AF7, AF8, TP10) into aligned packets. The four channel values are averaged into a single scalar per sample, NaN samples are dropped.

```
avg = (ch0 + ch1 + ch2 + ch3) / 4
```

Samples accumulate in a rolling 256-sample buffer. Every time it fills, band powers are recomputed with **50% overlap** (the buffer is sliced by half, not cleared), giving a new estimate roughly every 128 samples (~0.5 s at 256 Hz).

### Spectral estimation

Rather than an FFT, a **direct DFT** is computed for integer bins 1–50 Hz. This is O(N²) but acceptable for N=256 at ~2 Hz update rate.

1. **Hann window** to reduce spectral leakage:
   ```
   w[n] = 0.5 - 0.5 * cos(2π·n / (N-1))
   signal_windowed[n] = signal[n] * w[n]
   ```

2. **DFT power** at each integer Hz bin k (1 Hz resolution because N=256 samples at 256 Hz):
   ```
   PSD[k] = |Σ signal_windowed[n] · e^(-j·2π·k·n/N)|²
           = re² + im²
   ```

3. **Band integration** — PSD bins are summed over each band's Hz range:

   | Band | Bins (Hz) |
   |------|-----------|
   | delta | 1–3 |
   | theta | 4–7 |
   | alpha | 8–12 |
   | beta | 13–29 |
   | gamma | 30–49 |

4. **Relative normalization** — divides each band by the total power across all bands, so the five values always sum to 1.0. This makes the output robust to amplitude variation (electrode contact quality, individual differences) but means the values are compositional — if gamma rises, others fall.

`EEGManager.bandPower` is updated in place after each computation window and read by `ReactiveParticles.update()` every frame.

---

## 4. PPG Heart Rate Detection

**File:** `src/js/managers/EEGManager.js`, `_processPPGSample()` / `update()`

The Muse's infrared PPG sensor (channel 1) streams raw photodiode counts at 64 Hz. The pipeline converts these into a heart rate in BPM and a smooth 0–1 pulse oscillator.

### Stage 1 — IIR bandpass filter

Two cascaded first-order IIR filters isolate the cardiac band (30–210 BPM = 0.5–3.5 Hz):

**High-pass at 0.5 Hz** — removes slow DC drift and baseline wander:
```
α_HP = 1 / (1 + 2π·0.5/64) ≈ 0.953
hp[n] = α_HP · (hp[n-1] + raw[n] - raw[n-1])
```

**Low-pass at 3.5 Hz** — removes high-frequency motion artifacts:
```
α_LP = (2π·3.5/64) / (1 + 2π·3.5/64) ≈ 0.255
lp[n] = (1 - α_LP) · lp[n-1] + α_LP · hp[n]
```

The filtered output is kept in a 6-second ring buffer (384 samples).

### Stage 2 — Look-back peak detection

A peak at buffer position `p` is declared only after 5 more samples arrive (LOOKAHEAD=5), confirming it is a local maximum. This avoids spurious early triggers.

A candidate peak must pass three gates:
1. **Local maximum:** strictly greater than its 2 nearest neighbours on each side
2. **Adaptive threshold:** value > mean + 0.3σ of the most recent 4-second window — adapts to signal amplitude
3. **Refractory period:** at least 300 ms (19 samples at 64 Hz) since the last accepted peak — enforces a 200 BPM maximum

### Stage 3 — IBI → heart rate

On each valid peak, the inter-beat interval (IBI) in seconds is:
```
IBI = (currentPeakSample - lastPeakSample) / 64
instantHR = 60 / IBI
```

Valid beats (30–200 BPM range) are appended to a 5-sample IBI history. The **median** of this history is used (not the mean) to reject outlier IBIs from motion artifacts:
```
heartRate = round(60 / median(ibiHistory))
```

### Stage 4 — Heartbeat oscillator

`EEGManager.update(now)` is called every animation frame. It advances a phase variable at the current heart rate frequency:
```
heartPhase += (heartRate / 60) · 2π · dt
s = (sin(heartPhase) + 1) / 2          // 0–1 sine
heartPulse = s³                         // cubing sharpens the systolic peak
```

The cube transform produces a waveform that spikes sharply (simulating the fast systolic peak) and decays slowly (diastolic phase), matching the physiological shape of a PPG waveform.

---

## 5. IMU Head Pose Estimation

**File:** `src/js/managers/EEGManager.js`, `_processAccel()`

The Muse accelerometer delivers packets of 3 samples at ~52 Hz. Each packet is first averaged across its samples, then fed into an **exponential moving average** (EMA) with α=0.08:

```
smooth[n] = (1 - 0.08) · smooth[n-1] + 0.08 · raw[n]
```

The low α value (0.08) means the filter has a long time constant (~12 sample periods ≈ 0.23 s), passing only slow deliberate head movements and rejecting vibration and transient jerk.

Angles are derived from the gravity vector using standard tilt equations:
```
pitch = atan2(-ax, √(ay² + az²))   // forward/backward nod (rotation around X)
roll  = atan2(ay, az)               // left/right side tilt (rotation around Z)
```

Both are in radians. At rest (headset upright), pitch ≈ 0 and roll ≈ 0. The initial EMA state is `{ x:0, y:0, z:1 }` (gravity pointing down), so the filter converges to actual orientation within a second or two of connection.

---

## 6. Parameter Mapping — Biometrics → Shader Uniforms

**File:** `src/js/entities/ReactiveParticles.js`, `update()`

All EEG values are relative band powers (0–1, sum = 1). Each is multiplied by an influence strength scalar (default 1.0, user-adjustable 0–3× in the GUI).

### Audio-only baseline

```js
amplitude   = 0.8 + mapLinear(audio.high, 0, 0.6, -0.1, 0.2)
            // ≈ 0.7–1.0 range driven by high-frequency energy
offsetGain  = audio.mid * 0.6
            // 0–0.6 driven by mid-frequency energy
size        = BASE_SIZE  (1.1)
maxDistance = BASE_MAX_DISTANCE  (1.8)
```

`time` is incremented each frame at a rate driven by `audio.low`:
```js
t = mapLinear(audio.low, 0.6, 1.0, 0.2, 0.5)   // low-freq → time speed
time += clamp(t, 0.2, 0.5)
```
Higher bass → faster overall animation speed.

### EEG additions (additive on top of audio baseline)

| EEG band | Formula | Rationale |
|----------|---------|-----------|
| theta (4–8 Hz) | `size += theta * 2 * eegStr` | Theta is drowsy/relaxed — larger, softer particles |
| alpha (8–13 Hz) | `maxDistance += alpha * 1.8 * eegStr` | Alpha is calm/idle — wider particle spread |
| beta (13–30 Hz) | `offsetGain += beta * 0.5 * eegStr` | Beta is focused/alert — more turbulence |
| gamma (30–50 Hz) | `amplitude += gamma * 0.3 * eegStr` | Gamma is high cognition — sharper displacement |
| delta (1–4 Hz) | *(not currently mapped)* | — |

### Heart rate pulse

```js
heartPulse_uniform = heartPulse * hrStrength
```

`heartPulse` is the cubed-sine oscillator from `EEGManager.update()`. At full strength (1.0×) and peak pulse (1.0), this adds `0.35 × pulseWarm` to the fragment color (see §8).

### IMU head control

When `headControl` is enabled:
```js
holderObjects.rotation.x = headPose.pitch * imuStrength * 0.8
holderObjects.rotation.y = headPose.roll  * imuStrength * 0.8
```
Any active GSAP rotation tweens are killed immediately. Disabling head control triggers a 1.5 s ease-out tween back to zero rotation.

---

## 7. Vertex Shader — Curl Noise Displacement

**File:** `src/js/entities/glsl/vertex.glsl`

The shader runs once per particle (vertex). It displaces each particle away from its base geometry position using a **curl noise** field — a divergence-free vector field derived from 2D simplex noise. Divergence-free means the flow has no sources or sinks: particles circulate without clumping or voids.

### Curl computation

The curl of a scalar noise field `n(x,y)` is approximated by finite differences over three axis-pairs:

```glsl
// Example for curl.x (simplified):
a = (noise(x, y+ε) - noise(x, y-ε)) / 2ε
b = (noise(x, z+ε) - noise(x, z-ε)) / 2ε
curl.x = a - b
// similarly for curl.y and curl.z
```

The noise field is scrolled through time:
```glsl
x += time * 0.05;  y += time * 0.05;  z += time * 0.05;
```
This animates the flow continuously. `frequency` scales the input coordinates, controlling how tightly coiled the flow is (higher → smaller vortices).

### Displacement and blending

```glsl
vec3 target = position + (normal * 0.1) + curl(...) * amplitude;
float d = length(position - target) / maxDistance;
newpos = mix(position, target, pow(d, 4.0));
```

The `pow(d, 4.0)` falloff keeps particles near the surface when displacement is small — only strongly displaced particles move far — creating a "melting" effect that respects the geometry shape at low amplitude and explodes outward at high amplitude.

`maxDistance` scales the normalized displacement `d`. A higher `maxDistance` (e.g. from high alpha power) means a given curl magnitude produces a smaller `d`, keeping particles closer to the surface.

### Extra turbulence

```glsl
newpos.z += sin(time) * (0.1 * offsetGain);
```

A simple sinusoidal z-oscillation adds a secondary "breathing" motion driven by mid-frequency audio. This is intentionally simple — it breaks the spatial coherence of the curl field and adds perceptual complexity.

### Point sizing

```glsl
gl_PointSize = size + (pow(d, 3.0) * offsetSize) * (1.0 / -mvPosition.z);
```

- Base size from `size` uniform (EEG theta-modulated)
- Displaced particles are rendered larger: `pow(d, 3.0) * offsetSize`
- Divided by depth (`-mvPosition.z`) gives perspective-correct shrinking with distance
- `offsetSize` is randomized per geometry (30–60) to vary the visual density

The varying `vDistance` (= `d`) is passed to the fragment shader for color mapping.

---

## 8. Fragment Shader — Color & Heartbeat Flush

**File:** `src/js/entities/glsl/fragment.glsl`

### Circular point mask

WebGL renders each point as a quad. The fragment shader converts it to a soft-edged circle using `gl_PointCoord` (0–1 UV within the quad):

```glsl
vec2 dist = uv - vec2(0.5);
circle = 1.0 - smoothstep(r - r*0.01, r + r*0.01, dot(dist, dist) * 4.0);
```

`dot(dist,dist)*4.0` is equivalent to `(2·|dist|)²`, mapping the unit circle to 0 at center and 1 at the quad edge. The `smoothstep` gives a 1% soft edge.

### Distance-based color gradient

```glsl
vec3 color = mix(startColor, endColor, vDistance);
```

`vDistance` is the normalized displacement magnitude from the vertex shader. Particles near their base geometry position (low displacement) receive `startColor`; maximally displaced particles receive `endColor`. This means the gradient directly encodes how much the particle is being pushed by the curl field at this moment.

### Heartbeat warm flush

```glsl
vec3 pulseWarm = vec3(0.45, 0.05, 0.08);   // reddish-warm additive color
color = mix(color, color + pulseWarm, heartPulse * 0.35);
```

At `heartPulse = 1.0` (peak systole), the color shifts by `0.35 × pulseWarm` — a warm reddish-orange tint that fades smoothly as the oscillator decays. The additive formulation means the color shift is always in the warm direction regardless of the current `startColor/endColor` setting.

### Alpha

```glsl
gl_FragColor = vec4(color, circle.r * vDistance);
```

Particles are transparent near the base geometry surface (`vDistance ≈ 0`) and fully opaque when maximally displaced. Combined with the circular mask, this means only strongly displaced particles are visible, and they fade at the center of each point.

---

## 9. Beat Reactions — Geometry & Rotation

**File:** `src/js/entities/ReactiveParticles.js`, `onBPMBeat()` / `resetMesh()`

On each beat event from `BPMManager`:

```
30% chance → GSAP rotation tween on holderObjects.rotation.z
               (skipped when headControl is active)
30% chance → geometry reset (destroyMesh → createCylinderMesh)
```

Geometry reset also triggers a GSAP tween on the `frequency` uniform:
```js
gsap.to(material.uniforms.frequency, {
  duration: bpmDuration * 2,
  value: randFloat(0.5, 3),
  ease: 'expo.easeInOut',
})
```

This gradually shifts the curl field density over two beats, producing smooth visual transitions between coarse and fine-grained flow.

**Rotation tween duration** is randomly either:
- `15 s` (80% chance) — slow drift, crosses multiple beats
- `bpmDuration` (20% chance) — snaps to a new angle in exactly one beat

**Geometry disposal:** `destroyMesh()` calls `geometry.dispose()` and `material.dispose()` to free GPU buffers, and kills any active GSAP tweens on the old mesh before removal. New geometry shares the same `ShaderMaterial` instance.

Both box and cylinder geometries randomize their segment counts on each creation, producing varied point densities and visual textures without any additional code.
