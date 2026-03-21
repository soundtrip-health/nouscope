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

### Overview

Band power estimation follows a simplified fBOSC (frequency-specific Bayesian Oscillation-Suppression Criterion) approach (Seymour et al. 2022, *European Journal of Neuroscience*). The key improvement over a plain DFT is **aperiodic (1/f) background normalization**: each band's power is divided by the expected power under the fitted aperiodic model before the final relative normalization. This means a genuinely elevated oscillation (e.g. a strong alpha peak) contributes proportionally more than a band that simply happens to sit at a lower frequency in the 1/f slope.

### Stage 1 — Per-channel buffer management

muse-js delivers EEG samples via `zipSamples()`, synchronizing the four electrode channels (TP9, AF7, AF8, TP10) into aligned packets. Each channel is maintained in its own rolling 256-sample analysis buffer (`_chBuffers[4]`). NaN samples are replaced with 0. Spectral analysis is triggered every 128 new samples (~0.5 s at 256 Hz), giving 50% overlap between consecutive windows.

### Stage 2 — Per-channel spectral estimation

Band power is estimated differently for delta vs. all higher bands:

**Delta (1–4 Hz) — sparse Hann-windowed DFT:**
```
w[n] = 0.5 - 0.5·cos(2π·n / (N-1))          (Hann window)
DFT power at bin k = |Σ signal[n]·w[n]·e^(-j·2π·k·n/N)|²
delta = DFT[1] + DFT[2] + DFT[3]             (bins 1, 2, 3 Hz)
```
Twiddle factors (`w[n]·cos(…)`, `w[n]·sin(…)`) are precomputed at construction time, so the hot-path only performs multiply-accumulate operations.

**Theta, Alpha, Beta, Gamma — Morlet wavelet instantaneous power:**

The Morlet wavelet at frequency `f` (following BOSC_tf.m):
```
σ = τ / (2π·f)                    (temporal std dev; τ = wavenumber)
A = 1 / sqrt(σ·√π)                (amplitude normalization)
ψ(t) = A · exp(-t²/2σ²) · exp(i·2π·f·t)
```
Window: ±3σ samples (truncated from the ±3.6σ used in BOSC_tf to keep kernels within the 256-sample buffer). Theta uses a reduced wavenumber (τ=4 instead of 6) to keep the kernel short enough for a useful number of valid samples; the broader spectral smearing is acceptable for the wide 4–8 Hz band.

| Band  | τ  | Center freq | σ (s) | Kernel half-width (samples) | Valid samples |
|-------|----|-------------|-------|-----------------------------|---------------|
| theta | 4  | 6 Hz        | 0.106 | 82                          | 92            |
| alpha | 6  | 10 Hz       | 0.095 | 74                          | 108           |
| beta  | 6  | 20 Hz       | 0.048 | 37                          | 182           |
| gamma | 6  | 40 Hz       | 0.024 | 19                          | 218           |

Power is computed as the mean `|W(t)|²` over all valid (edge-free) samples in the window:
```
power_band = mean( re(t)² + im(t)² )   for t ∈ [halfWin … N-1-halfWin]
```

### Stage 3 — Quality-weighted channel aggregation

Each channel is assigned a weight based on its signal quality (updated ~4× per second):

| Quality | RMS (µV) | Base weight |
|---------|----------|-------------|
| good    | < 50     | 1.0         |
| marginal | 50–100  | `marginalChannelWeight` (default 0.5) |
| poor    | > 100    | 0.0         |

Up to 2 channels may be **dropped** (excluded entirely) based on `badChannelThreshold`:
- `'poor'` (default): only channels rated 'poor' are drop candidates
- `'marginal'`: channels rated 'poor' or 'marginal' are candidates

The worst-rated candidates are dropped first; at least 2 channels are always retained. Remaining channels are averaged using the quality weights, normalised to sum 1.

### Stage 4 — Aperiodic background model (BOSC_bgfit style)

Every `APERIODIC_UPDATE_INTERVAL = 10` windows (~5 s), the background model is refit from the quality-weighted average wavelet powers at 6, 10, 20, 40 Hz. A log-log OLS regression gives:

```
log₁₀(P_expected) = a + b · log₁₀(f)
```

The **first** refit uses instant adoption (`smooth = 1.0`) so the model immediately matches the actual signal scale rather than slowly converging from the dummy prior. Subsequent refits use EMA smoothing (`AP_SMOOTH = 0.3`) for stability. The initial model is `{a: 0, b: -1.5}` (generic 1/f^1.5 prior).

### Stage 5 — Aperiodic normalization → relative output

Each band's power is divided by the expected aperiodic power at its representative frequency. Only bands that are **actively mapped** to a visualizer parameter (via `ReactiveParticles.bioMapping`) participate in the normalisation sum; unmapped bands are zeroed out:

```
norm_band = raw_band / 10^(a + b · log₁₀(f_center))   [for active bands only]
norm_band = 0                                            [for inactive/unmapped bands]

Representative frequencies: delta→2 Hz, theta→6, alpha→10, beta→20, gamma→40
```

`ReactiveParticles` maintains `EEGManager.normalizeBands` (a `Set` of band name strings). It is initialised from the default `bioMapping` at GUI creation and updated whenever the user changes a Source dropdown. This prevents high-power but unmapped bands (most commonly delta, which tends to dominate the 1/f spectrum) from consuming a disproportionate share of the normalised total.

If all sources are set to `'none'`, `normalizeBands` falls back to the full set so output stays meaningful.

This preserves sustained brain-state information: a genuinely elevated oscillation (e.g. strong alpha during eyes-closed) receives a proportionally larger share after 1/f correction, and this persists for as long as the state holds — there is no adaptive baseline that would suppress sustained changes back to zero.

Before the model has converged (`AP_MIN_REFITS = 3` refits, ≈ 15 s), `bandPower` is held at zero to suppress spurious EEG influence during warm-up.

`EEGManager.bandPower` is updated in place after each computation window and read by `ReactiveParticles.update()` every frame.

---

## 4. PPG Heart Rate Detection

**File:** `src/js/managers/EEGManager.js`, `_processPPGSample()` / `_runMSPTD()` / `update()`

The Muse's infrared PPG sensor (channel 1) streams raw photodiode counts at 64 Hz. The pipeline converts these into a heart rate in BPM and a smooth 0–1 pulse oscillator using the **MSPTDfast v2** algorithm (port of `msptdpcref_beat_detector.m`).

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

Filtered samples accumulate in a rolling 6-second ring buffer (384 samples at 64 Hz). The MSPTDfast batch detector is re-run every `PPG_RUN_STEP = 64` new samples (~1 s).

### Stage 2 — MSPTDfast v2 batch peak detection

When triggered, the full 6-second buffer is processed in a batch:

**Downsample** — the buffer is decimated by `DS_FACTOR = 3` to ~21 Hz before scalogram analysis. The bandpass already prevents aliasing.

**Detrend** — a best-fit linear trend is subtracted from the downsampled signal (mirrors MATLAB `detrend`), removing any residual DC offset.

**Multi-scale Local Maxima Scalogram (LMS)** — for each scale `k = 1…λ_max`, a binary matrix `mMax[k][i]` is set to 1 if sample `i` is a local maximum at scale `k` (i.e. `x[i] > x[i-k]` and `x[i] > x[i+k]`). The maximum scale is capped to plausible heart rates (≥ `HR_MIN/60` Hz), excluding physiologically impossible slow periods.

**Optimal scale λ** — the scale with the highest row-sum (most detections) is selected as `λ_max`. This is the scale that best matches the dominant periodicity in the signal.

**Peak intersection** — columns where all rows `0…λ_max` agree (every scale marks a local maximum) are declared peaks. This intersection step is the key insight of MSPTD: only true cardiac peaks survive consistently across all scales, while noise peaks appear only at one or a few scales.

**Refine to original resolution** — each downsampled peak index is mapped back to the 64 Hz buffer (multiply by `DS_FACTOR`), then a local search within ±`REFINE_TOL = 4` samples finds the true maximum. A 300 ms refractory period (19 samples) is then enforced to eliminate duplicates.

### Stage 3 — IBI → heart rate

IBIs are computed from all consecutive peak pairs in the 6-second window:
```
IBI = (peaks[i] - peaks[i-1]) / 64
```

Only IBIs corresponding to 30–200 BPM are kept. The **median** IBI across all valid pairs is used (not the mean) for robustness against outliers:
```
heartRate = round(60 / median(ibis))
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

### Audio baseline (with per-band gain)

Each audio band has a gain slider (0–2). Mid and high default to 1.0 (= prior tuning); bass defaults to **0.5** for a calmer baseline animation speed.

```js
amplitude  = 0.8 + mapLinear(audio.high, 0, 0.6, -0.1, 0.2) * audioGains.high
           // ≈ 0.7–1.0 baseline driven by high-frequency energy
offsetGain = audio.mid * 0.6 * audioGains.mid
           // 0–0.6 baseline driven by mid-frequency energy
size        = BASE_SIZE  (1.1)   // audio has no size baseline
maxDistance = BASE_MAX_DISTANCE  (1.8)  // audio has no maxDistance baseline
```

`time` is incremented each frame at a rate driven by `audio.low`:
```js
t = mapLinear(audio.low, 0.6, 1.0, 0.2, 0.5)
time += max(0.01, clamp(t, 0.2, 0.5) * audioGains.bass)
```
Higher bass → faster overall animation speed. Floor of 0.01 keeps animation ticking at low gain.

### Bio mapping (user-configurable)

Each viz parameter has an independently configurable bio source and weight. Most parameters use **multiplicative** scaling so that EEG modulates the audio reactivity rather than simply adding a small offset:

```js
sources = { none:0, delta, theta, alpha, beta, gamma, hr: heartPulse }

// Multiplicative — EEG scales the audio-driven baseline
amplitude  *= (1 + sources[mapping.amplitude.source]  * mapping.amplitude.weight)
offsetGain *= (1 + sources[mapping.offsetGain.source] * mapping.offsetGain.weight)
size       *= (1 + sources[mapping.size.source]       * mapping.size.weight)
maxDistance *= (1 + sources[mapping.maxDistance.source] * mapping.maxDistance.weight)
frequency   = baseFrequency * (1 + sources[mapping.frequency.source] * mapping.frequency.weight)

// Direct assignment (no audio baseline to multiply)
hueShift_uniform   = sources[mapping.hueShift.source]   * mapping.hueShift.weight
heartPulse_uniform = sources[mapping.heartPulse.source] * mapping.heartPulse.weight
```

A focused brain (high gamma/beta) amplifies the music's visual effect; a calm brain softens it. At rest (EEG sources = 0), the multiplier is 1.0 and behavior matches audio-only mode.

**Default mapping:**

| Viz parameter | Default source | Weight range | Default weight | Scaling | Notes |
|---------------|---------------|--------------|----------------|---------|-------|
| Amplitude     | gamma         | 0.0 – 1.0   | 0.5            | ×(1+s·w) | Focus → 50% more displacement at full gamma |
| Turbulence    | beta          | 0.0 – 2.0   | 1.0            | ×(1+s·w) | Alert → doubled turbulence |
| Particle Size | theta         | 0.0 – 3.0   | 1.5            | ×(1+s·w) | Drowsy → 2.5× larger particles |
| Spread Radius | alpha         | 0.0 – 2.0   | 1.0            | ×(1+s·w) | Calm → doubled spread |
| Field Chaos   | beta          | 0.0 – 3.0   | 1.5            | ×(1+s·w) | Alert → 2.5× curl frequency (tighter vortices) |
| Hue Shift     | gamma         | 0.0 – 0.25  | 0.12           | direct  | Focus → ~43° hue rotation at full gamma |
| Color Flush   | hr            | 0.0 – 2.0   | 1.0            | direct  | Heart rate → warm reddish pulse |

Weight slider: `min` = no contribution, `max` = full effect. Any source can be routed to any parameter — e.g. mapping `hr` to `amplitude` makes particles pulse with each heartbeat, or mapping `alpha` to `heartPulse` flushes color with calm mental states. `delta` is available as a source but has no default mapping.

### IMU head control

When `headControl` is enabled:
```js
holderObjects.rotation.x = headPose.pitch * imuStrength * 0.8
holderObjects.rotation.y = headPose.roll  * imuStrength * 0.8
```
Any active GSAP rotation tweens are killed immediately. Disabling head control triggers a 1.5 s ease-out tween back to zero rotation. `imuStrength` is a 0–3 slider in the VISUALIZER GUI folder.

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

### EEG hue shift

```glsl
vec3 hsv = rgb2hsv(color);
hsv.x = fract(hsv.x + hueShift);
color = hsv2rgb(hsv);
```

The `hueShift` uniform (driven by gamma by default) rotates the entire color palette through HSV hue space. At rest (hueShift = 0), colors are unchanged. At full gamma with default weight (0.12), the palette rotates ~43° — a clearly visible shift toward warmer or cooler tones depending on the user's chosen start/end colors. The `fract()` wraps the hue angle so all values produce valid colors. RGB↔HSV conversion uses the standard Hue-Saturation-Value formulation.

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

Geometry reset also triggers a GSAP tween on the base curl-field frequency:
```js
gsap.to(this, {
  duration: bpmDuration * 2,
  _baseFrequency: randFloat(0.5, 3),
  ease: 'expo.easeInOut',
})
```

The actual `frequency` uniform is set each frame as `_baseFrequency * (1 + eegSource * weight)`, so EEG modulates whatever frequency the beat tween is currently interpolating toward. This gradually shifts the curl field density over two beats, producing smooth visual transitions between coarse and fine-grained flow — with EEG adding a real-time layer of chaos on top.

**Rotation tween duration** is randomly either:
- `15 s` (80% chance) — slow drift, crosses multiple beats
- `bpmDuration` (20% chance) — snaps to a new angle in exactly one beat

**Geometry disposal:** `destroyMesh()` calls `geometry.dispose()` and `material.dispose()` to free GPU buffers, and kills any active GSAP tweens on the old mesh before removal. New geometry shares the same `ShaderMaterial` instance.

Both box and cylinder geometries randomize their segment counts on each creation, producing varied point densities and visual textures without any additional code.
