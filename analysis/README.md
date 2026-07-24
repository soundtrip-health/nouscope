# Nouscope offline analysis tools

Python tools for offline analysis of Nouscope `.jsonl` recordings (the files
saved by the app's `⏺` record button, or `data/musetestsession.jsonl` /
`data/simulatedtestsession.jsonl` etc. in this folder). They recompute the same
signal-processing pipeline as the live app (see the root `docs/algorithms.md`
and `CLAUDE.md`), so recorded and recomputed values can be diffed against each
other, and add a phase-locking entrainment analysis that the live app doesn't
do at all.

## Setup

No project-level virtualenv or `requirements.txt` — each entrypoint declares
its own dependencies inline ([PEP 723](https://peps.python.org/pep-0723/)) and
is meant to be run with [`uv`](https://docs.astral.sh/uv/):

```bash
uv run nouscope_analysis.py [recording.jsonl]
uv run nouscope_entrainment.py [recording.jsonl] [--bpm N]
uv run test_entrainment.py
```

`uv` resolves and caches the dependencies (`numpy`, `scipy`, `pandas`,
`matplotlib`) on first run — no separate install step. Without a path
argument, the CLIs default to the first `*.jsonl` file in `data/`.

## Tools

### `nouscope_analysis.py` — general recording overview

Recomputes EEG/PPG gaps, signal quality, band power, multiscale entropy (MSE),
EEG tempogram, and heart rate from the raw streams in a recording, and
compares them against whatever the app itself recorded live. Prints a summary
(duration, missing-data %, gap lengths, window counts) and writes a 6-row
overview plot to `<recording>.analysis.png`.

```bash
uv run nouscope_analysis.py data/session1.jsonl
```

Core logic lives in `utils.py` (`analyse()`), rendering in `plotting.py`
(`plot_overview()`).

### `nouscope_entrainment.py` — phase-locking (PLV) entrainment analysis

A second, more rigorous entrainment analysis than the app's live power-based
tempogram. Slow-wave *power* rises under both drowsiness and genuine
entrainment, so power alone can't tell them apart — this measures **phase
locking value (PLV)** against a beat-frequency ladder derived from
`meta.audioBpm`, which only rises under real entrainment. It needs no
reference audio, and uses a pre-music quiet baseline (not a phase-scrambled
null) as the comparison floor. See `ENTRAINMENT_BUILD_PLAN.md` for the design
rationale.

```bash
uv run nouscope_entrainment.py data/session2.jsonl
uv run nouscope_entrainment.py data/session2.jsonl --bpm 122   # override the recorded tempo
```

Prints a summary (sample-clock check, PLV per beat-ladder harmonic, baseline
vs. music-window comparison) and writes a plot to `<recording>.entrainment.png`.

**Assumes a fixed session protocol**: a 120 s pre-music baseline followed by
music from t=120s to t=1320s (`MUSIC_START_S` / `MUSIC_END_S` in
`entrainment.py`) — recordings with a different timeline will mislabel the
baseline/music segments.

Core logic lives in `entrainment.py` (`analyse_entrainment()`,
`print_summary()`), rendering in `entrainment_plotting.py`.

### `test_entrainment.py` — synthetic controls for the PLV pipeline

Not a unit-test suite — three synthetic signal controls that validate the PLV
math itself is trustworthy: a known phase-lock is detected, the lock is
frequency-specific (a detuned reference sees nothing), and a small tempo
mismatch (122 vs 124 bpm) measurably degrades the lock. Run after touching
`entrainment.py`.

```bash
uv run test_entrainment.py
```

## Supporting modules

| File | Role |
|------|------|
| `utils.py` | JSONL loading (`load_jsonl`), packet-to-grid reconstruction, band power / MSE / tempogram / heart-rate recomputation — the shared pipeline behind `nouscope_analysis.py`. Mirrors `EEGManager.js`; constants are kept in sync with the JS implementation. |
| `plotting.py` | `plot_overview()` — the 6-row matplotlib figure for `nouscope_analysis.py`. |
| `entrainment.py` | Phase-locking (ITC/PLV) pipeline: sample-clock QC, narrowband analytic phase (Morlet), PLV vs. beat ladder, baseline floor, ringdown fit. Builds on `utils.py` for loading/gridding/quality-weighting. |
| `entrainment_plotting.py` | `plot_entrainment()` — rendering for `nouscope_entrainment.py`. |

`eeg.py` is a standalone, self-contained EEG/MSE module (`chaos.eeg_render`
package convention, relative `config` import) carried over from another
project. It is **not wired into any CLI here** and duplicates logic that
`utils.py` already covers for this pipeline — treat it as reference only, not
part of the active tool chain.

## `data/`

Sample recordings and pre-generated outputs used for development/testing:
`session1-3.jsonl` (+ their `.analysis.png` / `.entrainment.png` outputs),
`musetestsession.jsonl`, `simulatedtestsession.jsonl` (from `?sim` mode),
`cutofftest.jsonl`, and a dummy audio mix used in earlier testing.

## Design docs

- `ENTRAINMENT_ANALYSIS_PLAN.md` / `ENTRAINMENT_BUILD_PLAN.md` — design
  rationale for the phase-locking entrainment work.
- Root `docs/algorithms.md` — the canonical write-up of every signal-processing
  algorithm shared between the live app (JS) and this offline pipeline
  (Python); keep both in sync when either changes.
