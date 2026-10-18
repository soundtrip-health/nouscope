# Nouscope architecture

Last reviewed 2026-10-18 against `e9af118` (origin/main).

## Purpose

Nouscope is a browser-only biometric visualizer for the Muse headband (Muse 2 / Muse S). It streams raw EEG, PPG and IMU data over Web Bluetooth and processes it in the page. It renders the result as scrubbable 2D panels or as an optional 3D helix. With optional music or microphone input it also computes a real-time EEG–music entrainment index. The public site is https://nouscope.org (Soundtrip Health).

There is **no backend**. The server only hands out the static build. All capture, processing and storage happen in the visitor's browser, and data leaves the browser only when the user downloads a `.jsonl` file.

Algorithm detail lives in [`algorithms.md`](algorithms.md) and UI tokens in [`design-system.md`](design-system.md). `CLAUDE.md` has a per-module reference. This document is the overview.

## Components

```
index.html            two views: #session-view (single session) and #multitrack-view
server.js             production static server for dist/ (no dependencies)
vite.config.js        build config (outDir dist/, base ./, no source maps)
src/js/
├── index.js          boot: new App(), new MultiTrackApp(), ShortcutsModal, view switch
├── App.js            single-session controller: managers, UI wiring, rAF update loop
├── MultiTrackApp.js  multi-recording review view (several .jsonl side by side, markers)
├── managers/         acquisition + signal processing + session state (no DOM rendering)
└── ui/               renderers and controls
analysis/             offline Python re-analysis of .jsonl recordings (not shipped)
test/                 eeg-pipeline-test.js (Node, pipeline sanity checks)
```

### Managers (`src/js/managers/`)

| Module | Role |
|---|---|
| `EEGManager.js` | Connects to the Muse through `muse-js` `MuseClient` (`connect()` at `EEGManager.js:298`). Subscribes to the EEG, PPG, accelerometer, gyro and telemetry observables. Computes band powers, spectrogram columns, PPG heart rate, head pose and signal quality, and keeps the rolling display buffers. |
| `SimulatedMuse.js` | Drop-in `MuseClient` replacement that emits synthetic packets. Enabled by the developer-only `?sim` / `?sim=auto` URL flag (`App.js:194`). |
| `AudioManager.js` | Optional novelty source for entrainment. It decodes a local audio `File` (played through three.js `Audio`) or takes muted microphone input from `getUserMedia` (`AudioManager.js:125`). Computes spectral flux. |
| `BPMManager.js` | Tempo of the loaded track (`web-audio-beat-detector`). Used only as recording metadata. |
| `EntrainmentManager.js` | Audio and EEG tempograms (0.5–5 Hz) and the entrainment index (0–1), about 2 Hz. |
| `ComplexityManager.js` | Multiscale entropy on the EEG, about 0.2 Hz. |
| `RecordingManager.js` | Always-on capture backlog while EEG is connected, capped at 64 MB (`RecordingManager.js:60`). `⏺` saves it to a JSONL file, streamed through the File System Access API when the browser has it (`RecordingManager.js:142`), otherwise built as an in-memory Blob download. `onRecord` fans each record out to `SessionStore`. |
| `SessionStore.js` | Seekable session timeline. Ingests JSONL records from live capture or a loaded file (`loadFromText`, `SessionStore.js:544`) and reconstructs per-stream grids. Recomputes spectrograms and answers windowed range queries, plus `headPoseAt`, `pulseAt` and `complexityAt` for any time `t`. |
| `PulseTracker.js` | Beat-locked cardiac phase from the stored PPG and accelerometer, used by the helix. |

### UI (`src/js/ui/`)

- `AnalysisDisplay.js`: the panel renderer. `renderAt(store, cursor)` draws the EEG, PPG, IMU, bands, MSE, spectrogram and entrainment panels with `webgl-plot` and 2D canvases.
- `Scrubber.js`: playhead, play/pause/speed, ● LIVE follow, quality ribbon and event ticks. It runs its own rAF loop and calls the renderers.
- `HelixView.js`: optional three.js 3D view of the same store and cursor. Its palette choice is the app's only `localStorage` use (`HelixView.js:404`, `:531`).
- Multi-track view: `TrackManager.js`, `Track.js`, `AudioTrack.js`, `MultiTrackDisplay.js`, `MultiTrackScrubber.js` and `timelineDecor.js`. Each loaded recording gets its own `SessionStore`.
- `InfoPanel.js`, `ShortcutsModal.js`, `bioRender.js`, `palette.js` and `formatTime.js`: landing card, help modal and shared render helpers.

## Data flow

```mermaid
flowchart LR
  subgraph Browser["Visitor's browser (all processing here)"]
    BT["Muse headset<br/>Web Bluetooth GATT"] --> MJ["muse-js MuseClient<br/>(rxjs observables)"]
    SIM["SimulatedMuse (?sim)"] -.-> EEG
    MJ --> EEG["EEGManager<br/>bands · spectrogram · HR · pose · quality"]
    AUD["Local audio file /<br/>microphone (getUserMedia)"] --> AM["AudioManager<br/>spectral flux"]
    AM --> ENT["EntrainmentManager"]
    EEG --> ENT
    EEG --> CPX["ComplexityManager (MSE)"]
    EEG & ENT & CPX & BPM["BPMManager"] -->|recordX()| REC["RecordingManager<br/>capture backlog ≤ 64 MB"]
    REC -->|onRecord| SS["SessionStore<br/>seekable timeline"]
    EEG -->|"_tapLiveColumns()"| SS
    FILE["↑ Recording (.jsonl)"] -->|loadFromText| SS
    SS --> AD["AnalysisDisplay panels"]
    SS --> HX["HelixView (three.js)"]
    SC["Scrubber cursor"] --> AD & HX
    REC -->|"⏺ stop"| DL["nouscope-*.jsonl<br/>download / File System Access"]
  end
  DL -.->|manual copy| PY["analysis/*.py<br/>(offline, analysis/data/ gitignored)"]
  SRV["server.js on 127.0.0.1:8080<br/>serves dist/ only"] -->|"HTML/JS/CSS via<br/>Cloudflare tunnel"| Browser
```

1. **Acquisition.** `EEGManager.connect()` creates a `MuseClient` (or `SimulatedMuse`), sets `enablePpg`, and connects. The browser shows its device chooser, and the user must pick the device. Samples arrive on rxjs observables.
2. **Processing.** `App.update()` runs every animation frame and steps `EEGManager`, `AudioManager`, `EntrainmentManager` and `ComplexityManager`. It then calls `_tapLiveColumns()` to copy the new spectrogram and tempogram columns into `SessionStore`.
3. **Capture.** Connecting EEG starts `RecordingManager` capture. Each record (`eeg`, `ppg`, `accel`, `gyro`, `bands`, `hr`, `music`, `entrain`, `mse`, plus the `meta` header) is serialized and pushed to `SessionStore.ingest`.
4. **Views.** `Scrubber` owns the playhead. `AnalysisDisplay` and `HelixView` render the store at that cursor, so live and replay use the same code path. The multi-track view repeats this with one store per loaded file.
5. **Export.** `⏺` writes the `meta` header, the backlog and the ongoing stream to a user-chosen file. The file's `t=0` is when capture began, not when `⏺` was pressed.
6. **Offline analysis.** `analysis/` (Python, run with `uv`) reloads the `.jsonl` files and recomputes the same features. `analysis/utils.py` mirrors `EEGManager.js`.

## Build and serve

- `npm run build` (`vite build`, `vite.config.js`) compiles SCSS, bundles `src/js/index.js` from `index.html`, and writes content-hashed assets to `dist/assets/`. Source maps are off (`vite.config.js:11`), and `base: './'` makes the output path-relative.
- `npm start` runs `node server.js`. It serves `dist/` on `127.0.0.1:8080` by default (`HOST`/`PORT` env vars, `server.js:22-23`). It allows only GET and HEAD, resolves request paths inside `dist/` only (`server.js:60`), and sets cache headers: `/assets/*` immutable for a year, everything else `no-cache` with an ETag.
- cloudflared forwards `nouscope.org` to `http://localhost:8080`. See [`deployment.md`](deployment.md).
- `npm run dev` (the Vite dev server) is for local development only. It binds to all interfaces (`host: true`, `vite.config.js:21`) and must never be tunnelled.

## Where data lives

| Data | Location | Lifetime |
|---|---|---|
| Live EEG/PPG/IMU, derived features | JS memory in the visitor's tab (`EEGManager` buffers, `RecordingManager._backlog`, `SessionStore`) | Until the tab is closed or reloaded |
| Saved recordings | `nouscope-<iso-ts>.jsonl` written to the user's disk (download or File System Access) | User-controlled |
| Loaded recordings | Read through `<input type=file>` into `SessionStore`, never uploaded | Tab lifetime |
| Audio / mic | Decoded in the Web Audio graph. Mic input is muted and only used for novelty. Neither audio nor its features are written to the JSONL except `music` BPM. | Tab lifetime |
| Preferences | `localStorage` helix palette name | Persistent, per browser |
| Research recordings | `analysis/data/` on developer machines, **gitignored** (`.gitignore`, last line) | Developer-controlled |
| Server | `dist/` static files only. No logs, database or cookies are written by `server.js`. | — |

## External dependencies

| Dependency | Use | Notes |
|---|---|---|
| `muse-js` | Muse BLE protocol | **Git fork** `github:soundtrip-health/muse-js#muse3` (`package.json:33`), pinned by the lockfile to commit `b98abbb923c76db23c33d7fc947a2ed1dddfda18` and fetched over `git+ssh` (`package-lock.json:1321`). |
| `rxjs` | muse-js observables | |
| `three` | Web Audio helpers in `AudioManager`, the 3D scene in `HelixView` | |
| `webgl-plot` | Line traces in the panels | |
| `web-audio-beat-detector` | Track BPM | |
| `vite`, `sass` | Build only (dev deps) | Not shipped |
| Adobe Typekit | Web font stylesheet `https://use.typekit.net/rsf5rhz.css` (`src/scss/includes/base.scss:2`) | **Runtime third-party request from every visitor's browser** |

The browser APIs it uses are Web Bluetooth (Chrome/Edge, secure context only), Web Audio, `getUserMedia` (mic, optional), the File System Access API (optional), WebGL and `localStorage`.

## Privacy and data classification

- **Class: health/biometric (EEG, heart rate, PPG, head motion), but client-side only.** It never reaches the server or any Soundtrip system. The app has no analytics, telemetry, `fetch` to our endpoints, cookies or accounts. The only `fetch` is `AudioManager.js:87`, used for a same-origin audio URL; the UI path passes a local `File`.
- Data leaves the browser only by an explicit user action (`⏺` then save). Exported `.jsonl` files are the user's own records. Once someone shares them with us for research, they are participant biometric data and belong in `analysis/data/` (gitignored) or another controlled store, never in git.
- Visitor metadata (IP, user agent) reaches Cloudflare and, through the Typekit stylesheet, Adobe. `server.js` itself logs nothing.
- The landing card promises "your data never leaves your machine" (`index.html:66-67`). Any change that adds network egress of session data breaks that promise and needs a privacy review.
