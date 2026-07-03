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

**Nouscope** — a Muse EEG/PPG/IMU biometric visualizer. The live bio-data panel (webgl-plot line traces + 2D canvas heatmaps) IS the visualization; there is no 3D scene. Audio playback is optional and its only purpose is to drive the EEG–music entrainment analysis.

### Entry Point & Boot Sequence

`src/js/index.js` instantiates `App`. The `App` constructor immediately:
1. Wires the `↑ Track` file-upload input (first upload starts audio; later uploads swap the track)
2. `_setupEEG()` — instantiates `EEGManager` and `ComplexityManager`, wires the connect/disconnect UI and the `◉` bio-panel toggle
3. `_setupRecording()` — instantiates `RecordingManager`, wires the `⏺` record button
4. `_setupFullscreen()` — wires the `⛶` full-screen bio-panel toggle + Escape key
5. Starts the `update()` loop immediately (requestAnimationFrame) so EEG/bio plots run before — or entirely without — audio

Audio is optional. On the first `↑ Track` upload, `_startAudio(file)`:
6. `AudioManager.loadAudioBuffer(file)` — reads the `File` into an AudioBuffer
7. `BPMManager.detectBPM()` — analyzes the buffer with `web-audio-beat-detector` (exposes `bpmValue` for recording metadata)
8. `EntrainmentManager` — instantiated (precomputes DFT kernels for tempogram analysis)
9. `AudioManager.play()` + the `⏸` pause button appear

There is no landing overlay and no demo track — the app opens straight to the controls bar. EEG can connect before, after, or without any audio.

### Key Modules

| File | Responsibility |
|------|----------------|
| `src/js/App.js` | Manager coordination, UI wiring, update loop (no renderer/scene) |
| `src/js/managers/AudioManager.js` | Audio loading (File or URL), Three.js AudioListener/AudioAnalyser, spectral-flux novelty ring buffer for entrainment |
| `src/js/managers/BPMManager.js` | Tempo detection via `web-audio-beat-detector`; exposes `bpmValue` (recording metadata). No beat events. |
| `src/js/managers/EntrainmentManager.js` | Real-time EEG–music entrainment: parallel audio/EEG tempograms (0.5–5 Hz), z-score selective enhancement comparison, entrainment index (0–1) |
| `src/js/managers/ComplexityManager.js` | Multiscale entropy (MSE) on quality-weighted 4-channel EEG average; SampEn at 6 scales, updated ~0.2 Hz; exposes `mseCurve` + `complexity` scalar |
| `src/js/managers/RecordingManager.js` | In-memory JSONL recorder: raw EEG/PPG/IMU + bands/HR/entrainment/MSE. Start/stop toggle; downloads timestamped `nouscope-*.jsonl` file |
| `src/js/managers/EEGManager.js` | Muse BT connection (Web Bluetooth), EEG band powers, PPG heart rate, IMU head pose; exposes raw display buffers + sample counters |
| `src/js/ui/BioDataDisplay.js` | Live webgl-plot panel: scrolling EEG (4ch), PPG, and IMU (accel+gyro) traces; spectrograms; audio tempogram; entrainment meter; signal quality dots |

### Update Loop

Each frame in `App.update()`:
1. `EEGManager.update(performance.now())` — advances the heart-rate phase oscillator, processes buffered samples
2. `_updateBioPanel()` — signal-quality dots, HR readout, and (when visible) `BioDataDisplay.update()`
3. `AudioManager.update()` — refreshes FFT analyser data + samples spectral-flux novelty (no-op when not playing)
4. `EntrainmentManager.update(now)` — rate-limited to ~2 Hz; computes audio/EEG tempograms and entrainment index
5. `ComplexityManager.update(now)` — rate-limited to ~0.2 Hz; computes 6-scale MSE on the EEG long buffer

There is no 3D render step — the bio-panel canvases are updated directly by `BioDataDisplay`.

### EEGManager — Signal Processing

- **EEG bands** (see `docs/algorithms.md` §3): rolling 256-sample buffers per channel; delta (1–4 Hz) via sparse Hann-weighted DFT bins 1–3; theta–gamma via Morlet wavelet mean power; quality-weighted channel aggregation with optional drops; aperiodic (1/f) background normalization; relative `bandPower { delta, theta, alpha, beta, gamma }`. `normalizeBands` (a fixed `Set`, default `theta/alpha/beta/gamma`) selects which bands participate in the normalization sum; delta is excluded by default so its movement-prone power cannot swamp the higher bands. Temporal smoothing: source EMA (`BAND_SMOOTH=0.35`) and display lerp (`BAND_LERP=0.08`) in BioDataDisplay.
- **Spectrogram** (display only): separate Hann-DFT pipelines — main panel: bins 1–50 Hz at 1 Hz from the 256-sample window; low-frequency panel: 0.5–8.0 Hz at 0.1 Hz from a 2560-sample (10 s) buffer. Quality-weighted channel average; log₁₀(power) columns in rolling buffers (`spectrumSampleCount`, `spectrumLoSampleCount`). Robust auto-scaling (percentile window + cap) lives in `BioDataDisplay`.
- **PPG / heart rate**: IIR bandpass (HP 0.5 Hz → LP 3.5 Hz), MSPTDfast v2 batch detector (6 s window, re-run every 1 s). Median IBI → `heartRate` BPM. Phase oscillator → `heartPulse` (0–1, cubed-sine shape).
- **IMU / head pose**: exponential low-pass (α=0.08) on accelerometer → `headPose { pitch, roll }` in radians. Gyroscope also subscribed.
- `enablePpg = true` must be set on `MuseClient` before `connect()` — already handled in `EEGManager.connect()`.
- **Display buffers**: `eegChannels[4]` (1024-sample rolling), `ppgDisplay` getter (384-sample rolling), `accelDisplay`/`gyroDisplay` ({x,y,z} rolling). Monotonic counters `eegSampleCount`, `ppgSampleCount`, `imuSampleCount` allow consumers to detect new samples even after buffers reach capacity.
- **Signal quality**: `signalQuality[4]` — per-channel RMS after mean subtraction, updated ~4×/s. `'good'` (rms < 50 µV), `'marginal'` (50–100 µV), `'poor'` (> 100 µV).

### EntrainmentManager — EEG–Music Entrainment

- **Audio novelty**: spectral flux (half-wave rectified spectral difference) sampled per render frame (~60 Hz) into a timestamped ring buffer (768 entries) by `AudioManager._sampleNovelty()`
- **Audio tempogram**: resampled novelty at 64 Hz → 8 s Hann-windowed DFT at 0.5–5.0 Hz (46 bins, 0.1 Hz steps). Precomputed kernels (512 samples).
- **EEG tempogram**: quality-weighted 4-channel average → subtract 0.5 s moving average → 8 s Hann-windowed DFT at same 46 bins. Precomputed kernels (2048 samples).
- **Entrainment index**: z-score both tempograms → identify audio beat peaks (z > 0.5) → contrast = mean(eegZ at peaks) − mean(eegZ at non-peaks) → sigmoid → rescale to [0, 1]. EMA smoothed (α=0.15).
- Updates at ~2 Hz (`UPDATE_INTERVAL_MS=500`). Exposes `entrainment` (0–1), `audioTempogram`, `eegTempogram`.
- Graceful degradation: audio-only shows tempogram but entrainment=0; EEG-only likewise; both missing → all zero.
- References: Nozaradan et al. (2012), Stober et al. (2016) "Brain Beats"

### ComplexityManager — Multiscale Entropy

- **Input**: quality-weighted 4-channel EEG average over the last 2048 samples (8 s at 256 Hz) from `EEGManager._chBuffersLong`
- **Coarse-graining** at scales τ ∈ {1..6}: each scale averages τ consecutive samples
- **Sample Entropy** (Richman & Moorman): m=2, r=0.15·σ (σ fixed from the full-signal std for cross-scale comparability), Chebyshev distance, self-matches excluded
- **Output**: `mseCurve` (Float32Array(6), EMA-smoothed α=0.4) and scalar `complexity` (mean of curve)
- Updates at ~0.2 Hz (`UPDATE_INTERVAL_MS=5000`); computation is synchronous (~tens of ms)
- **Display**: `#mse-canvas` (280×60 px) 6-bar chart in bio-panel; violet→amber color gradient across scales; label in `#bio-mse-value`
- Graceful degradation: EEG disconnected → curve decays to 0 via EMA; all-poor quality → decay
- References: Costa, Goldberger & Peng (2002); Richman & Moorman (2000)

### RecordingManager — JSONL Data Export

- **Pattern**: push-based. EEGManager/EntrainmentManager/ComplexityManager/BPMManager call `App.recordingManager?.recordX(...)` at data-production sites; when `isRecording=false`, the calls are cheap no-ops
- **Record types** (`t` is ms since start):
  - `eeg` — `ch:[tp9,af7,af8,tp10]` at 256 Hz (raw µV from Muse)
  - `ppg` — `raw` at 64 Hz (unfiltered infrared)
  - `accel`, `gyro` — `x,y,z` at ~52 Hz (packet-averaged)
  - `bands` — `delta,theta,alpha,beta,gamma` at ~2 Hz (post-EMA output)
  - `hr` — `bpm` after each successful MSPTD detection
  - `music` — `bpm` on track load / BPM change
  - `entrain` — `idx` at ~2 Hz (smoothed entrainment)
  - `mse` — `curve[]`, `complexity` at ~0.2 Hz
  - `meta` header line at start with ISO timestamp, sample rates, channel labels, `audioBpm`
- **UI**: `⏺` button in `#eeg-controls` (visible only when EEG connected); active state is red with pulse animation; elapsed time `MM:SS` shown next to button
- **Download**: on stop, lines joined with `\n`, wrapped in `Blob` (`application/x-ndjson`), downloaded as `nouscope-{iso-ts}.jsonl` via anchor tag (streaming File System Access path returns null and writes to disk directly)

### Full-screen Bio Panel

- `⛶` button in `#eeg-controls` (visible only when EEG connected) toggles `body.fullscreen-bio` class
- CSS grids `#bio-panel` into a 2-column full-viewport layout
- Canvases CSS-scale to fill their grid cells (`image-rendering: pixelated` keeps spectrograms crisp; webgl-plot line traces scale smoothly)
- Escape key exits fullscreen; EEG disconnect also clears the mode

### BioDataDisplay — Live Data Panel

- Toggle button `◉` appears in `#eeg-controls` once EEG connects; opens `#bio-panel` above controls.
- Three `WebglLineRoll` plots (webgl-plot library): EEG 4-channel stacked, PPG single trace (auto-scaled), IMU accel+gyro 6 lines.
- **Spectrogram**: Two 2D `<canvas>` heatmaps with viridis colormap on log₁₀ power, auto-scaled. Full spectrogram (`#spec-canvas`, 280×86 px): bins 8–50 Hz. Low-frequency panel (`#spec-lo-canvas`, 280×76 px): 0.5–8.0 Hz at 0.1 Hz. Scrolling via `drawImage(canvas, -2, 0)`. Frequency axis labels alongside each canvas.
- **Audio tempogram**: `#spec-audio-canvas` (280×46 px): 0.5–5.0 Hz at 0.1 Hz, viridis colormap. Scrolling heatmap of spectral-flux novelty DFT power. Visible when audio is playing.
- **Entrainment meter**: horizontal bar (`#bio-entrain-bar`) with gradient fill showing entrainment percentage. Label in `#bio-entrain-value`.
- **EEG Bands** relative-power chart + **Complexity (MSE)** bar chart.
- Signal quality shown as colored dots (green/yellow/red) per EEG channel.
- Panel and toggle hidden when EEG is disconnected.

### Standing Rules

- **After any algorithm or signal-processing change, update `docs/algorithms.md`** to match the new implementation. Keep constants, stage descriptions, and pseudocode in sync with the code.

### Build Notes

- Vite config; `@` alias resolves to `src/`
- SCSS compiled by Vite's built-in Sass support
- `muse-js` is installed from `github:soundtrip-health/muse-js#muse3` (not npm registry)
- `three` is retained only for its Web Audio helpers (`AudioListener` / `AudioAnalyser`) in AudioManager — there is no 3D scene
- Web Bluetooth (EEG) requires Chrome or Edge; HTTPS required in production
