# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server (http://localhost:5173)
npm run build     # Production build (outputs to dist/)
npm run preview   # Preview production build
```

No test suite is configured.

## Architecture

**Nouscope** — an audio-reactive 3D particle visualizer with optional Muse EEG/PPG/IMU biometric integration, built with Three.js and WebGL.

### Entry Point & Boot Sequence

`src/js/index.js` instantiates `App`. The `App` constructor immediately:
1. `_setupEEG()` — instantiates `EEGManager` and wires the connect/disconnect UI (so EEG can connect before music starts)
2. `_setupJellyfin()` — instantiates `JellyfinManager` and `JellyfinBrowser`, wires the `☁ Jellyfin` button

Then on user interaction (click for demo track, file upload via the Track button, or track selection from Jellyfin browser):
2. `AudioManager.loadAudioBuffer(source)` — loads a `File` object or fetches `/audio/demo.mp3`
3. `BPMManager.detectBPM()` — analyzes the buffer with `web-audio-beat-detector`
4. `ReactiveParticles.init()` — creates ShaderMaterial, builds mesh, adds dat.GUI
5. `update()` render loop starts

If `demo.mp3` is absent the UI shows an error; audio can be replaced at any time via the Track button (file upload) or the `☁ Jellyfin` button (stream from server). When EEG connects (before or after music), `autoMix` and `autoRotate` are set to `false` and `headControl` to `true`.

### Key Modules

| File | Responsibility |
|------|----------------|
| `src/js/App.js` | Scene, camera, renderer, resize, render loop, coordinates all managers |
| `src/js/managers/AudioManager.js` | Audio loading (File or URL), Three.js AudioListener/AudioAnalyser, normalized `{ low, mid, high }` frequency bands |
| `src/js/managers/BPMManager.js` | BPM detection, beat event dispatch via Three.js EventDispatcher |
| `src/js/managers/EEGManager.js` | Muse BT connection (Web Bluetooth), EEG band powers, PPG heart rate, IMU head pose; exposes raw display buffers + sample counters |
| `src/js/ui/BioDataDisplay.js` | Live webgl-plot panel: scrolling EEG (4ch), PPG, and IMU (accel+gyro) traces; signal quality dots |
| `src/js/managers/JellyfinManager.js` | Jellyfin API client: auth (username/password or API key), paginated music library browsing, stream URL generation; credentials persisted to `localStorage` (token only, never password) |
| `src/js/ui/JellyfinBrowser.js` | Modal UI for Jellyfin: login view + library browser with debounced search and Load More pagination |
| `src/js/entities/ReactiveParticles.js` | Particle geometry (box/cylinder), ShaderMaterial uniforms, GSAP beat reactions, EEG/HR/IMU integration, dat.GUI |
| `src/js/entities/glsl/vertex.glsl` | Simplex noise + curl force field for particle displacement, amplitude modulation |
| `src/js/entities/glsl/fragment.glsl` | Circular point shape, distance-based color gradient, EEG hue shift (HSV rotation), heartPulse warm flush |

### Audio → Visual Pipeline

Each frame in `App.update()`:
1. `EEGManager.update(performance.now())` — advances the heart-rate phase oscillator
2. `ReactiveParticles.update(bandPower, heartPulse, headPose)` — maps audio + EEG to uniforms
3. `AudioManager.update()` — refreshes the FFT analyser data

On each BPM beat, `ReactiveParticles.onBPMBeat()` randomly (30% chance each) triggers a GSAP rotation tween and/or a geometry swap (box ↔ cylinder).

### Shader Uniforms → Data Sources

| Uniform | Driven by | Visual effect |
|---------|-----------|---------------|
| `time` | frame counter (audio-speed scaled) | overall animation speed |
| `amplitude` | audio `high` × EEG `gamma` | particle displacement intensity |
| `offsetGain` | audio `mid` × EEG `beta` | turbulence / z-oscillation |
| `size` | `BASE_SIZE` × EEG `theta` | base particle size |
| `maxDistance` | `BASE_MAX_DISTANCE` × EEG `alpha` | displacement falloff radius |
| `frequency` | GSAP base × EEG `beta` | curl field frequency / chaos |
| `hueShift` | EEG `gamma` | HSV hue rotation of color palette |
| `heartPulse` | PPG heart rate oscillator (0–1) | warm reddish color flush per beat |
| `startColor` / `endColor` | dat.GUI | gradient colors across displacement distance |
| `offsetSize` | randomized per geometry | point size jitter scale |

EEG uses **multiplicative** scaling: `uniform *= (1 + source * weight)`. This means EEG modulates audio reactivity rather than adding small offsets — a focused brain amplifies the music's visual effect.

### EEGManager — Signal Processing

- **EEG bands**: rolling 256-sample buffer, Hann window + DFT (1 Hz bins, 1–50 Hz). Outputs normalized `bandPower { delta, theta, alpha, beta, gamma }` (relative power, sum = 1). Three-layer temporal smoothing: source EMA (`BAND_SMOOTH=0.35`, ~1.5 s settling) in EEGManager prevents staircase jumps; per-frame lerp (`EEG_LERP_RATE=0.06`) in ReactiveParticles interpolates between ~2 Hz updates for smooth 60 fps visuals; display lerp (`BAND_LERP=0.08`) in BioDataDisplay smooths the diagnostic band plot.
- **Spectrogram**: Hann-windowed DFT at bins 1–50 Hz, quality-weighted channel average, percentage-based artifact rejection (±150 µV threshold, reject window if >10% of samples exceed on any retained channel). Produces rolling `spectrumDisplay` buffer of log₁₀(power) columns + `spectrumSampleCount` counter. Twiddle factors for all 50 bins precomputed at construction time (shared with delta band DFT for bins 1–3).
- **PPG / heart rate**: IIR bandpass (HP 0.5 Hz → LP 3.5 Hz), MSPTDfast v2 batch detector (6 s window, re-run every 1 s). Median IBI → `heartRate` BPM. Phase oscillator → `heartPulse` (0–1, cubed-sine shape).
- **IMU / head pose**: exponential low-pass (α=0.08) on accelerometer → `headPose { pitch, roll }` in radians. Gyroscope also subscribed.
- `enablePpg = true` must be set on `MuseClient` before `connect()` — already handled in `EEGManager.connect()`.
- **Display buffers**: `eegChannels[4]` (1024-sample rolling), `ppgDisplay` getter (384-sample rolling), `accelDisplay`/`gyroDisplay` ({x,y,z} rolling). Monotonic counters `eegSampleCount`, `ppgSampleCount`, `imuSampleCount` allow consumers to detect new samples even after buffers reach capacity.
- **Signal quality**: `signalQuality[4]` — per-channel RMS after mean subtraction, updated ~4×/s. `'good'` (rms < 10 µV), `'marginal'` (10–50 µV), `'poor'` (> 50 µV).

### BioDataDisplay — Live Data Panel

- Toggle button `◉` appears in `#eeg-controls` once EEG connects; opens `#bio-panel` above controls.
- Three `WebglLineRoll` plots (webgl-plot library): EEG 4-channel stacked, PPG single trace (auto-scaled), IMU accel+gyro 6 lines.
- **Spectrogram**: Two 2D `<canvas>` heatmaps with viridis colormap on log₁₀ power, auto-scaled. Full spectrogram (`#spec-canvas`, 280×86 px): bins 8–50 Hz, 2 px/bin. Delta/theta zoom (`#spec-lo-canvas`, 280×48 px): bins 1–8 Hz, 6 px/bin. Both use 2 px column width; scrolling via `drawImage(canvas, -2, 0)` shift. Frequency axis labels alongside each canvas. Sit between EEG raw traces and EEG Bands.
- Signal quality shown as colored dots (green/yellow/red) per EEG channel.
- Panel and toggle hidden when EEG is disconnected.

### dat.GUI Structure (ReactiveParticles.addGUI)

- **PARTICLES**: Start Color, End Color
- **VISUALIZER**: Auto Mix (geometry swap on beat), Auto Rotate (GSAP rotation on beat), Head Control (IMU) — routes pitch/roll to `holderObjects.rotation`, Reset Cylinder
- **AUDIO**: Bass Gain, Mid Gain, High Gain (all 0–2)
- **MAPPING**: Per-parameter sub-folders (Amplitude, Turbulence, Particle Size, Spread Radius, Field Chaos, Hue Shift, Color Flush) each with Source dropdown + Weight slider

### Jellyfin Integration

**Files:** `src/js/managers/JellyfinManager.js`, `src/js/ui/JellyfinBrowser.js`

- `☁ Jellyfin` button in `#eeg-controls` opens the browser modal at any time (before or after audio starts).
- If audio is not yet started, selecting a track calls `App.init(streamUrl)`; if already running, calls `App._swapAudio(streamUrl)`. `AudioManager.loadAudioBuffer()` accepts URL strings natively.
- **Auth options:** username/password (`POST /Users/AuthenticateByName` → stores returned `AccessToken`) or a pre-existing API key stored directly as the token. Jellyfin API key auth has no `UserId`.
- **Credential storage:** `serverUrl`, `token`, and `userId` are persisted in `localStorage` under key `nouscope_jellyfin`. Passwords are **never** stored.
- **Server URL validation:** `_sanitizeServerUrl()` parses via `new URL()`, enforces `http:`/`https:` protocol, and returns `origin` only — preventing `javascript:`, `file:`, or path-injection variants.
- **XSS prevention:** Track metadata (name, artist, album) from the Jellyfin API is rendered via `textContent` only — never via `innerHTML`. No `_esc()` helper is needed or used.
- **Stream URL:** `/Audio/{itemId}/universal?api_key={token}&...` — the token appears as a query parameter. This is required by Jellyfin's streaming API; `Authorization` headers cannot be used for `fetch().arrayBuffer()` streaming. The token is therefore visible in browser network logs and Jellyfin server access logs. This is an accepted, documented tradeoff.
- **CORS:** Jellyfin defaults to `Access-Control-Allow-Origin: *`. Users with locked-down CORS must add the Nouscope origin in Jellyfin → Dashboard → Networking → Allowed Origins.

### Standing Rules

- **After any algorithm or signal-processing change, update `docs/algorithms.md`** to match the new implementation. Keep constants, stage descriptions, and pseudocode in sync with the code.

### Build Notes

- Vite config uses `rollup-plugin-glslify` for GLSL imports; `@` alias resolves to `src/`
- SCSS compiled by Vite's built-in Sass support
- `muse-js` is installed from `github:soundtrip-health/muse-js#muse3` (not npm registry)
- Web Bluetooth (EEG) requires Chrome or Edge; HTTPS required in production
- Demo track must be placed at `public/audio/demo.mp3` (not bundled in the repo)
