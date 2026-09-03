# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server (http://localhost:5173)
npm run build     # Production build (outputs to dist/)
npm run preview   # Preview production build
npm start         # Production static server for dist/ (server.js; PORT/HOST env, default 127.0.0.1:8080)
```

No test suite is configured.

## Architecture

**Nouscope** — a Muse EEG/PPG/IMU biometric visualizer. The bio-data panel (webgl-plot line traces + 2D canvas heatmaps) is the primary visualization. An optional artistic `◉ Helix` view (`src/js/ui/HelixView.js`, three.js) renders the same session as a 3D braided helix in place of the panel grid — the one 3D scene in the app. Audio playback is optional and its only purpose is to drive the EEG–music entrainment analysis.

**One data view.** There is no live-vs-analysis split. Connecting a headset starts an always-on capture into `SessionStore`; `AnalysisDisplay` renders that store at the `Scrubber`'s playhead. Parked at the leading edge (● LIVE) the panels behave as a live monitor; dragged back, they replay the session. A loaded `.jsonl` fills the same store and drives the same panels.

### Entry Point & Boot Sequence

`src/js/index.js` instantiates `App`. The `App` constructor immediately:
1. Wires the `↑ Music` file-upload input (first upload starts audio; later uploads swap the track)
2. `_setupEEG()` — instantiates `EEGManager` and `ComplexityManager`, wires connect/disconnect (and reads the `?sim` developer flag)
3. `_setupRecording()` — instantiates `RecordingManager`, wires the `⏺` record button
4. `_setupAnalysis()` — instantiates `SessionStore`, `AnalysisDisplay`, `Scrubber`; wires the `↑ Recording` file input
5. Instantiates `InfoPanel` — the landing/about content, open by default until a session starts
6. Starts the `update()` loop immediately (requestAnimationFrame) so EEG/bio plots run before — or entirely without — audio

Audio is optional and drives only the entrainment analysis. There are two mutually-exclusive sources, both lazily creating `AudioManager` + `EntrainmentManager` via `_ensureAudioInfra()`:

- **`↑ Music` (file)** → `_loadAudioFile(file)`: `AudioManager.loadAudioBuffer(file)` → `BPMManager.detectBPM()` (exposes `bpmValue` for recording metadata) → `AudioManager.play()`; the `⏸` pause button appears.
- **`Microphone` (live mic)** → `_toggleMic()`: `AudioManager.startMic()` captures muted microphone input as the novelty source (no playback, no BPM). Starting one source stops the other; the pause button is hidden in mic mode.

On a fresh page the `InfoPanel` landing card (project description, usage, Helix blurb, Soundtrip Labs credit + links) sits over the otherwise-empty viewport; its wrapper is pointer-transparent so the controls bar stays clickable beneath it. `App._showPanel` closes it when a session comes up; the top-right `i` toggle reopens it as a semi-transparent overlay on the data/helix view, and `App._hidePanel` reopens it when the page empties again. There is no demo track. EEG can connect before, after, or without any audio.

### Key Modules

| File | Responsibility |
|------|----------------|
| `src/js/App.js` | Manager coordination, UI wiring, update loop (no renderer/scene) |
| `src/js/managers/AudioManager.js` | Novelty source for entrainment — either a decoded local file (looped via THREE.Audio) or live muted microphone input (`getUserMedia` → AnalyserNode); shared spectral-flux novelty ring buffer. `source` = `'buffer'`\|`'mic'` |
| `src/js/managers/BPMManager.js` | Tempo detection via `web-audio-beat-detector`; exposes `bpmValue` (recording metadata). No beat events. |
| `src/js/managers/EntrainmentManager.js` | Real-time EEG–music entrainment: parallel audio/EEG tempograms (0.5–5 Hz), z-score selective enhancement comparison, entrainment index (0–1) |
| `src/js/managers/ComplexityManager.js` | Multiscale entropy (MSE) on quality-weighted 4-channel EEG average; SampEn at 6 scales, updated ~0.2 Hz; exposes `mseCurve` + `complexity` scalar |
| `src/js/managers/RecordingManager.js` | In-memory JSONL recorder: raw EEG/PPG/IMU + bands/HR/entrainment/MSE. Start/stop toggle; downloads timestamped `nouscope-*.jsonl` file. `onRecord` sink fans every record to `SessionStore` too. |
| `src/js/managers/EEGManager.js` | Muse BT connection (Web Bluetooth), EEG band powers, PPG heart rate, IMU head pose; exposes raw display buffers + sample counters |
| `src/js/managers/SessionStore.js` | Stored, seekable session timeline for the Analysis tab. Ingests the JSONL record types (from live capture or a loaded file), reconstructs raw streams on a per-stream grid (JS port of `analysis/utils.py`), recomputes spectrograms from EEG; answers windowed range queries. Also re-derives, at an arbitrary past time `t` (for `HelixView`, scrub-correctly): `headPoseAt(t)`, `pulseAt(t)` (via `PulseTracker`), `complexityAt(t)` — the live `EEGManager.headPose`/`heartPulse` fields are not stored, so history must be recomputed from the stored `accel`/`ppg` streams instead. |
| `src/js/managers/PulseTracker.js` | Beat-locked cardiac phase from the stored PPG + accelerometer (owned by `SessionStore`, `pulseAt(t) → { phase, hz, w }`). A training-free linear take on PCHS (arXiv:2606.30156): per 8 s window, a 3-harmonic cardiac model is fitted jointly with lagged accelerometer regressors by weighted least squares, f₀ grid-searched in 0.5–3 Hz, systolic phase read at the window end, reliability `w` from the cardiac/residual/motion power split; a confidence-weighted soft lock across 1 s slots and a C¹ Hermite spline between them. Lazily cached per slot, scrub-correct. See `docs/algorithms.md` §4b. |
| `src/js/managers/SimulatedMuse.js` | Drop-in `MuseClient` replacement emitting synthetic EEG/PPG/IMU/telemetry packets in native muse-js shape, so the whole pipeline runs with no hardware. Developer-only, no UI: `?sim` makes `Connect EEG` use it; `?sim=auto` connects on load |
| `src/js/ui/AnalysisDisplay.js` | The only renderer: `renderAt(store, cursor)` redraws every panel from a `SessionStore`, each over its own fixed window ending at `cursor` (min/max-decimated line plots, time-mapped spectrogram blits); readouts show the instant value at `cursor` plus the average over that panel's window |
| `src/js/ui/Scrubber.js` | Transport: playhead cursor, play/pause at speed×realtime, ● LIVE follow, keyboard shortcuts; per-channel quality ribbon + BPM-change/gap event ticks under the track; hover-time preview pill |
| `src/js/ui/bioRender.js` | Shared render constants + primitives (viridis LUT, EEG/IMU scales, `PANEL_WINDOWS`, color tokens, `paintSpecColumn`) |
| `src/js/ui/InfoPanel.js` | Landing/about card (`#info-overlay` + top-right `i` toggle): open on load, auto-closed by `App._showPanel`, reopenable mid-session as a translucent overlay; pointer-transparent wrapper keeps controls/scrubber usable under it |
| `src/js/ui/HelixView.js` | Optional 3D view (three.js): last 60 s of raw EEG as 4 braided ribbon strands along a helix, driven from `SessionStore` at the scrubber cursor; faces the viewer by default (newest data as a front-facing circle), head tilt swings to the side view, sharp head turns/nods send it spinning — and both always settle back to face-on (slow-adapting pose baseline + post-spin return spring); recency emphasized (age fade/taper, head glow, perspective shrink of old coils); complexity sets spiral tightness and the swirl shape of a domain-warped cloud backdrop (calm → laminar bands, complex → tight eddies; eased, rendered at reduced resolution to a render target); the beat-locked pulse from `SessionStore.pulseAt` drives a traveling strand pulse and a breathing of clouds + palette-tinted particle field (reliability-gated, with a jump absorber for the live edge); swaps with the panel grid via `◉ Helix`; themed 4-color strand palettes (cycled by the palette button, persisted in localStorage) |

### Update Loop

Each frame in `App.update()`:
1. `EEGManager.update(performance.now())` — advances the heart-rate phase oscillator, processes buffered samples
2. `AudioManager.update()` — refreshes FFT analyser data + samples spectral-flux novelty (no-op when not playing)
3. `EntrainmentManager.update(now)` — rate-limited to ~2 Hz; computes audio/EEG tempograms and entrainment index
4. `ComplexityManager.update(now)` — rate-limited to ~0.2 Hz; computes 6-scale MSE on the EEG long buffer
5. `_tapLiveColumns()` — copies new spectrogram/tempogram columns from the managers into `SessionStore` (the JSONL stream carries no columns)

Panel drawing is **not** in this loop: `Scrubber` runs its own rAF loop and calls `AnalysisDisplay.renderAt(store, cursor)` (and `HelixView.renderAt(store, cursor)`, which only caches the store/cursor — `HelixView` owns its own rAF for continuous animation since the Scrubber's loop skips idle frames, which would freeze the helix's pose easing and idle spin while paused).

### EEGManager — Signal Processing

- **EEG bands** (see `docs/algorithms.md` §3): rolling 256-sample buffers per channel; delta (1–4 Hz) via sparse Hann-weighted DFT bins 1–3; theta–gamma via Morlet wavelet mean power; quality-weighted channel aggregation with optional drops; aperiodic (1/f) background normalization; relative `bandPower { delta, theta, alpha, beta, gamma }`. `normalizeBands` (a fixed `Set`, default `theta/alpha/beta/gamma`) selects which bands participate in the normalization sum; delta is excluded by default so its movement-prone power cannot swamp the higher bands. Temporal smoothing: source EMA (`BAND_SMOOTH=0.35`), plus a display-side one-pole filter across pixels in `AnalysisDisplay._renderBands` (`BAND_SMOOTH_TAU=0.21 s`).
- **Spectrogram** (display only): separate Hann-DFT pipelines — main panel: bins 1–50 Hz at 1 Hz from the 256-sample window; low-frequency panel: 0.5–8.0 Hz at 0.1 Hz from a 2560-sample (10 s) buffer. Quality-weighted channel average; log₁₀(power) columns in rolling buffers (`spectrumSampleCount`, `spectrumLoSampleCount`). Columns are tapped into `SessionStore` each frame by `App._tapLiveColumns`; robust auto-scaling (percentile + cap) lives in `bioRender.specColumnsScale`.
- **PPG / heart rate**: IIR bandpass (HP 0.5 Hz → LP 3.5 Hz), MSPTDfast v2 batch detector (6 s window, re-run every 1 s). Median IBI → `heartRate` BPM. Phase oscillator → `heartPulse` (0–1, cubed-sine shape). **Known limitation**: the first-order bandpass barely discriminates inside its passband, so an ~0.8 Hz motion artifact above ~2× pulse amplitude captures the estimate and HR collapses toward the artifact rate — see `docs/algorithms.md` §4. The helix's pulse does not use this: `PulseTracker` (§4b) fits the stored PPG with accelerometer conditioning and stays on the true rate through such artifacts.
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

- **Pattern**: push-based. EEGManager/EntrainmentManager/ComplexityManager/BPMManager call `App.recordingManager?.recordX(...)` at data-production sites; with neither `isRecording` nor `captureActive`, the calls are cheap no-ops
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
- **Capture vs. record**: capture starts on EEG connect (`enableCapture()` stamps the session epoch and retains every serialized record in `_backlog`). `⏺` starts *saving*: `start()` writes the `meta` header, then the whole backlog, then keeps streaming — so **`t=0` in a saved file is when capture began, not when the button was pressed**. Bounded by `BACKLOG_MAX_BYTES` (64 MB ≈ 35 min); past that the oldest lines are dropped and a warning is logged.
- **UI**: `⏺` button in `#eeg-controls` (visible only when EEG connected); active state is red with pulse animation; `MM:SS` next to it is the length of the data in the file (since the capture epoch), so it jumps to the buffered duration on press
- **Download**: on stop, lines joined with `\n`, wrapped in `Blob` (`application/x-ndjson`), downloaded as `nouscope-{iso-ts}.jsonl` via anchor tag (streaming File System Access path returns null and writes to disk directly)

### The Data Panel — Scrubbable, Always

One panel (`#analysis-panel`, `an-`-prefixed IDs), rendered by `AnalysisDisplay.renderAt(store, cursor)` from a `SessionStore`. See `docs/algorithms.md §9`.

- **Shown** whenever there's a session: EEG connect brings it up following the live edge; `↑ Recording` loads a `.jsonl` and opens at its start. `body.analysis-mode` grids it into a 2-column full-viewport layout above the scrubber. Disconnect leaves it up (still scrubbable) and stops following.
- **Two data sources, one store**: while EEG is connected an always-on capture (`RecordingManager.captureActive` → `onRecord` → `SessionStore.ingest`) feeds the timeline — no explicit recording needed. Live spectrogram/tempogram columns are tapped from the managers each frame (`App._tapLiveColumns`); for loaded files spectrograms are recomputed from EEG (audio tempogram can't be — no audio stored).
- **Per-panel time windows** (`PANEL_WINDOWS` in `bioRender.js`), each ending at the playhead: EEG 2 s, PPG 6 s, IMU 4 s, bands 5 s, MSE 30 s, all three spectrograms 70 s, helix 60 s. These reproduce the spans the old live scrolling panel had. A single shared window across all panels is wrong in both directions — do not reintroduce one.
- **Plots**: `WebglLineRoll` for EEG (4ch stacked), PPG (detrended + robust-peak scaled), IMU (accel+gyro, 6 lines), bands (5 lines), MSE (5 lines). Three 2D `<canvas>` viridis heatmaps: `#an-spec-canvas` (8–50 Hz), `#an-spec-lo-canvas` (0.5–8 Hz @ 0.1 Hz), `#an-spec-audio-canvas` (0.5–5 Hz tempogram). Entrainment meter bar; per-channel quality dots. Readouts show the value at the playhead plus the average over that panel's own window.
- **Scrubber** (`#scrubber`, fixed bottom bar): play/pause, click/drag timeline, ● LIVE (follow the growing edge), speed (1×/2×/4×). Keyboard: Space, ←/→, Home/End. It owns only the playhead — window widths belong to the renderer. The timeline (`#scrub-timeline`) also carries a per-channel signal-quality ribbon and event ticks (music BPM changes, recording gaps).
- **Helix mode**: the `◉ Helix` button swaps the panel grid for `HelixView`'s full-viewport 3D helix in place, sharing the same store/scrubber/cursor — only the renderer changes. Whichever of the two is hidden has its WebGL contexts suspended (cloneNode-replace, since a lost context can't revive on the same canvas) to stay within the browser's context budget. `HelixView` runs its own rAF loop rather than the Scrubber's, since that loop skips idle frames.

### Data Simulator

`SimulatedMuse` (`src/js/managers/SimulatedMuse.js`) stands in for `MuseClient`, emitting synthetic packets on the same rxjs observables in the same native shape, so the whole pipeline runs with no hardware. It is a **developer option with no UI**: `?sim` in the URL makes `Connect EEG` stream synthetic data instead of talking to Web Bluetooth; `?sim=auto` connects on page load (handy for screenshots and automated checks). Signals include a 10 Hz alpha rhythm with a slow envelope, a 2 Hz beat-locked component for the entrainment meter, blink artifacts on AF7/AF8, and a realistic raw-infrared PPG waveform. See `docs/algorithms.md §10`.

### Standing Rules

- **After any algorithm or signal-processing change, update `docs/algorithms.md`** to match the new implementation. Keep constants, stage descriptions, and pseudocode in sync with the code.

### Build Notes

- Vite config; `@` alias resolves to `src/`
- SCSS compiled by Vite's built-in Sass support
- `muse-js` is installed from `github:soundtrip-health/muse-js#muse3` (not npm registry)
- `three` provides Web Audio helpers (`AudioListener` / `AudioAnalyser`) in `AudioManager`, and the `WebGLRenderer`/`Scene`/`ShaderMaterial` scene in `HelixView` — the app's one 3D scene, optional and separate from the bio-data panel
- Web Bluetooth (EEG) requires Chrome or Edge; HTTPS required in production
