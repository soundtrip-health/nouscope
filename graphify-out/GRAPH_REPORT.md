# Graph Report - .  (2026-07-01)

## Corpus Check
- 29 files · ~182,711 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 378 nodes · 630 edges · 14 communities (13 shown, 1 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 61 edges (avg confidence: 0.87)
- Token cost: 0 input · 232,172 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Offline Analysis Pipeline (Python)|Offline Analysis Pipeline (Python)]]
- [[_COMMUNITY_Session1 Validation & Signal Theory|Session1 Validation & Signal Theory]]
- [[_COMMUNITY_App Shell & Jellyfin UI|App Shell & Jellyfin UI]]
- [[_COMMUNITY_Project Docs & Dependencies|Project Docs & Dependencies]]
- [[_COMMUNITY_Recorded vs Offline Validation|Recorded vs Offline Validation]]
- [[_COMMUNITY_App Core & Multiscale Entropy|App Core & Multiscale Entropy]]
- [[_COMMUNITY_Bio Panel Display & EEGManager|Bio Panel Display & EEGManager]]
- [[_COMMUNITY_Package Dependencies|Package Dependencies]]
- [[_COMMUNITY_EEG-Music Entrainment|EEG-Music Entrainment]]
- [[_COMMUNITY_Offline EEG Ingestion (Python)|Offline EEG Ingestion (Python)]]
- [[_COMMUNITY_EEG Pipeline Test Suite|EEG Pipeline Test Suite]]
- [[_COMMUNITY_Audio Manager & Docs|Audio Manager & Docs]]
- [[_COMMUNITY_Bio Data Display UI|Bio Data Display UI]]

## God Nodes (most connected - your core abstractions)
1. `EEGManager` - 53 edges
2. `App` - 34 edges
3. `RecordingManager` - 34 edges
4. `ReactiveParticles` - 20 edges
5. `BioDataDisplay` - 20 edges
6. `EntrainmentManager` - 18 edges
7. `AudioManager` - 17 edges
8. `JellyfinManager` - 16 edges
9. `JellyfinBrowser` - 15 edges
10. `analyse()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `MSPTDfast v2 PPG Peak Detection` --semantically_similar_to--> `BPMManager`  [INFERRED] [semantically similar]
  docs/algorithms.md → src/js/managers/BPMManager.js
- `Multiscale entropy comparison, offline vs recorded (mean across scales)` --shares_data_with--> `ComplexityManager`  [INFERRED]
  analysis/data/session1.analysis.png → src/js/managers/ComplexityManager.js
- `Band Power Recomputed Offline Panel (delta/theta/alpha/beta/gamma)` --conceptually_related_to--> `EEGManager`  [INFERRED]
  analysis/data/session2.analysis.png → src/js/managers/EEGManager.js
- `Band power recomputed offline (delta/theta/alpha/beta/gamma)` --shares_data_with--> `EEGManager`  [INFERRED]
  analysis/data/session3.analysis.png → src/js/managers/EEGManager.js
- `EEG signal quality panel (TP9/AF7/AF8/TP10, green/yellow/red)` --shares_data_with--> `EEGManager`  [INFERRED]
  analysis/data/session3.analysis.png → src/js/managers/EEGManager.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **EEG Biometric Processing & Recording Flow** — src_js_managers_eegmanager_eegmanager, src_js_managers_entrainmentmanager_entrainmentmanager, src_js_managers_complexitymanager_complexitymanager, src_js_managers_recordingmanager_recordingmanager [INFERRED 0.85]
- **Bio Data Display Panel (DOM + managers)** — index_html, src_js_ui_biodatadisplay_biodatadisplay, src_js_managers_eegmanager_eegmanager, src_js_managers_entrainmentmanager_entrainmentmanager, src_js_managers_complexitymanager_complexitymanager [INFERRED 0.85]
- **Jellyfin Auth, Browse & Stream-to-Audio Flow** — src_js_managers_jellyfinmanager_jellyfinmanager, src_js_ui_jellyfinbrowser_jellyfinbrowser, src_js_managers_audiomanager_audiomanager, src_js_app_app [INFERRED 0.85]
- **Six diagnostic subplots co-occurring in one session-validation figure** — analysis_data_session1_analysis_signalqualitytimeline, analysis_data_session1_analysis_bandpoweroffline, analysis_data_session1_analysis_recordedvsofflinebandpower, analysis_data_session1_analysis_multiscaleentropycomparison, analysis_data_session1_analysis_heartratecomparison, analysis_data_session1_analysis_eegtempogram [INFERRED 0.85]
- **Offline recomputation used to validate live RecordingManager/EEGManager/ComplexityManager/EntrainmentManager output** — analysis_utils_py_module, src_js_managers_recordingmanager_recordingmanager, src_js_managers_eegmanager_eegmanager, src_js_managers_complexitymanager_complexitymanager, src_js_managers_entrainmentmanager_entrainmentmanager, analysis_data_session1_analysis_sessionanalysischart [INFERRED 0.75]
- **Panels composing the session2 offline-vs-recorded analysis chart** — analysis_data_session2_analysis_chart, analysis_data_session2_analysis_signalqualitypanel, analysis_data_session2_analysis_bandpoweroffline, analysis_data_session2_analysis_recordedvsofflineband, analysis_data_session2_analysis_msecomparison, analysis_data_session2_analysis_heartratecomparison, analysis_data_session2_analysis_eegtempogram [INFERRED 0.90]
- **Session 3 offline-vs-recorded EEG pipeline validation** — analysis_data_session3_analysis_png_figure, analysis_data_session3_analysis_png_signalquality, analysis_data_session3_analysis_png_bandpoweroffline, analysis_data_session3_analysis_png_recordedvsofflinebandpower, analysis_data_session3_analysis_png_multiscaleentropy, analysis_data_session3_analysis_png_heartrate, analysis_data_session3_analysis_png_eegtempogram, src_js_managers_recordingmanager_recordingmanager, src_js_managers_eegmanager_eegmanager, src_js_managers_complexitymanager_complexitymanager, src_js_managers_entrainmentmanager_entrainmentmanager [INFERRED 0.75]
- **Bio-data panel jointly displays raw EEG, spectrograms, band powers, PPG, and IMU from a connected Muse headset** — screenshot_bio_panel, screenshot_eeg_traces, screenshot_spectrogram, screenshot_delta_theta_spectrogram, screenshot_eeg_bands_chart, screenshot_ppg_trace, screenshot_imu_traces [EXTRACTED 1.00]
- **Overall Nouscope app UI: bio-panel, particle visualizer, dat.GUI mapping controls, and bottom control bar together form the running application view** — screenshot_mainui, screenshot_bio_panel, screenshot_particle_visualizer, screenshot_gui_controls, screenshot_control_bar [EXTRACTED 1.00]

## Communities (14 total, 1 thin omitted)

### Community 0 - "Offline Analysis Pipeline (Python)"
Cohesion: 0.06
Nodes (55): _main(), plot_overview(), Path, Plotting helpers for offline Nouscope analysis outputs., analyse(), band_power_timeseries(), _build_delta_kernels(), _build_morlet_kernels() (+47 more)

### Community 1 - "Session1 Validation & Signal Theory"
Cohesion: 0.07
Nodes (17): Finding: AF7 channel shows poor signal quality for entire session, Band power recomputed offline (delta/theta/alpha/beta/gamma), EEG tempogram heatmap (log power, 0.5-5 Hz), Heart rate comparison, offline vs recorded (BPM), Multiscale entropy comparison, offline vs recorded (mean across scales), Session1 Analysis Chart (6-panel EEG/PPG diagnostic plot), EEG signal quality timeline (TP9, AF7, AF8, TP10 good/marginal/poor), Heart Rate (BPM) Comparison Panel (offline vs recorded) (+9 more)

### Community 2 - "App Shell & Jellyfin UI"
Cohesion: 0.08
Nodes (13): Bottom control bar (battery, Disconnect EEG, bpm readout, record, pause, Jellyfin, Track), dat.GUI control panel (PARTICLES, VISUALIZER, AUDIO, MAPPING, Close Controls), Nouscope Main UI Screenshot, 3D particle visualizer (purple point-cloud torus/funnel around black center), Active (recording) record button, green highlighted state, AUDIO_RANGE, BIO_RANGE, BIO_SOURCES (+5 more)

### Community 3 - "Project Docs & Dependencies"
Cohesion: 0.09
Nodes (17): Curl Noise Displacement Field, docs/algorithms.md (Algorithm & Signal Processing Guide), MSPTDfast v2 PPG Peak Detection, Three-Layer Temporal Smoothing (EMA + dual lerp), eeg-recorder analysis pipeline (analysis/utils.py, refs/eeg.py), Muse EEG headset (Muse 2 / Muse S), GSAP, muse-js (Web Bluetooth Muse SDK) (+9 more)

### Community 4 - "Recorded vs Offline Validation"
Cohesion: 0.11
Nodes (16): Finding: recorded band power diverges from offline recomputation mid-session (~400-1000s), Recorded vs offline band power comparison (alpha/beta/gamma), Band Power Recomputed Offline Panel (delta/theta/alpha/beta/gamma), session2.analysis.png — Offline vs Recorded EEG/PPG Analysis Chart, Recorded vs Offline Band Power Comparison Panel (alpha/beta/gamma), Band power recomputed offline (delta/theta/alpha/beta/gamma), EEG tempogram heatmap (log power, 0.5-5 Hz), session3.analysis.png (composite validation figure) (+8 more)

### Community 5 - "App Core & Multiscale Entropy"
Cohesion: 0.11
Nodes (11): Multiscale Entropy Comparison Panel (offline vs recorded), Multiscale Entropy (MSE) / Sample Entropy, Costa, Goldberger & Peng 2002 - Multiscale entropy analysis (Physical Review Letters), Richman & Moorman 2000 - Sample entropy (Am. J. Physiol.), App, _coarseGrain(), ComplexityManager, Q_WEIGHT (+3 more)

### Community 6 - "Bio Panel Display & EEGManager"
Cohesion: 0.09
Nodes (26): Bio Data Panel (left sidebar), Low-frequency Delta/Theta spectrogram heatmap (0.5-8 Hz), EEG Bands line chart (theta 0.20, alpha 0.28, beta 0.28, gamma 0.24), EEG 4-channel raw trace view with signal quality dots (all green), IMU accelerometer/gyroscope trace lines, PPG heart-rate waveform trace (74 bpm), Main EEG Spectrogram heatmap (8-50 Hz, viridis colormap), AP_FIT_BANDS (+18 more)

### Community 7 - "Package Dependencies"
Cohesion: 0.08
Nodes (24): author, contributors, dependencies, dat.gui, gsap, muse-js, three, web-audio-beat-detector (+16 more)

### Community 8 - "EEG-Music Entrainment"
Cohesion: 0.14
Nodes (12): EEG Tempogram Panel (log power, 0.5-5 Hz), EEG-Music Entrainment Index, Grosche & Müller 2011 - Predominant local pulse extraction (IEEE TASLP), Nozaradan, Peretz & Mouraux 2012 - Selective neuronal entrainment to the beat (J. Neurosci.), Stober, Prätzlich & Müller 2016 - Brain Beats (ISMIR), _buildHannDFTKernels(), _dftPower(), EEG_TEMPO_BUF (+4 more)

### Community 9 - "Offline EEG Ingestion (Python)"
Cohesion: 0.13
Nodes (20): clean_channels(), _coarse_grain(), entropy_to_complexity(), _iter_jsonl_lines(), load_eeg_from_jsonl(), multiscale_entropy(), DataFrame, ndarray (+12 more)

### Community 10 - "EEG Pipeline Test Suite"
Cohesion: 0.15
Nodes (15): AP_FIT_BANDS, AP_FIT_FREQS, apNormalize(), computeChannelBands(), ctz(), DFT_BINS, dftKernels, generateEEG() (+7 more)

### Community 11 - "Audio Manager & Docs"
Cohesion: 0.17
Nodes (4): CLAUDE.md (architecture guide), public/audio/README.txt, AudioManager, FREQ_BANDS

## Ambiguous Edges - Review These
- `session3.analysis.png (composite validation figure)` → `analysis/utils.py (offline analysis / validation script)`  [AMBIGUOUS]
  analysis/data/session3.analysis.png · relation: shares_data_with

## Knowledge Gaps
- **72 isolated node(s):** `name`, `version`, `description`, `author`, `license` (+67 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `session3.analysis.png (composite validation figure)` and `analysis/utils.py (offline analysis / validation script)`?**
  _Edge tagged AMBIGUOUS (relation: shares_data_with) - confidence is low._
- **Why does `EEGManager` connect `Session1 Validation & Signal Theory` to `App Shell & Jellyfin UI`, `Project Docs & Dependencies`, `Recorded vs Offline Validation`, `App Core & Multiscale Entropy`, `Bio Panel Display & EEGManager`, `Bio Data Display UI`?**
  _High betweenness centrality (0.157) - this node is a cross-community bridge._
- **Why does `App` connect `App Core & Multiscale Entropy` to `Session1 Validation & Signal Theory`, `App Shell & Jellyfin UI`, `Project Docs & Dependencies`, `Recorded vs Offline Validation`, `Bio Panel Display & EEGManager`, `EEG-Music Entrainment`, `Audio Manager & Docs`?**
  _High betweenness centrality (0.129) - this node is a cross-community bridge._
- **Why does `RecordingManager` connect `Recorded vs Offline Validation` to `Session1 Validation & Signal Theory`, `App Shell & Jellyfin UI`, `Project Docs & Dependencies`, `App Core & Multiscale Entropy`, `EEG-Music Entrainment`?**
  _High betweenness centrality (0.085) - this node is a cross-community bridge._
- **Are the 12 inferred relationships involving `EEGManager` (e.g. with `Band power recomputed offline (delta/theta/alpha/beta/gamma)` and `Heart rate comparison, offline vs recorded (BPM)`) actually correct?**
  _`EEGManager` has 12 INFERRED edges - model-reasoned connections that need verification._
- **Are the 9 inferred relationships involving `RecordingManager` (e.g. with `Finding: recorded band power diverges from offline recomputation mid-session (~400-1000s)` and `Recorded vs offline band power comparison (alpha/beta/gamma)`) actually correct?**
  _`RecordingManager` has 9 INFERRED edges - model-reasoned connections that need verification._
- **What connects `EEG ingestion and multiscale entropy.  Loads Muse-style EEG from a JSONL sensor`, `Yield decoded lines from a `.jsonl` file or from the first `.jsonl`     entry (o`, `Load EEG records from a JSONL sensor file.      Accepts either a `.jsonl` file o` to the rest of the system?**
  _108 weakly-connected nodes found - possible documentation gaps or missing edges._