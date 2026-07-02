"""Phase-locking (ITC/PLV) entrainment pipeline for Nouscope recordings.

This is the *phase*-based counterpart to the power-based tempogram in
``utils.py``. Slow-wave *power* rises under both drowsiness and genuine
entrainment, so power cannot tell them apart — but **phase consistency** (does
the brain hold a stable timing offset to the beat?) rises only under real
entrainment. This module measures that.

Built on ``utils.py`` (loading, gridding, quality-weighting, gap handling). The
only genuinely new machinery is: sample-clock QC, narrowband analytic phase,
the phase-locking value (PLV) vs the beat grid, and a pre-music baseline floor.
See ``ENTRAINMENT_BUILD_PLAN.md`` for the design and ``docs/algorithms.md`` for
the reference write-up once wired in.

Null model note: for a steady-state / frequency-tagging design the right null is
NOT a Fourier phase-scramble (which keeps a strong beat-frequency line locked and
so explains the entrainment away) nor a global circular shift (PLV is invariant
to a constant phase offset). It is the **pre-music quiet baseline** — PLV measured
with no stimulus captures the finite-window bias plus any endogenous rhythm, and
genuine entrainment is PLV *rising above that baseline* during music. Frequency
specificity is the second axis: the off-ladder scan shows PLV peaking at the beat
ladder and not at neighbouring frequencies.

Nothing here needs the reference audio: it runs against the *nominal* beat ladder
derived from ``meta.audioBpm`` and re-runs unchanged when the exact tempo lands —
only ``fundamental_hz`` changes.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.signal import fftconvolve
from scipy.optimize import curve_fit

from utils import (
    EEG_FS,
    CH_NAMES,
    load_jsonl,
    packets_to_grid,
    notch_eeg,
    signal_quality,
    _quality_weights,
    interpolate_short_gaps,
)

# --- Beat ladder ------------------------------------------------------------
# Multiples of the beat (the "fundamental"). >1 = subdivisions of the beat,
# <1 = groupings/phrases (musical names for reference).
LADDER = [
    (4.0, "16th (4x)"),
    (3.0, "triplet (3x)"),
    (2.0, "8th (2x)"),
    (1.0, "beat (1x)"),
    (1 / 2, "in-2 (1/2)"),
    (1 / 3, "in-3 (1/3)"),
    (1 / 6, "phrase (1/6)"),
]

# Nominal session structure: 0–2 min quiet, 2–22 min music, 22–end quiet.
# These are ASSUMED boundaries — recordings carry no music on/off marker.
MUSIC_START_S = 120.0
MUSIC_END_S = 1320.0

N_CYCLES_FILTER = 6      # Morlet wavelet width (freq resolution vs time resolution)
PLV_WIN_CYCLES = 8       # sliding PLV window length, in cycles of the rung
PLV_WIN_MIN_S = 6.0
PLV_WIN_MAX_S = 30.0
EVAL_HOP_S = 2.0         # common time grid for all rungs
GAP_MAX = 13             # ≤50 ms gaps interpolated (matches utils tempogram/MSE)
MIN_VALID_FRAC = 0.5     # a PLV window needs this fraction of valid samples
BASELINE_FALLBACK = 0.15 # floor used if the pre-music baseline is unusable


# ---------------------------------------------------------------------------
# Phase 0 — sample-clock QC
# ---------------------------------------------------------------------------
def verify_sample_clock(rec) -> dict:
    """Estimate the *true* effective EEG sample rate instead of trusting the
    nominal 256 Hz that ``utils.py`` assumes when it reconstructs time from the
    packet index.

    Why it matters: phase error accumulates linearly, so a wrong sample rate
    slowly slides the EEG timeline out of alignment with the beat grid and
    smears a real phase-lock into noise over a 20-min run — the same failure a
    wrong tempo causes.

    Method: the raw EEG time base is ``index * 12 / 256`` (packet-counter based,
    exact count but *assumed* rate). The device ``timestamp`` field is unusable
    (float32-mangled — see ``utils._unwrap_counter``), so we cross-check against
    the derived streams (``bands``/``hr``/``mse``/``entrain``), whose ``t`` comes
    from the browser ``performance.now()`` real-time clock. If the EEG index
    spans N samples while the real clock spans T seconds, the effective rate is
    N / T.

    Precision caveat: the EEG stream's start/stop can be offset from the
    performance.now t=0 by up to a second or two, giving this estimate a
    ~±150 ppm uncertainty. It reliably catches gross errors and yields a good
    correction, but sub-100 ppm calibration needs alignment to the reference
    audio. Returns nominal 256 (with ``ok=False``) if the derived streams are
    missing.
    """
    if not rec.eeg_packets:
        return {"effective_fs": float(EEG_FS), "drift_ppm": 0.0, "ok": False,
                "note": "no EEG packets", "eeg_dur_idx_s": 0.0, "real_dur_s": 0.0}

    # EEG duration implied by the (exact) packet counter at nominal 256 Hz.
    last_t, last_block = rec.eeg_packets[-1]
    eeg_dur_idx = last_t + last_block.shape[0] / EEG_FS
    n_eeg_samples = eeg_dur_idx * EEG_FS

    # Real elapsed time from the performance.now()-based derived streams.
    real_dur = 0.0
    for df in (rec.bands, rec.hr, rec.mse, rec.entrain):
        if df is not None and not df.empty and "t" in df:
            real_dur = max(real_dur, float(df["t"].max()))

    if real_dur <= 0:
        return {"effective_fs": float(EEG_FS), "drift_ppm": 0.0, "ok": False,
                "note": "no performance.now() reference stream; using nominal 256",
                "eeg_dur_idx_s": eeg_dur_idx, "real_dur_s": 0.0}

    eff_fs = n_eeg_samples / real_dur
    drift_ppm = (eff_fs / EEG_FS - 1.0) * 1e6
    ok = abs(drift_ppm) < 5000  # >0.5% would indicate a real problem, not jitter
    return {
        "effective_fs": float(eff_fs),
        "drift_ppm": float(drift_ppm),
        "ok": bool(ok),
        "eeg_dur_idx_s": float(eeg_dur_idx),
        "real_dur_s": float(real_dur),
        "note": ("clock within tolerance; correction applied"
                 if ok else "clock drift >0.5% — investigate before trusting PLV"),
    }


# ---------------------------------------------------------------------------
# Ladder / signal construction
# ---------------------------------------------------------------------------
def build_ladder(fundamental_hz: float) -> list[tuple[float, str, float]]:
    """(freq_hz, name, multiplier) per rung for a given beat frequency."""
    return [(fundamental_hz * m, name, m) for (m, name) in LADDER]


def _valid_runs(valid: np.ndarray) -> list[tuple[int, int]]:
    """List of [start, end) index ranges where ``valid`` is True."""
    n = len(valid)
    if not valid.any():
        return []
    diff = np.diff(valid.astype(np.int8))
    starts = np.where(diff == 1)[0] + 1
    ends = np.where(diff == -1)[0] + 1
    if valid[0]:
        starts = np.concatenate([[0], starts])
    if valid[-1]:
        ends = np.concatenate([ends, [n]])
    return list(zip(starts.tolist(), ends.tolist()))


def quality_weighted_signal(eeg: np.ndarray, sq_df: pd.DataFrame, fs: float = EEG_FS) -> np.ndarray:
    """Collapse the 4-channel EEG to one quality-weighted signal, time-resolved.

    Reuses ``utils._quality_weights`` (drop up to 2 worst channels, good=1.0 /
    marginal=0.5) per signal-quality window and applies it per sample. Samples
    are NaN where a contributing channel is missing or where all channels are
    poor — matching how the tempogram/MSE pipelines gate windows, but as a
    continuous trace suitable for filtering.
    """
    n = eeg.shape[0]
    if sq_df is None or sq_df.empty:
        sig = np.nanmean(eeg, axis=1)
        sig[np.isnan(eeg).all(axis=1)] = np.nan
        return sig

    qcols = [f"q_{c}" for c in CH_NAMES]
    labels_arr = sq_df[qcols].values          # (m, 4) strings
    sq_t = sq_df["t"].values                  # window-centre times (s)
    m = len(sq_df)
    W = np.zeros((m, 4))
    tot = np.zeros(m)
    for i in range(m):
        w, t = _quality_weights(list(labels_arr[i]))
        W[i] = w
        tot[i] = t

    # Map every EEG sample to the latest quality window at or before it.
    t_samp = np.arange(n) / fs
    row = np.searchsorted(sq_t, t_samp, side="right") - 1
    np.clip(row, 0, m - 1, out=row)

    wsamp = W[row]                            # (n, 4) per-sample weights
    contrib = np.where(np.isnan(eeg), 0.0, eeg) * wsamp
    sig = contrib.sum(axis=1)

    # Invalidate: a weighted channel is NaN, or the window had no usable channel.
    bad = ((np.isnan(eeg) & (wsamp > 0)).any(axis=1)) | (tot[row] <= 0)
    sig[bad] = np.nan
    return sig


def morlet_analytic(sig: np.ndarray, f0: float, fs: float, n_cycles: float = N_CYCLES_FILTER) -> np.ndarray:
    """Complex analytic signal at ``f0`` via a complex Morlet wavelet, applied
    per contiguous non-NaN segment (like ``utils.notch_eeg``). Returns a complex
    array; ``angle`` is instantaneous phase, ``abs`` is amplitude. Edge regions
    (half a kernel) and gaps are NaN.
    """
    sigma_t = n_cycles / (2 * np.pi * f0)
    half = int(np.ceil(4.0 * sigma_t * fs))
    tt = np.arange(-half, half + 1) / fs
    kernel = np.exp(2j * np.pi * f0 * tt) * np.exp(-(tt ** 2) / (2 * sigma_t ** 2))
    kernel /= np.sqrt(np.sum(np.abs(kernel) ** 2))

    out = np.full(len(sig), np.nan, dtype=np.complex128)
    for s, e in _valid_runs(~np.isnan(sig)):
        if e - s <= 2 * half + 1:
            continue
        conv = fftconvolve(sig[s:e], kernel, mode="same")
        conv[:half] = np.nan
        conv[-half:] = np.nan
        out[s:e] = conv
    return out


def _plv_power_series(z: np.ndarray, f0: float, fs: float, tgrid: np.ndarray, win_s: float):
    """Sliding phase-locking value and band power of analytic signal ``z`` vs a
    beat-grid reference oscillator at ``f0``.

    ``psi(t) = 2*pi*f0*t`` is the ideal metronome; the relative phase
    ``delta = angle(z) - psi`` is stable when the brain locks to the beat, so
    ``PLV = |mean(exp(i*delta))|`` over a window measures that stability (1 =
    perfectly locked, ~0 = random). Power = mean |z|^2 for the same window
    (the discriminator's power view).
    """
    n = len(z)
    win = int(win_s * fs)
    idx = np.arange(n)
    psi = 2 * np.pi * f0 * idx / fs
    amp = np.abs(z)
    with np.errstate(invalid="ignore", divide="ignore"):
        u = (z / amp) * np.exp(-1j * psi)     # unit vector of relative phase
    absz2 = amp ** 2

    plv = np.full(len(tgrid), np.nan)
    power = np.full(len(tgrid), np.nan)
    for k, tc in enumerate(tgrid):
        c = int(round(tc * fs))
        s = max(0, c - win // 2)
        e = min(n, c + win // 2)
        seg = u[s:e]
        valid = np.isfinite(seg)
        if valid.sum() < MIN_VALID_FRAC * win:
            continue
        plv[k] = np.abs(np.mean(seg[valid]))
        power[k] = float(np.nanmean(absz2[s:e]))
    return plv, power


def _baseline_floor(plv_row: np.ndarray, pre_mask: np.ndarray) -> float:
    """Null floor for one rung = mean PLV over the pre-music quiet segment.

    With no stimulus, any PLV to the beat grid is finite-window bias plus
    endogenous rhythm, so this baseline is exactly what genuine entrainment must
    exceed during music. Falls back to a small constant if the pre-music window
    is too short/empty to estimate.
    """
    vals = plv_row[pre_mask]
    vals = vals[np.isfinite(vals)]
    if vals.size >= 5:
        return float(np.mean(vals))
    return BASELINE_FALLBACK


# ---------------------------------------------------------------------------
# Views on the phase pipeline
# ---------------------------------------------------------------------------
def _segment_masks(tgrid: np.ndarray, duration: float):
    return {
        "pre": (tgrid >= 0) & (tgrid < MUSIC_START_S),
        "music": (tgrid >= MUSIC_START_S) & (tgrid < MUSIC_END_S),
        "post": (tgrid >= MUSIC_END_S) & (tgrid <= duration),
    }


def _fit_ringdown(tgrid: np.ndarray, plv: np.ndarray, t0: float, window_s: float = 180.0):
    """Fit PLV(t) = A*exp(-(t-t0)/tau) + C on the post-music tail. Returns
    ``{tau_s, A, C, ok}`` — ``ok=False`` if the fit is unreliable."""
    m = (tgrid >= t0) & (tgrid <= t0 + window_s) & np.isfinite(plv)
    t = tgrid[m] - t0
    y = plv[m]
    if len(t) < 8 or np.nanstd(y) < 1e-4:
        return {"tau_s": None, "A": None, "C": None, "ok": False}
    try:
        p0 = [max(y[0] - y[-1], 1e-3), 30.0, float(np.nanmin(y))]
        popt, _ = curve_fit(
            lambda tt, A, tau, C: A * np.exp(-tt / tau) + C, t, y,
            p0=p0, bounds=([0, 2.0, -1.0], [2.0, 600.0, 1.0]), maxfev=8000,
        )
        A, tau, C = popt
        ok = 2.0 < tau < 590.0 and A > 0.01
        return {"tau_s": float(tau), "A": float(A), "C": float(C), "ok": bool(ok)}
    except Exception:
        return {"tau_s": None, "A": None, "C": None, "ok": False}


def _off_ladder_scan(sig: np.ndarray, fs: float, music_mask_samp: np.ndarray,
                     ladder_freqs: list[float], lo=0.3, hi=8.0, step=0.1):
    """PLV on a fine frequency grid over the music segment only (one value per
    freq). The floor is the broadband baseline (median PLV across all scanned
    frequencies) — the typical lock to an arbitrary frequency of this window
    length. Flags peaks that clear the floor but don't sit on a ladder rung —
    e.g. a ~5 Hz endogenous-theta locus (Wollman 2020)."""
    freqs = np.arange(lo, hi + step / 2, step)
    idx = np.arange(len(sig))
    plv = np.full(len(freqs), np.nan)
    for k, f in enumerate(freqs):
        z = morlet_analytic(sig, f, fs)
        psi = 2 * np.pi * f * idx / fs
        with np.errstate(invalid="ignore", divide="ignore"):
            u = (z / np.abs(z)) * np.exp(-1j * psi)
        u = u[music_mask_samp]
        u = u[np.isfinite(u)]
        if u.size:
            plv[k] = float(np.abs(np.mean(u)))
    finite = plv[np.isfinite(plv)]
    floor = float(np.median(finite) + 1.4826 * np.median(np.abs(finite - np.median(finite)))) if finite.size else 0.0
    # off-ladder peaks above floor, not within 0.15 Hz of a rung
    is_off = np.array([min(abs(f - lf) for lf in ladder_freqs) > 0.15 for f in freqs])
    peaks = [(float(freqs[k]), float(plv[k])) for k in range(len(freqs))
             if is_off[k] and np.isfinite(plv[k]) and plv[k] > floor]
    return {"freqs": freqs, "plv": plv, "floor": floor, "off_ladder_peaks": peaks}


@dataclass
class EntrainmentResult:
    meta: dict
    clock: dict
    fundamental_hz: float
    ladder: list          # (freq, name, mult)
    tgrid: np.ndarray
    plv: np.ndarray       # (R, T)
    power: np.ndarray     # (R, T)
    floor: np.ndarray     # (R,)
    segments: dict        # name -> {rung_name: {plv, power, above_floor}}
    ringdown: dict
    off_ladder: dict
    bistable: dict
    duration_s: float


def analyse_entrainment(path, fundamental_hz: float | None = None,
                        verbose: bool = True) -> EntrainmentResult:
    """Full phase-locking analysis for one session JSONL file."""
    rec = load_jsonl(path)
    clock = verify_sample_clock(rec)
    fs = clock["effective_fs"]

    if fundamental_hz is None:
        bpm = float(rec.meta.get("audioBpm", 120.0))
        fundamental_hz = bpm / 60.0

    if verbose:
        _print_clock(clock, fundamental_hz, rec.meta)

    # Grid on the nominal counter, reinterpret time via the corrected fs downstream.
    _, eeg = packets_to_grid(rec.eeg_packets, EEG_FS, rec.duration_s, n_channels=4)
    eeg = notch_eeg(eeg)
    sq = signal_quality(eeg)
    sig = quality_weighted_signal(eeg, sq)
    sig = interpolate_short_gaps(sig, max_gap=GAP_MAX)
    filled = np.nan_to_num(sig, nan=0.0)  # gap-free copy for the off-ladder scan

    duration = len(sig) / fs
    tgrid = np.arange(EVAL_HOP_S, duration, EVAL_HOP_S)
    ladder = build_ladder(fundamental_hz)

    R, T = len(ladder), len(tgrid)
    plv = np.full((R, T), np.nan)
    power = np.full((R, T), np.nan)
    for r, (f0, name, _mult) in enumerate(ladder):
        win_s = float(np.clip(PLV_WIN_CYCLES / f0, PLV_WIN_MIN_S, PLV_WIN_MAX_S))
        z = morlet_analytic(sig, f0, fs)
        plv[r], power[r] = _plv_power_series(z, f0, fs, tgrid, win_s)

    # Null floor per rung = pre-music quiet baseline PLV (see _baseline_floor).
    masks = _segment_masks(tgrid, duration)
    floor = np.array([_baseline_floor(plv[r], masks["pre"]) for r in range(R)])
    if verbose:
        for r, (f0, name, _m) in enumerate(ladder):
            print(f"    {name:>13s}  f={f0:5.3f} Hz  baseline floor={floor[r]:.3f}")

    # Per-segment summary (the discriminator: power up everywhere, PLV up only in music)
    segments = {}
    for seg, msk in masks.items():
        segments[seg] = {}
        for r, (_f0, name, _m) in enumerate(ladder):
            p = plv[r][msk]
            pw = power[r][msk]
            mean_plv = float(np.nanmean(p)) if np.isfinite(p).any() else np.nan
            segments[seg][name] = {
                "plv": mean_plv,
                "power": float(np.nanmean(pw)) if np.isfinite(pw).any() else np.nan,
                "above_floor": (mean_plv - floor[r]) if np.isfinite(mean_plv) else np.nan,
            }

    # P2 ring-down on the beat rung across the music→quiet offset
    beat_r = next(i for i, (_f, _n, m) in enumerate(ladder) if abs(m - 1.0) < 1e-9)
    ringdown = _fit_ringdown(tgrid, plv[beat_r], MUSIC_END_S)

    # P5 off-ladder scan over the music segment
    tsamp = np.arange(len(sig)) / fs
    music_mask_samp = (tsamp >= MUSIC_START_S) & (tsamp < MUSIC_END_S)
    off_ladder = _off_ladder_scan(filled, fs, music_mask_samp,
                                  [f for f, _, _ in ladder])

    # P3 bistable meter: competition between in-2 (1/2×) and in-3 (1/3×)
    in2 = next(i for i, (_f, _n, m) in enumerate(ladder) if abs(m - 0.5) < 1e-9)
    in3 = next(i for i, (_f, _n, m) in enumerate(ladder) if abs(m - 1 / 3) < 1e-9)
    denom = plv[in2] + plv[in3]
    with np.errstate(invalid="ignore", divide="ignore"):
        competition = (plv[in2] - plv[in3]) / denom
    bistable = {"tgrid": tgrid, "in2_plv": plv[in2], "in3_plv": plv[in3],
                "competition": competition, "in2_name": ladder[in2][1], "in3_name": ladder[in3][1]}

    return EntrainmentResult(
        meta=rec.meta, clock=clock, fundamental_hz=fundamental_hz, ladder=ladder,
        tgrid=tgrid, plv=plv, power=power, floor=floor, segments=segments,
        ringdown=ringdown, off_ladder=off_ladder, bistable=bistable, duration_s=duration,
    )


def _print_clock(clock: dict, fundamental_hz: float, meta: dict):
    print("  [Phase 0] sample-clock QC")
    print(f"    effective EEG rate: {clock['effective_fs']:.3f} Hz "
          f"({clock['drift_ppm']:+.0f} ppm vs nominal 256)  ok={clock['ok']}")
    print(f"    EEG idx duration {clock['eeg_dur_idx_s']:.1f}s vs real "
          f"{clock['real_dur_s']:.1f}s — {clock['note']}")
    print(f"  [ladder] audioBpm={meta.get('audioBpm')} -> fundamental "
          f"{fundamental_hz:.4f} Hz (NOMINAL; swap when audio arrives)")


def print_summary(res: EntrainmentResult):
    """Human-readable per-segment discriminator table."""
    print(f"\n  Phase-locking (PLV) by segment — fundamental {res.fundamental_hz:.4f} Hz")
    print(f"    {'rung':>13s} | {'floor':>6s} | "
          + " | ".join(f"{s:>16s}" for s in ("pre-quiet", "music", "post-quiet")))
    for r, (_f0, name, _m) in enumerate(res.ladder):
        cells = []
        for seg in ("pre", "music", "post"):
            d = res.segments[seg][name]
            af = d["above_floor"]
            flag = "*" if (np.isfinite(af) and af > 0.02) else " "
            cells.append(f"{d['plv']:.3f}({af:+.3f}){flag}")
        print(f"    {name:>13s} | {res.floor[r]:.3f} | " + " | ".join(f"{c:>16s}" for c in cells))
    print("    (value=PLV, (±x)=above pre-quiet baseline, * = locked above baseline)")
    rd = res.ringdown
    if rd["ok"]:
        print(f"  Ring-down (beat rung, post-offset): tau = {rd['tau_s']:.1f} s")
    else:
        print("  Ring-down: no clean exponential tail fit")
    if res.off_ladder["off_ladder_peaks"]:
        pk = ", ".join(f"{f:.2f}Hz" for f, _ in res.off_ladder["off_ladder_peaks"][:6])
        print(f"  Off-ladder PLV peaks above floor: {pk}")
