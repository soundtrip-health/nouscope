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
10. [EEG Spectrogram Display](#10-eeg-spectrogram-display)
11. [EEG–Music Entrainment Index](#6--eegmusic-entrainment-index)
12. [EEG Complexity — Multiscale Entropy](#7--eeg-complexity--multiscale-entropy)
13. [Session Recording — JSONL Export](#8--session-recording--jsonl-export)

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

### Stage 6 — Temporal smoothing

Three layers of smoothing prevent the discrete ~2 Hz analysis windows from producing staircase jumps in the visualization:

1. **Source EMA** (`EEGManager`): After aperiodic normalization, each band is EMA-smoothed in place before storing to `bandPower`:
   ```
   bandPower[band] += BAND_SMOOTH * (result[band] - bandPower[band])
   ```
   `BAND_SMOOTH = 0.35` at ~2 Hz update rate gives a ~1.5 s settling time, matching the perceptual timescale of EEG state changes.

2. **Per-frame lerp** (`ReactiveParticles`): The viz maintains `_smoothedBands` and lerps toward the latest `bandPower` each frame:
   ```
   _smoothedBands[band] += EEG_LERP_RATE * (target - _smoothedBands[band])
   ```
   `EEG_LERP_RATE = 0.06` at 60 fps gives sub-frame interpolation between the discrete ~2 Hz updates, eliminating visual jerkiness.

3. **Display lerp** (`BioDataDisplay`): The band power plot maintains `_bandSmoothed[5]` and lerps toward `bandPower` each frame:
   ```
   _bandSmoothed[i] += BAND_LERP * (target[i] - _bandSmoothed[i])
   ```
   `BAND_LERP = 0.08` at 60 fps gives ~0.5 s to 90%, producing smooth curves in the EEG Bands panel instead of staircase jumps.

The three layers compose: the source EMA prevents wild jumps in the target, while the per-frame lerps smoothly track that target at display refresh rate for both the shader uniforms and the diagnostic plot.

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

Particles are transparent near the base geometry surface (`vDistance ≈ 0`) and fully opaque when maximally displaced. Combined with the circular mask, this means only strongly displaced particles are visible, and each point fades at its edge (not at the center).

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

Each `createCylinderMesh()` call randomizes radial and height segment multipliers, varying point density and texture. (`createBoxMesh()` exists in the file but is not called from the live paths.)

---

## 10. EEG Spectrogram Display

**Files:** `src/js/managers/EEGManager.js` (`_computeSpectrum()`, `_computeSpectrumLo()`), `src/js/ui/BioDataDisplay.js` (`_updateSpectrum()`, `_updateSpectrumLo()`)

### Overview

A scrolling time–frequency heatmap of EEG power, computed alongside the band power pipeline (Section 3). Each column represents one 256-sample analysis window (~0.5 s at 256 Hz, 50% overlap), covering 1–50 Hz at 1 Hz resolution. The display uses a viridis colormap on log₁₀-scaled power with auto-ranging. A second hi-resolution panel covers 0.5–8.0 Hz at 0.1 Hz resolution (using a separate 2560-sample / 10 s window) to reveal sub-Hz beat entrainment and delta/theta dynamics.

### Stage 1 — Hann-windowed DFT (bins 1–50)

The same precomputed Hann-weighted twiddle factors used for delta band power (Section 3, Stage 2) are extended to cover all 50 bins:

```
w[n] = 0.5 - 0.5·cos(2π·n / (N-1))          (Hann window, N=256)
power[k] = |Σ sig[n]·w[n]·e^(-j·2π·k·n/N)|²   for k = 1…50
```

Twiddle factors (`w[n]·cos(…)`, `w[n]·sin(…)`) for all 50 bins are precomputed at construction time alongside the wavelet kernels, so the hot-path performs only multiply-accumulate operations.

### Stage 2 — Quality-weighted channel average

Per-bin power is averaged across EEG channels using the same quality weights as band power (Section 3, Stage 3). Dropped channels (weight = 0) are skipped entirely.

### Stage 3 — Log power & display buffer

Power values are stored as `log₁₀(power + 1e-10)` in a rolling buffer of `Float32Array(50)` columns (up to 280 columns ≈ 140 s of history). A monotonic `spectrumSampleCount` counter enables the same read-index pattern used by the other display buffers.

The hi-res low-frequency spectrogram uses a separate 2560-sample (10 s) per-channel rolling buffer and its own set of 76 Hann-weighted DFT twiddle factors (0.5–8.0 Hz at 0.1 Hz steps). It stores `Float32Array(76)` columns in `_specLoDisplay` with its own `spectrumLoSampleCount` counter. Quality-weighted averaging applies. ~1.2 MB of precomputed kernels (76 bins × 2560 samples × 2 components × 4 bytes).

### Stage 4 — Heatmap rendering (BioDataDisplay)

The two panels use separate data buffers and plain 2D `<canvas>` (not WebGL) with a column-shift approach since the update rate is low (~2 Hz):

1. **Auto-scale:** Robust ceiling via a 30-column sliding window of per-column max values; the 90th percentile of the window becomes the scale ceiling. This means a single artifact spike influences at most ~10% of the window and is naturally ejected after ~15 s. The ceiling is additionally capped at `SPEC_LOG_CAP = 8.2` (≈ 200 µV amplitude, derived from Hann-DFT power ≈ A² × N²/16) to prevent headset-removal or other implausible transients from anchoring the scale. The floor tracks the running minimum with a slow upward decay (0.005 per column) so it follows the noise floor and contracts again when signal levels drop. Minimum dynamic range of 2 decades.
2. **Shift left:** `ctx.drawImage(canvas, -2, 0)` scrolls the existing content two pixels left (column width = 2 px).
3. **Draw column:** A 2×H `ImageData` is filled using the viridis colormap LUT (256 entries, piecewise-linear from 9 key stops). Frequency axis labels are HTML elements alongside each canvas.

**Full spectrogram** (`#spec-canvas`, 280×86 native px): bins 8–50 Hz (43 bins), 2 px/bin vertically, 2 px/column horizontally. Uses `_specDisplay` (256-sample DFT, 1 Hz resolution). Axis labels: 50, 8 Hz.

**Delta/theta zoom** (`#spec-lo-canvas`, 280×76 native px): 0.5–8.0 Hz at 0.1 Hz resolution (76 bins), 1 px/bin vertically, 2 px/column horizontally. Uses a dedicated `_specLoDisplay` buffer computed from a 2560-sample (10 s) Hann-windowed DFT with precomputed twiddle factors for 76 fractional-Hz bins. First column appears after 10 s of data accumulation. Separate auto-scaling to maximise contrast for sub-Hz beat entrainment dynamics. Axis labels: 8, 4, 0.5 Hz.

The `image-rendering: pixelated` CSS property ensures bins render with sharp edges when CSS-scaled.

### Viridis colormap

The colormap is a 256-entry RGB lookup table precomputed at module load from 9 piecewise-linear stops approximating matplotlib's viridis:

| Normalized value | Color |
|-----------------|-------|
| 0.0 | dark purple (68, 1, 84) |
| 0.25 | blue (59, 82, 139) |
| 0.5 | teal (33, 145, 140) |
| 0.75 | green (122, 209, 81) |
| 1.0 | yellow (253, 231, 37) |

Low power → purple/blue, high power → green/yellow.

### Future: Multitaper spectral estimation

The current implementation uses a single Hann window, which provides ~-31 dB sidelobe suppression — adequate for a visualization panel. For lower-variance estimates suitable for research-grade analysis, a **multitaper** approach using Discrete Prolate Spheroidal Sequences (DPSS / Slepian tapers) could replace the Hann window:

1. **Pre-generate DPSS tapers** in Python using `scipy.signal.windows.dpss(N=256, NW=3)` and export as a JSON array (JavaScript lacks a native DPSS generator).
2. **Compute K individual spectra** by multiplying the signal by each of the `K = 2·NW - 1 = 5` tapers, then taking the DFT of each.
3. **Average the K power spectra** to produce the final multitaper estimate.

The rendering pipeline (Stages 4–5) would remain unchanged — only the spectral estimation (Stages 1–2) would be swapped. The main tradeoff is shipping a ~30 KB JSON taper file and `K×` more DFT computation per window (5× at NW=3), which is still negligible at the 2 Hz update rate.

Reference: Thomson, D. J. (1982). "Spectrum estimation and harmonic analysis." *Proceedings of the IEEE*, 70(9), 1055–1096.

---

## §6 — EEG–Music Entrainment Index

Measures how strongly the listener's neural rhythms mirror the music's beat structure, following the methodologies of Nozaradan et al. (2012) and Stober et al. (2016).

**Files:** `src/js/managers/EntrainmentManager.js`, `src/js/managers/AudioManager.js` (novelty curve)

### Stage 1: Audio Spectral-Flux Novelty Curve

Each render frame (~60 Hz), compute the **half-wave rectified spectral flux** from the AudioAnalyser's FFT magnitude data:

```
flux = Σ max(0, currentMag[i] - prevMag[i])   for i = 0..511
```

- Uses the existing 1024-point FFT (512 magnitude bins, 0–255 uint8)
- Captures note onsets and rhythmic events more clearly than raw amplitude
- Stored with timestamp in a ring buffer (768 entries ≈ 12.8 s at 60 fps)

Reference: Grosche & Müller (2011). "Extracting predominant local pulse information from music recordings." *IEEE TASLP*.

### Stage 2: Audio Tempogram

At ~2 Hz update rate:

1. **Resample** the variable-rate novelty ring buffer to a uniform 64 Hz grid via linear interpolation
2. **Hann-windowed DFT** over an 8-second window (512 samples) at 0.5–5.0 Hz in 0.1 Hz steps (46 bins)
3. Output: **power spectrum** (re² + im²) per bin — the audio tempogram

| Constant | Value | Rationale |
|---|---|---|
| `NOVELTY_FS` | 64 Hz | Resample grid; Nyquist well above 5 Hz ceiling |
| `TEMPO_WIN_SAMP` | 512 | 8 s × 64 Hz (Stober §4.1 tempo window) |
| `RHYTHM_MIN_HZ` | 0.5 | 30 BPM — lower musical tempo bound |
| `RHYTHM_MAX_HZ` | 5.0 | 300 BPM — upper musical tempo bound |
| `RHYTHM_STEP_HZ` | 0.1 | 6 BPM resolution at ~60 BPM |
| `RHYTHM_NUM_BINS` | 46 | `(5.0 − 0.5) / 0.1 + 1` |

DFT kernels (46 pairs of Hann-weighted cosine/sine arrays, length 512) are precomputed at construction.

### Stage 3: EEG Novelty Curve and Tempogram

Following Stober et al. (2016) §3.2:

1. **Channel aggregation**: quality-weighted average of the 4 Muse EEG channels (weights: good=1.0, marginal=0.5, poor=0.0), using the most recent 2048 samples (8 s at 256 Hz) from `EEGManager._chBuffersLong`
2. **Mean subtraction**: subtract a centered 0.5 s (128-sample) moving average to attenuate drift and center the signal around zero. Computed via prefix sum for O(N) efficiency.
3. **Hann-windowed DFT** at the same 46 frequency bins (0.5–5.0 Hz), using separate precomputed kernels of length 2048

| Constant | Value | Rationale |
|---|---|---|
| `EEG_AVG_WIN` | 128 | 0.5 s moving-average window at 256 Hz (Stober §3.2) |
| `EEG_TEMPO_BUF` | 2048 | 8 s at 256 Hz |

EEG kernels (46 pairs, length 2048) precomputed at construction (~752 KB).

### Stage 4: Entrainment Index

Inspired by Nozaradan et al. (2012) — tests whether beat-related frequencies are **selectively enhanced** in the EEG tempogram relative to non-beat frequencies:

1. **Z-score normalize** both tempograms independently: `z[i] = (x[i] − μ) / σ`
2. **Identify beat peaks** in audio: bins where `audioZ[i] > 0.5` (z-score threshold)
3. **Compute contrast**: `mean(eegZ[beatPeaks]) − mean(eegZ[nonPeaks])`
4. **Sigmoid mapping**: `sigmoid = 1 / (1 + exp(−2.0 × contrast))`
5. **Rescale to [0, 1]**: `index = max(0, 2 × (sigmoid − 0.5))` — maps no-entrainment (contrast ≤ 0) to 0

| Constant | Value | Rationale |
|---|---|---|
| `PEAK_Z_THRESH` | 0.5 | z-score threshold for beat frequency identification |
| `SIGMOID_K` | 2.0 | Sigmoid steepness |
| `ENTRAIN_EMA` | 0.15 | Output EMA smoothing (~3 s settling at 2 Hz) |

### Stage 5: Integration and Display

- **Bio source**: exposed as `'entrain'` in `ReactiveParticles.BIO_SOURCES`, mappable to any viz parameter through the MAPPING GUI
- **Audio tempogram heatmap**: scrolling viridis heatmap in `#spec-audio-canvas` (46 bins × 1 px/bin, same auto-scaling as EEG spectrograms)
- **Entrainment meter**: horizontal bar in bio-panel showing percentage fill

### Graceful Degradation

- Audio only (no EEG): audio tempogram displays, entrainment stays 0
- EEG only (no audio): EEG tempogram computed, entrainment stays 0
- Both missing: all outputs zero/null
- Track swap or EEG disconnect: entrainment decays to 0 via EMA

### References

- Nozaradan, S., Peretz, I., & Mouraux, A. (2012). Selective neuronal entrainment to the beat and meter embedded in a musical rhythm. *J. Neurosci.*, 32(49), 17572–17581.
- Stober, S., Prätzlich, T., & Müller, M. (2016). Brain beats: Tempo extraction from EEG data. *Proc. ISMIR*, 276–282.
- Grosche, P. & Müller, M. (2011). Extracting predominant local pulse information from music recordings. *IEEE TASLP*, 19(6), 1688–1701.

---

## §7 — EEG Complexity — Multiscale Entropy

**File:** `src/js/managers/ComplexityManager.js`

Multiscale entropy (MSE) characterises the complexity of a time series by
computing Sample Entropy (SampEn) at multiple temporal scales after
coarse-graining. A flat, low curve indicates a highly regular signal (e.g.
seizure activity, deep anesthesia); a curve that rises with scale indicates
rich cross-scale temporal structure — so-called "healthy" complexity.

### Stage 1 — Quality-weighted channel aggregation

- Source: `EEGManager._chBuffersLong` (2560-sample = 10 s per-channel buffers)
- Window: last **`WIN_SAMPLES = 2048`** samples (8 s at 256 Hz)
- Weights: `good=1.0`, `marginal=0.5`, `poor=0.0` (same convention as EntrainmentManager)
- Output: `Float32Array(2048)` of the weighted channel average

### Stage 2 — Tolerance r from full-signal σ

- `r = TOL_COEF · σ` with `TOL_COEF = 0.15` (Richman & Moorman, 2000 default)
- `σ` computed once on the aggregated window; r is **not** recomputed per scale
  so values at different scales remain on a common axis

### Stage 3 — Coarse-graining at τ ∈ SCALES

For each scale τ ∈ `SCALES = [1, 3, 5, 7, 9]`:

```
y[j] = (1/τ) · Σₖ₌₀^(τ-1)  x[j·τ + k],   j = 0 … ⌊N/τ⌋-1
```

Odd scales widen the temporal range beyond the original 1..6 convention while
keeping per-scale cost manageable. τ = 1 returns the original signal (no copy).
τ = 9 reduces the 2048-sample window to 227 samples — still within SampEn's
usable range for m=2.

### Stage 4 — Sample Entropy (m=2)

```
SampEn(m, r, N) = -ln( A / B )
  B = # pairs (i, j), i ≠ j, with Chebyshev distance ≤ r over m points
  A = # pairs (i, j), i ≠ j, with Chebyshev distance ≤ r over m+1 points
```

- `m = EMBED_DIM = 2` — standard choice, balances resolution vs. data requirement
- Self-matches (i = j) excluded → unlike ApEn, no log(1) bias
- Early exit on any dimension mismatch keeps the naïve O(N²·m) loop tolerable
- `B = 0` or `A = 0` → returns 0 (undefined log); caller treats as "insufficient data"

### Stage 5 — Output

- Each scale's raw SampEn is written directly to `mseCurve[i]` on each update;
  there is no temporal smoothing, so steps in the plot reflect real 0.2 Hz
  recomputations
- `complexity` = mean of the curve — a convenient scalar bio source

### Update cadence

- `UPDATE_INTERVAL_MS = 5000` (rate-limited to 0.2 Hz)
- At scale 1, N = 2048, inner loop ≈ 2M iterations. Scale 9 → ~25K.
  Total cost per update ~2–3M comparisons, runs synchronously in a few tens of ms
- If this causes visible hitches on slower machines, move to a Web Worker (the
  entire computation takes one `buf` copy + scalar outputs, so worker transfer is cheap)

### Constants

| Constant | Value | Purpose |
|---|---|---|
| `SCALES` | `[1, 3, 5, 7, 9]` | Coarse-graining scales (τ values) |
| `NUM_SCALES` | 5 | `SCALES.length` |
| `EMBED_DIM` | 2 | SampEn embedding dimension m |
| `TOL_COEF` | 0.15 | r = TOL_COEF · σ |
| `WIN_SAMPLES` | 2048 | Samples per update (8 s at 256 Hz) |
| `UPDATE_INTERVAL_MS` | 5000 | Minimum interval between updates |

### Display

- `#mse-canvas` (200 × 75 px) in `#bio-panel`: 5-line rolling timeseries (one line
  per τ ∈ `SCALES`), violet→amber color gradient across scales. Raw values — no
  smoothing — so the plot renders as a staircase, each step = one recomputation.
  Rolling window `MSE_ROLL = 1800` (~30 s at 60 fps) shows ~6 MSE update cycles.
  Y-axis fixed to `MSE_Y_MAX = 2.5` (SampEn rarely exceeds this in practice).
- Per-scale legend (`#mse-val-0`…`#mse-val-4`) shows the latest SampEn value for
  each τ.
- `#bio-mse-value`: scalar `complexity` (mean of all scales) to 2 decimals
- Bio source: `'complex'` — mappable to any viz parameter via MAPPING GUI

### References

- Costa, M., Goldberger, A. L., & Peng, C.-K. (2002). Multiscale entropy analysis of complex physiologic time series. *Physical Review Letters*, 89(6), 068102.
- Richman, J. S., & Moorman, J. R. (2000). Physiological time-series analysis using approximate entropy and sample entropy. *Am. J. Physiol. Heart Circ. Physiol.*, 278(6), H2039–H2049.

---

## §8 — Session Recording — JSONL Export

**File:** `src/js/managers/RecordingManager.js`

Captures **raw Muse sensor packets** plus nouscope's derived metrics into JSON
Lines (JSONL) format while toggled on. Raw sensor records preserve the native
muse-js reading shape (packet `index` / `sequenceId` + per-packet `samples`
array), so files are byte-compatible with the tested `eeg-recorder` analysis
pipeline (`eeg-recorder/analysis/utils.py`, `refs/eeg.py`), which reconstructs
the timeline from packet indices.

### Record types

| Type | Rate | Fields | Source |
|---|---|---|---|
| `meta` | 1× at start | `startedAt`, `app`, `device`, `deviceInfo`, `electrodeNames`, `sampleRates`, `audioBpm` | `start()` |
| `eeg` | ~21 packets/s ×4 ch | `index, electrode, timestamp, samples:[12 µV]` | raw `eegReadings` sub |
| `ppg` | ~11 packets/s ×3 ch | `index, ppgChannel, timestamp, samples:[6]` | `ppgReadings` sub |
| `accel` | ~17 packets/s | `sequenceId, samples:[{x,y,z}×3]` | `accelerometerData` sub |
| `gyro` | ~17 packets/s | `sequenceId, samples:[{x,y,z}×3]` | `gyroscopeData` sub |
| `bands` | ~2 Hz | `t, delta, theta, alpha, beta, gamma` (post-EMA) | `EEGManager._computeBandPower` |
| `hr` | ~1 Hz | `t, bpm` (from MSPTDfast) | `EEGManager._runMSPTD` |
| `entrain` | ~2 Hz | `t, idx` (smoothed) | `EntrainmentManager.update` |
| `mse` | ~0.2 Hz | `t, curve, complexity` | `ComplexityManager.update` |
| `music` | on track load / BPM change | `t, bpm` | `BPMManager.setBPM` |

- **Raw sensor records carry no `t`** — they store the native muse-js
  `index`/`sequenceId`/`timestamp` fields the analysis tools already use to
  rebuild the timeline. Recording whole readings (rather than the decimated
  per-sample rows used previously) is what makes the files analysis-compatible.
- **Derived records carry `t`** = `performance.now() - startedPerf` in
  milliseconds (one decimal place).
- Each path rides on its own data stream — no synchronous "tick" — so cadences
  reflect true per-packet arrival times.
- EEG raw packets come from a **dedicated `eegReadings` subscription** added
  alongside the `zipSamples` stream that feeds the band-power pipeline; PPG
  records **every channel** (not just the infrared channel used for HR).

### Persistence — periodic flush + RAM clearing

Two modes, selected at `start()`:

- **stream** (File System Access API; Chrome/Edge): `start()` prompts for a save
  location (requires the record-button click as the user gesture) and opens a
  long-lived `FileSystemWritableFileStream`. Records accumulate in a small
  `_pending` buffer; a `setInterval` flush (`FLUSH_INTERVAL_MS = 4000`) writes
  the batch to the stream and **clears `_pending`**, so RAM stays bounded
  regardless of session length and data is streamed to disk incrementally
  instead of held until Stop. Flushes are serialized via a `_flushing` guard so
  `write()` calls never overlap. `stop()` drains the buffer and `close()`s the
  stream — no download needed.
- **memory** (fallback when the API is unavailable, or the user dismisses the
  picker → recording simply doesn't start): flushed chunks accumulate in
  `_lines` and `stop()` returns a `Blob` the browser downloads as
  `nouscope-<iso>.jsonl`.

### Design choices

- **Hook pattern**: each data path calls `App.recordingManager?.recordX(...)`
  directly; when not recording the call is a no-op (early `isRecording` check) —
  one optional chain + one branch per packet.
- **Pre-serialization**: `JSON.stringify(obj)` runs at record time, so a flush
  is just `pending.join('\n')` — no deep walk over an accumulated object graph.
- **Crash resilience**: in stream mode at most `FLUSH_INTERVAL_MS` of data is
  in RAM; everything older has been written to the disk stream. (Note: the
  File System Access API commits the swap file to the target on `close()`; an
  abrupt crash leaves a recoverable swap file rather than auto-finalizing.)

### Memory profile

- Stream mode: bounded — only the last ≤4 s of records plus a one-batch write
  buffer are resident, so multi-hour sessions are safe.
- Memory fallback: ~the same per-packet byte cost as before; a full-stream hour
  is on the order of tens of MB. Prefer stream mode for long sessions.

### UI

- `⏺ ` button in `#eeg-controls` (visible only when EEG is connected).
- Active state: red border + pulsing outline animation.
- Elapsed time (`MM:SS`) shown next to the button while recording.
- Click to start (prompts for file in stream mode); click again to stop.

---

## §9 — Offline Phase-Locking Entrainment (ITC/PLV)

**Files:** `analysis/entrainment.py`, `analysis/entrainment_plotting.py`,
`analysis/nouscope_entrainment.py`, `analysis/test_entrainment.py`

The realtime `EntrainmentManager` (§6) and the offline tempogram
(`utils.eeg_tempogram_timeseries`) are **power-based** — they compare tempogram
*magnitude*. Slow-wave power rises under both drowsiness and genuine entrainment,
so power cannot separate them. This offline pipeline measures **phase
consistency** instead: does the brain hold a stable timing offset relative to the
musical beat grid? It needs no reference audio — it runs against the *nominal*
beat ladder from `meta.audioBpm` and re-runs unchanged when the exact tempo lands
(only `fundamental_hz` changes). Reuses `utils.py` for loading, gridding,
quality-weighting, and gap handling.

### Stage 0 — Sample-clock QC (`verify_sample_clock`)

`utils.py` reconstructs the EEG timeline as `index × 12 / 256`, i.e. it *assumes*
exactly 256 Hz. Phase error accumulates linearly, so a wrong rate slides the EEG
out of alignment with the beat over a 20-min run. The device `timestamp` is
unusable (float32-mangled — its long-baseline span implies ~10⁷ s for a 27-min
file). Instead we cross-check the index-derived EEG duration against the
`performance.now()`-based derived streams (`bands`/`hr`/`mse`/`entrain`):
`effective_fs = n_eeg_samples / real_duration`. Measured on the three sessions:
**256.03–256.05 Hz (+130…+200 ppm)** — well within tolerance and ~100× smaller
than the 122-vs-124 bpm tempo uncertainty. The corrected `effective_fs` feeds all
downstream phase math. Precision is ~±150 ppm (start/stop offset); sub-100 ppm
calibration needs alignment to the reference audio.

### Stage 1 — Quality-weighted signal (`quality_weighted_signal`)

Collapse the 4-channel EEG to one signal using `utils._quality_weights` (drop up
to 2 worst channels; good=1.0, marginal=0.5) resolved per signal-quality window
and applied per sample. Samples are NaN where a weighted channel is missing or all
channels are poor. ≤50 ms gaps are then interpolated (`interpolate_short_gaps`,
`GAP_MAX=13`); longer gaps stay NaN and are skipped.

### Stage 2 — Narrowband analytic phase (`morlet_analytic`)

Complex Morlet wavelet at each ladder frequency (`N_CYCLES_FILTER=6`),
energy-normalised, applied per contiguous non-NaN segment via `fftconvolve`
(edges NaN). Returns the complex analytic signal — `angle` = instantaneous phase,
`abs` = amplitude.

### Stage 3 — Phase-locking value (`_plv_power_series`)

Reference beat-grid oscillator `ψ(t) = 2π·f₀·t` (using the corrected `effective_fs`).
Relative phase `Δ(t) = angle(z) − ψ`; over a sliding window,
**`PLV = |mean(exp(iΔ))|`** (1 = perfectly locked, ~0 = random). Window length =
`PLV_WIN_CYCLES=8` cycles, clipped to [6, 30] s; common eval grid `EVAL_HOP_S=2` s;
a window needs ≥`MIN_VALID_FRAC=0.5` valid samples. Band power = mean `|z|²` on the
same window (the power view for the discriminator).

### Beat ladder

Multiples of the beat `f₀ = audioBpm/60` (nominal 2.067 Hz at 124 bpm):
×4 (16th), ×3 (triplet), ×2 (8th), ×1 (beat), ×½ (in-2), ×⅓ (in-3), ×⅙ (phrase).

### Null floor — pre-music quiet baseline (`_baseline_floor`)

**Not a Fourier/circular-shift surrogate.** For a steady-state frequency-tagging
design those fail: phase-scramble keeps the beat-frequency line locked (floor ≈ 1.0,
explains the effect away) and a global circular shift is a constant phase offset
that PLV is invariant to. The valid null is the **pre-music quiet segment** — PLV
there is finite-window bias + endogenous rhythm with no stimulus, so entrainment =
PLV *rising above baseline* during music. Frequency specificity (PLV peaks at the
ladder, not at neighbours) is the second axis, via the off-ladder scan. `test_entrainment.py` validates detection, frequency
specificity, and tempo-mismatch erosion on synthetic signals.

### Views

- **Discriminator** (`segments`): per-rung PLV and power over pre / music / post
  windows (nominal 0–2 / 2–22 / 22–end min — assumed; recordings carry no onset
  marker). The money plot: power up in quiet-drowsy *and* music, PLV up only in music.
- **Ladder matrix**: PLV(rung, time) heatmap.
- **Ring-down** (`_fit_ringdown`): fit `A·exp(-(t-t₀)/τ)+C` to the beat-rung PLV
  after the music offset — persistence τ vs step drop.
- **Off-ladder scan** (`_off_ladder_scan`): PLV on a fine 0.3–8 Hz grid over the
  music segment; flags peaks above the broadband (median+MAD) floor not on a rung
  (e.g. ~5 Hz endogenous theta, Wollman 2020).
- **Bistable meter**: in-2 (½×) vs in-3 (⅓×) PLV over time — competition/switching,
  per subject (never averaged).

Constants live at the top of `entrainment.py`. Output figure:
`data/session{n}.entrainment.png`. N=3 → per-subject case studies, not group stats.

### References

- Nozaradan, S., Peretz, I., et al. (2012). Tagging the neuronal entrainment to beat and meter. *J. Neurosci.*
- Stober, S., et al. (2016). Brain Beats.
- Wollman, I., et al. (2020). Neural entrainment to ~5 Hz endogenous theta.
- Kaneshiro, B., et al. (2020). Stimulus-response correlation (SRC), natural music. *NeuroImage.* (SRC pending audio.)
