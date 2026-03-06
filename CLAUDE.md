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

`src/js/index.js` instantiates `App`. `App.js` waits for a user interaction (click for demo track, or file upload), then:
1. `AudioManager.loadAudioBuffer(source)` — loads a `File` object or fetches `/audio/demo.mp3`
2. `BPMManager.detectBPM()` — analyzes the buffer with `web-audio-beat-detector`
3. `ReactiveParticles.init()` — creates ShaderMaterial, builds mesh, adds dat.GUI
4. `_setupEEG()` — instantiates `EEGManager` and wires the connect/disconnect UI
5. `update()` render loop starts

If `demo.mp3` is absent, the UI prompts for file upload. Audio can always be replaced by uploading a file.

### Key Modules

| File | Responsibility |
|------|----------------|
| `src/js/App.js` | Scene, camera, renderer, resize, render loop, coordinates all managers |
| `src/js/managers/AudioManager.js` | Audio loading (File or URL), Three.js AudioListener/AudioAnalyser, normalized `{ low, mid, high }` frequency bands |
| `src/js/managers/BPMManager.js` | BPM detection, beat event dispatch via Three.js EventDispatcher |
| `src/js/managers/EEGManager.js` | Muse BT connection (Web Bluetooth), EEG band powers, PPG heart rate, IMU head pose |
| `src/js/entities/ReactiveParticles.js` | Particle geometry (box/cylinder), ShaderMaterial uniforms, GSAP beat reactions, EEG/HR/IMU integration, dat.GUI |
| `src/js/entities/glsl/vertex.glsl` | Simplex noise + curl force field for particle displacement, amplitude modulation |
| `src/js/entities/glsl/fragment.glsl` | Circular point shape, distance-based color gradient, heartPulse warm flush |

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
| `amplitude` | audio `high` + EEG `gamma` | particle displacement intensity |
| `offsetGain` | audio `mid` + EEG `beta` | turbulence / z-oscillation |
| `size` | EEG `theta` | base particle size |
| `maxDistance` | EEG `alpha` | displacement falloff radius |
| `heartPulse` | PPG heart rate oscillator (0–1) | warm reddish color flush per beat |
| `startColor` / `endColor` | dat.GUI | gradient colors across displacement distance |
| `offsetSize` | randomized per geometry | point size jitter scale |
| `frequency` | GSAP-tweened per beat | curl field frequency |

### EEGManager — Signal Processing

- **EEG bands**: rolling 256-sample buffer, Hann window + DFT (1 Hz bins, 1–50 Hz). Outputs normalized `bandPower { delta, theta, alpha, beta, gamma }` (relative power, sum = 1).
- **PPG / heart rate**: IIR bandpass (HP 0.5 Hz → LP 3.5 Hz), look-back peak detector with adaptive threshold (mean + 0.3σ), 300 ms refractory. Median filter (kernel=5) on IBIs → `heartRate` BPM. Phase oscillator → `heartPulse` (0–1, cubed-sine shape).
- **IMU / head pose**: exponential low-pass (α=0.08) on accelerometer → `headPose { pitch, roll }` in radians.
- `enablePpg = true` must be set on `MuseClient` before `connect()` — already handled in `EEGManager.connect()`.

### dat.GUI Structure (ReactiveParticles.addGUI)

- **PARTICLES**: Start Color, End Color
- **VISUALIZER**: Auto Mix (geometry swap on beat), Auto Rotate (GSAP rotation on beat), Head Control (IMU) — routes pitch/roll to `holderObjects.rotation`, Reset Cylinder
- **INFLUENCE**: EEG Strength, HR Strength, IMU Strength (all 0–3×)

### Build Notes

- Vite config uses `rollup-plugin-glslify` for GLSL imports; `@` alias resolves to `src/`
- SCSS compiled by Vite's built-in Sass support
- `muse-js` is installed from `github:soundtrip-health/muse-js#muse3` (not npm registry)
- Web Bluetooth (EEG) requires Chrome or Edge; HTTPS required in production
- Demo track must be placed at `public/audio/demo.mp3` (not bundled in the repo)
