# Nouscope

An audio-reactive 3D particle visualizer with optional Muse EEG/PPG/IMU biometric integration, built with Three.js and WebGL.

## Live Demo

[https://soundtrip.health/nouscope](https://soundtrip.health/nouscope)

## Features

- Audio-reactive 3D particle system (Three.js / WebGL)
- Audio BPM beat detection — geometry swaps and rotations sync to the beat
- Five EEG frequency bands (delta, theta, alpha, beta, gamma) mapped to visual parameters
- PPG heart rate detection with per-beat warm color pulse
- IMU head-pose control — tilt your head to rotate the particle field
- Upload your own audio or use the bundled demo track
- dat.GUI controls for colors, mixing, and biometric influence strength

## Browser Support

| Feature | Chrome | Edge | Firefox | Safari |
|---------|--------|------|---------|--------|
| Visualizer | ✅ | ✅ | ✅ | ✅ |
| EEG (Web Bluetooth) | ✅ | ✅ | ❌ | ❌ |

**Note:** EEG/Bluetooth features require Chrome or Edge. HTTPS is required for Web Bluetooth in production.

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install & Run

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome or Edge.

### Demo Track

Place a royalty-free MP3 at `public/audio/demo.mp3`. Suggested sources:

- [Freesound.org](https://freesound.org) — filter by CC0
- [Free Music Archive](https://freemusicarchive.org) — filter by CC0

If `demo.mp3` is absent, the app prompts the user to upload a file.

## Usage

1. Click anywhere to start with the demo track, or use **Upload your own audio file**
2. The particle field reacts to audio in real time
3. Optionally click **Connect EEG** to pair a Muse headset via Bluetooth
4. Use the dat.GUI panel (top-right, desktop only) to adjust colors and biometric influence

## EEG Integration

Requires a [Muse](https://choosemuse.com/) EEG headset (Muse 2 or Muse S) and Chrome or Edge.

| EEG Band | Frequency | Visual Effect |
|----------|-----------|--------------|
| Delta (1–4 Hz) | Deep sleep | Particle spread radius |
| Theta (4–8 Hz) | Drowsy / relaxed | Particle size |
| Alpha (8–13 Hz) | Calm / idle | Ring spread radius |
| Beta (13–30 Hz) | Focused / alert | Turbulence intensity |
| Gamma (30–50 Hz) | High cognition | Amplitude boost |

**PPG / Heart Rate** — detects heartbeats from the Muse's infrared sensor and drives a warm color flush on each beat.

**IMU / Head Pose** — accelerometer pitch and roll map to particle field rotation when **Head Control (IMU)** is enabled in the GUI.

## Customization

All visual parameters are exposed via the dat.GUI panel:

| Folder | Control | Effect |
|--------|---------|--------|
| PARTICLES | Start Color / End Color | Gradient colors across displacement distance |
| VISUALIZER | Auto Mix | Randomly swap geometry on each beat |
| VISUALIZER | Auto Rotate | GSAP-driven rotation tweens on beats |
| VISUALIZER | Head Control (IMU) | Route IMU pitch/roll to rotation |
| VISUALIZER | Reset Cylinder | Manually reset to cylinder geometry |
| INFLUENCE | EEG / HR / IMU Strength | Scale (0–3×) each biometric input |

### Shader Uniforms

| Uniform | Driven by | Effect |
|---------|-----------|--------|
| `amplitude` | audio high + EEG gamma | particle displacement intensity |
| `offsetGain` | audio mid + EEG beta | turbulence / z-oscillation |
| `size` | EEG theta | base particle size |
| `maxDistance` | EEG alpha | displacement falloff radius |
| `heartPulse` | PPG heart rate | warm reddish color flush |

## Developer Guide

For a detailed explanation of the signal processing algorithms, shader math, and biometric → visual parameter mappings, see [`docs/algorithms.md`](docs/algorithms.md).

## Architecture

```
src/js/
├── index.js                  — entry point, instantiates App
├── App.js                    — scene, camera, renderer, managers, render loop
├── managers/
│   ├── AudioManager.js       — audio loading (File or URL), freq band extraction
│   ├── BPMManager.js         — BPM detection, beat event dispatcher
│   └── EEGManager.js         — Muse BT, EEG bands, PPG heart rate, IMU head pose
└── entities/
    ├── ReactiveParticles.js  — ShaderMaterial, GSAP tweens, audio/EEG mapping
    └── glsl/
        ├── vertex.glsl       — simplex noise curl field, particle displacement
        └── fragment.glsl     — circular point shape, distance color gradient, heartPulse
```

### Audio → Visual Pipeline

1. `AudioManager.update()` produces normalized `{ low, mid, high }` each frame
2. `ReactiveParticles.update()` maps these to shader uniforms
3. `EEGManager` streams band powers and heart rate over Bluetooth
4. On each BPM beat, `onBPMBeat()` randomly triggers geometry swaps or rotation tweens

## Credits

- Original particle visualizer concept and tutorial: [Tiago Canzian](https://github.com/tgcnzn/Interactive-Particles-Music-Visualizer)
- EEG/PPG/IMU integration: [Soundtrip](https://github.com/soundtrip-health)
- [muse-js](https://github.com/soundtrip-health/muse-js) — Web Bluetooth Muse SDK
- [web-audio-beat-detector](https://github.com/chrisguttandin/web-audio-beat-detector) — BPM detection
- [Three.js](https://threejs.org) — 3D rendering
- [GSAP](https://greensock.com/gsap/) — animation
- Simplex noise: [Ian McEwan / Ashima Arts](https://github.com/ashima/webgl-noise)

## License

MIT — see [LICENSE](LICENSE)
