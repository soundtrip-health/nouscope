# Entrainment Build Plan — `analysis/entrainment.py`

Engineering companion to `ENTRAINMENT_ANALYSIS_PLAN.md`. That doc is the *science*
(what to measure and why); this doc is the *build* (what code to write, in what order,
reusing what).

## Context

The existing entrainment machinery — realtime `EntrainmentManager.js` and offline
`utils.py:eeg_tempogram_timeseries` — is **power-based**: it compares the *magnitude*
of the audio and EEG tempograms. Power cannot separate genuine entrainment from
drowsiness (both raise slow-wave power). Only **phase consistency** can. No
phase-locking (ITC/PLV) code exists anywhere in the repo yet.

So we build a genuinely new offline pipeline that measures whether the brain's slow
oscillations hold a stable phase relative to the musical beat grid. It is built
**now against a nominal beat ladder** and re-run unchanged the moment the reference
audio (and exact tempo) arrives — only one constant changes.

Two clock problems can silently turn a real phase-lock into noise over a 20-min run,
because phase error *accumulates linearly*:
1. **Wrong stimulus tempo** — blocked on the audio; nominal ladder for now.
2. **Wrong EEG sample-clock** — the code *assumes* exactly 256 Hz from the packet
   index (`utils.py:112`) and never verifies it. A ~0.1% real error drifts the EEG
   timeline ~1.2 s over 20 min. **This we can and must QC now** (Phase 0), independent
   of the audio.

Everything else the pipeline needs already exists in `utils.py` (loading, gridding,
quality-weighting, NaN-gap handling, quadrature DFT/Morlet kernels).

---

## What we're building

A new module `analysis/entrainment.py` plus a plotting panel, built on `utils.py`.
N=3 → **per-subject case studies, never group averages** (especially the bistable meter).

### Reused from `utils.py` (do not reimplement)

| Need | Reuse |
|---|---|
| Parse session | `load_jsonl(path) -> Recording` (`utils.py:141`) |
| Dense (N,4) EEG on a regular grid | `packets_to_grid(rec.eeg_packets, EEG_FS, rec.duration_s, 4)` (`utils.py:221`) |
| Line-noise removal (NaN-safe, per segment) | `notch_eeg(eeg)` (`utils.py:692`) — mirror this filtfilt-per-segment pattern for narrowband |
| Per-channel quality labels | `signal_quality(eeg)` (`utils.py:316`) |
| Quality-weighted 1-ch average | `_quality_weights(labels)` (`utils.py:414`) + searchsorted-at-window-centre idiom (`utils.py:552-561`) |
| Short-gap fill / long-gap skip | `interpolate_short_gaps(sig, max_gap=13)` (`utils.py:294`) |
| Phase-bearing quadrature kernels | `_build_morlet_kernels` (`utils.py:352`) or `_build_tempo_kernels` (`utils.py:576`); alternatively scipy `butter`+`filtfilt`+`hilbert` (all installed) |
| Meta / nominal tempo | `rec.meta.audioBpm` (= 124 → fundamental 2.067 Hz) |

### New code (exists nowhere yet)

- Sample-clock QC.
- Narrowband analytic phase at a ladder frequency (NaN-safe).
- Phase-locking value (PLV/ITC) vs the beat grid + a surrogate null floor.
- The power-vs-PLV discriminator, ladder matrix, and ring-down fit.

---

## Build order

### Phase 0 — Sample-clock QC (gate, no audio needed)

`verify_sample_clock(rec) -> {effective_fs, drift_ppm, ok}`.

The timeline is defined *from* the packet count × 256 Hz, so it can't self-detect a
wrong rate. Cross-check the index-derived time against an independent reference:
the coarse device `timestamp` field (usable for a *long-baseline* rate estimate even
though it's float32-quantized per-packet — see `utils.py:80-87`), i.e. total elapsed
device-time / total samples. Report the implied effective rate and drift in ppm.

- If ≈ 256.0 (within a few hundred ppm): record the value, proceed with 256.
- If materially off: expose `effective_fs` so all downstream time uses the measured
  rate, not the nominal.
- **This runs first and its result is printed in every report.** It is cheap insurance,
  not a research task — a wrong answer here quietly kills the headline result with no
  error.

### Phase 1 — Phase-locking timeseries (the lead measure)

`phase_locking_timeseries(eeg, sq_df, ladder_freqs, fs, win_cycles=...) -> (times, freqs, plv[F,T], floor[F,T])`

Per ladder rung `f`:
1. Build the quality-weighted 1-ch signal (reuse pattern above), `interpolate_short_gaps`.
2. Narrowband analytic signal `z(t) = A(t)·e^{iφ(t)}` — high-cycle Morlet (reuse
   kernels) or `butter`+`filtfilt`+`hilbert`, applied **per contiguous non-NaN
   segment** like `notch_eeg`.
3. Reference beat-grid phase `ψ(t) = 2π f t` using the **Phase-0 effective_fs**.
4. Relative phase `Δ(t) = φ(t) − ψ(t)`; sliding window (length ∝ cycles of `f`):
   `PLV(t) = |mean_{valid τ∈W} e^{iΔ(τ)}|`. This is invariant to downbeat/epoch-boundary
   placement as long as the grid period = true stimulus period (`ANALYSIS_PLAN.md:137-139`)
   — which is exactly why the *tempo value* matters but the downbeat does not.
5. **Null floor = pre-music quiet baseline** (finding, updated from the analysis
   plan's surrogate suggestion). Implementation showed that for a *steady-state /
   frequency-tagging* design the surrogates the analysis plan named don't work:
   Fourier phase-scramble keeps a strong beat-frequency line locked (PLV floor
   ≈ 1.0 — it explains the entrainment away), and a global circular shift is a
   constant phase offset that PLV is invariant to. The valid null is the pre-music
   quiet segment: PLV there is finite-window bias + endogenous rhythm with no
   stimulus, so genuine entrainment is PLV *rising above that baseline* during
   music. Frequency-specificity (PLV peaks at the ladder, not neighbours) is the
   second axis, via the off-ladder scan. This is validated by `test_entrainment.py`.

Ladder built from a single swappable `FUNDAMENTAL_HZ` (nominal `rec.meta.audioBpm/60`):
rungs ×4, ×3, ×2, ×1, ×½, ×⅓, ×⅙ (`ANALYSIS_PLAN.md:75-83`). Use pulse-period windows
for fast rungs, phrase-period windows for the subharmonic trio.

### Phase 2 — The discriminator figure (money plot)

Segment each session into pre-music / music / post-music (nominal 0–2 / 2–22 / 22–end
min; boundaries assumed — recordings carry no onset marker). Plot **band power vs PLV**
side by side across the three windows: power rises in both quiet-drowsy and music, PLV
rises *only* under music. Reuse the `plotting.py:plot_overview` stacked-panel +
`imshow(origin='lower', extent=..., aspect='auto')` style.

### Phase 3 — Ladder matrix + persistence ring-down

- Ladder-PLV matrix over time (heatmap, rungs × time).
- Slide PLV across the music→quiet transition and fit the post-offset tail: exponential
  ring-down (report τ) vs step drop vs drift (`ANALYSIS_PLAN.md:92-98`).

### Later — needs audio or is Muse-marginal (P3–P6 in the analysis plan)

Bistable meter (0.667 vs 1.0 Hz, per-listener), multiscale stacking + co-occurrence
null, off-ladder ~5 Hz scan, envelope tracking (SRC), per-band LZC. Sequenced last.

---

## Integration

- Flat-import style like `plotting.py` (`from utils import ...`), run from inside
  `analysis/`. Add a CLI entry mirroring `nouscope_analysis.py:_main`, or extend it.
- New figure `analysis/data/session{n}.entrainment.png` per session.
- Deps present: numpy, scipy (`hilbert`/`butter`/`filtfilt`), matplotlib. No new deps.

## Verification

1. **Phase 0 sanity:** run `verify_sample_clock` on all 3 sessions; confirm effective_fs
   is sane (≈256) and print drift_ppm. This alone validates the timeline before any PLV.
2. **Surrogate calibration:** on pre-music quiet (no stimulus), PLV-above-floor should
   sit ≈0 — confirms the null floor isn't leaking bias into a "lock."
3. **Synthetic positive control:** inject a known phase-locked sinusoid at a ladder
   freq into a copy of the EEG; PLV must spike at that rung and nowhere else. Detune it
   by the 122-vs-124 gap to *see* the phase-slip degrade PLV — validates the whole
   tempo-sensitivity argument.
4. **End-to-end:** generate the three-window discriminator figure for each session;
   eyeball power-up-everywhere vs PLV-up-only-in-music.
5. Re-run unchanged with the real `FUNDAMENTAL_HZ` when the audio lands.

## Open dependencies (external — needed before trusting results)

- Reference audio file → exact tempo (~0.01 bpm) + drift check + downbeat.
- Confirmation the tempo is constant and its exact value (currently unresolved —
  external source says 122 bpm, recording metadata says 124).
- Any music on/off timestamps or a sync marker (helps Phase 2/3 timing).

## Standing rule

Per repo `CLAUDE.md`: after implementing, update `docs/algorithms.md` with the new
phase-locking stage, constants, and pseudocode, and run `graphify update .`.
