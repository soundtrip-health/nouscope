# Entrainment Analysis Plan

Working plan for building new tools to measure EEG–music entrainment, derived from
Matthew Bennett's *Entrain Orientation Memo* and a review of the current codebase
(`analysis/utils.py`, `analysis/eeg.py`, `src/js/managers/EntrainmentManager.js`).

Data on hand: 3 sessions (`analysis/data/session{1,2,3}.jsonl`), ~27 min each,
Muse II (TP9/AF7/AF8/TP10). Session structure per memo: 0–2 min quiet, 2–22 min
music, 22–end quiet. `meta.audioBpm = 124` (memo text says 122 — see tempo note below).

---

## The core reframing (most important point)

The memo's central methodological claim is **phase-locking, not power, is the
discriminator** between genuine entrainment and drowsiness (both raise slow-wave
power; only entrainment raises phase-consistency).

The entrainment machinery we already have — `EntrainmentManager` and the offline
`eeg_tempogram_timeseries()` — is **entirely power-based** (it compares audio vs EEG
tempogram *magnitude*). It therefore **cannot** make the entrainment-vs-drowsiness
separation the memo leads with.

**So the "new tool" is a genuinely new pipeline built on instantaneous phase:
ITC / PLV at the frequency ladder.** Nothing in the current offline code does this
yet. Persistence, the bistable meter, and multiscale stacking are all *views* on
that same phase pipeline. The existing tempogram becomes a supporting power view,
not the headline measure.

---

## Two preconditions that will silently wreck ITC if skipped

### 1. Exact tempo — not optional

The memo says 122 bpm; the recorded `audioBpm` is **124**; the true value is whatever
the audio actually is. ITC needs the true stimulus period because phase error
accumulates: **124 vs 122 bpm drifts a full cycle in ~30 s**, turning real locking
into noise over a 20-minute run. "Call it 2 Hz for convenience" is fine for intuition
but fatal as an analysis constant.

**Action:** obtain the reference audio file to (a) measure exact tempo to ~0.01 bpm,
(b) check for drift/rubato across the 20 min, (c) get a downbeat for phase
interpretation and for SRC later. Build the ladder on the *measured* fundamental
(e.g. 2.0667 Hz → 0.344, 0.689, 1.033, 2.067, 4.133 Hz), **not** on 2.0.

### 2. Sample-clock accuracy

`utils.py` reconstructs time by assuming exactly 256 Hz from the packet `index`. A
true rate even 0.1% off produces the same slow phase-slip as a tempo error. Verify
the effective sample rate (cross-check `index`-derived time against the coarse device
`timestamp`, or align a known event to the reference audio) **before** trusting any
ITC number. Explicit QC pass.

### Also note

Recordings store **no audio envelope and no music-onset marker** (only the realtime
power-based `entrain` stream). ITC *magnitude* survives this — it needs only the
correct grid period, not the true downbeat — but envelope tracking (SRC) and clean
onset/persistence timing do need sync. So: get the audio; if possible mark
music-on/off.

---

## The analysis, in priority order

### P1 — Phase-locking at the ladder (lead measure)

Narrowband-filter (or high-cycle Morlet) the quality-weighted EEG at each ladder
rung, take the Hilbert analytic phase, compute **ITC = |⟨e^{iφ}⟩|** across epochs.
Run three ways per subject: pre-music quiet / music / post-music quiet.

Ladder (rebuild on measured fundamental once audio arrives):

| Freq (×beat) | Musical meaning | Muse reliability |
|---|---|---|
| 8.0 Hz (4×) | 16th-note subdivision | usable; alpha overlap |
| 6.0 Hz (3×) | triplet subdivision | tricky |
| 4.0 Hz (2×) | 8th-note subdivision | usable |
| 2.0 Hz (1×) | the beat | best |
| 1.0 Hz (1/2) | "in 2" duple grouping | good |
| 0.667 Hz (1/3) | "in 3" triple grouping | good |
| 0.333 Hz (1/6) | 6-beat phrase | good (watch drift) |

Two non-negotiables:
- **ITC bias floor.** ITC is upward-biased with finite epochs. Establish the null
  with circular-shift / phase-scramble surrogates; report ITC *above* that floor.
- **Power vs ITC side by side.** The money plot: delta/theta power rises in both
  quiet-drowsy and music, while ITC rises *only* under music. This single figure is
  the entrainment-vs-drowsiness discriminator the memo wants to lead with.

### P2 — Persistence / ring-down

Slide the ITC (and ladder power) estimate across the music→quiet transition and fit
the post-offset tail. The scientific question is **shape**: exponential ring-down
(resonance — report τ) vs step drop vs slow drift. Directly tests the headline
observation about subjects 2 and 3. Log the listener's subjective "still hearing it"
timestamp alongside.

### P3 — Bistable meter (0.667 vs 1.0 Hz)

Time-resolved ITC/power at both rungs, **per listener, never averaged** (averaging
smears two alternating signals into mush). Look for anti-correlated switching and
dwell times. Competition index = (P₁.₀ − P₀.₆₇)/(P₁.₀ + P₀.₆₇) over time. Deliverable
is a per-subject time series, not a single number.

### P4 — Multiscale stacking

Test whether locking co-occurs across *multiple* ladder rungs simultaneously more than
chance predicts — the "several timescales at once" observation and the core of the
resonance conjecture. ITC-across-the-ladder matrix over time + a co-occurrence/null
test.

### P5 — Off-ladder ~5 Hz scan

Compute ITC on a *fine* frequency grid (not just ladder rungs); flag any peak near
5 Hz that doesn't divide the fundamental (Wollman et al. 2020 endogenous-theta locus).
Cheap to add once P1 exists.

### P6 — Envelope tracking (SRC) + per-band complexity (LZC) — later, provisional

Both need the audio (SRC) and lean on the gamma range (per-band LZC scaffolding test)
where the Muse is least trustworthy. Memo sequences these last; agreed. SRC (Kaneshiro
et al. 2020) is a continuous-stimulus complement to ITC. Per-band LZC paired with the
slow-phase measure is what actually tests scaffolding vs suppression of high-frequency
content.

---

## Answers to the memo's two questions

**(1) Does the low-band-first plan make sense?** Yes, with the reframing: the first
deliverable is a phase-locking (ITC/PLV) pipeline on delta/theta that *replaces* the
power-based entrainment index as the primary measure. The tempogram becomes a
supporting power view.

**(2) Which periodicity defines the epoch?** Use the memo's **hierarchy**. Key fact:
ITC *magnitude* is invariant to epoch-boundary placement as long as the grid period =
the true stimulus period — so you don't need the downbeat, just the exact tempo.
Therefore:
- **Pulse-period epochs** (one beat) for fast locking at 2× and 4× the beat.
- **Phrase-period epochs** (the 6-beat, ~3 s phrase) for the subharmonic trio
  (0.333 / 0.667 / 1.0 ×).

Define each measure's epoch by the periodicity it tests; don't force one epoch length
on the whole ladder.

---

## Build order & what's needed

**First module:** `analysis/entrainment.py` —
`phase_locking_timeseries(eeg, ladder_freqs, epoch_period)` → ITC + surrogate floor
per rung over time, reusing the existing quality-weighting and NaN-gap handling in
`utils.py`. Then a plotting panel: power-vs-ITC across the three periods, the
ladder-ITC matrix, and the offset ring-down fit.

**N=3 → per-subject case studies, not group stats.** Design all outputs that way; do
not collapse across subjects (especially the bistable meter).

**Needed from Matthew:**
- (a) the reference audio file
- (b) confirmation of exact tempo and whether it's constant
- (c) any music on/off timestamps or a sync marker

The pipeline can be built now against the *nominal* ladder and re-run the moment the
exact tempo lands — the code is identical either way.

---

## References (from memo)

- Large — *Musical Neurodynamics* (mode-locking / neurodynamics framework)
- Berger & Turow — *Rhythmic Brain*, Ch. 5 (ITC to periodic drum stimuli, delta/theta)
- Kaneshiro et al. 2020, NeuroImage (SRC/ISC, natural music, no epoching)
- Wollman et al. 2020 (~5 Hz endogenous-theta entrainment enhancement)
- Nozaradan et al. 2012; Stober et al. 2016 "Brain Beats" (tempogram lineage)
- Costa, Goldberger & Peng 2002; Richman & Moorman 2000 (MSE / SampEn)
- Carhart-Harris (neural entropy / altered states — complexity motivation)
