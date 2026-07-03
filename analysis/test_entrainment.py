# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "pandas"]
# ///
"""Synthetic controls for the phase-locking pipeline (entrainment.py).

Run:  uv run test_entrainment.py   (or: python test_entrainment.py in the venv)

These are positive/negative controls for the PLV math, not a unit-test framework
run. They validate the three properties that make the tool trustworthy:
  1. a known phase-lock is detected (PLV -> ~1 where injected, baseline elsewhere);
  2. the lock is frequency-specific (a detuned reference sees ~nothing);
  3. a tempo mismatch (122 vs 124 bpm) measurably degrades the lock — the concrete
     demonstration of why the exact tempo matters.

Note on (3): 124 vs 122 bpm differ by ~0.033 Hz, so the wrong reference drifts a
full cycle relative to the signal in ~30 s — i.e. within a single PLV window. The
degradation is therefore intra-window dephasing (constant regardless of run
length), not error accumulating over the 20-min run. That whole-run accumulation
is the *sample-clock* failure mode (a ~160 ppm rate error is negligible per window
but slides over 20 min); the tempo error is large enough to bite inside one window.
The two clock problems fail differently — this control exercises the tempo one.
"""
import numpy as np

from entrainment import morlet_analytic, _plv_power_series, _baseline_floor


def _make_signal(fs, dur, f0, lock_window, seed=0, amp_noise=20.0, amp_lock=60.0):
    n = int(dur * fs)
    t = np.arange(n) / fs
    rng = np.random.default_rng(seed)
    noise = np.cumsum(rng.standard_normal(n))  # 1/f-ish background
    noise = (noise - noise.mean()) / noise.std()
    sig = amp_noise * noise
    if lock_window is not None:
        lo, hi = lock_window
        m = (t >= lo) & (t < hi)
        sig[m] += amp_lock * np.sin(2 * np.pi * f0 * t[m] + 0.7)
    return t, sig


def test_detects_and_localises_lock():
    fs, dur, f0 = 256.0, 600.0, 2.067
    t, sig = _make_signal(fs, dur, f0, lock_window=(200, 400))
    tgrid = np.arange(2, dur, 2.0)
    win_s = float(np.clip(8 / f0, 6, 30))
    plv, _ = _plv_power_series(morlet_analytic(sig, f0, fs), f0, fs, tgrid, win_s)
    in_m = (tgrid >= 210) & (tgrid < 390)
    pre = (tgrid >= 2) & (tgrid < 190)
    floor = _baseline_floor(plv, pre)
    lock = np.nanmean(plv[in_m])
    print(f"[1] lock PLV={lock:.3f}  baseline={floor:.3f}  above={lock-floor:+.3f}")
    assert lock > 0.85, "injected lock not detected"
    assert lock - floor > 0.4, "lock not clearly above baseline"


def test_frequency_specific():
    fs, dur, f0 = 256.0, 600.0, 2.067
    t, sig = _make_signal(fs, dur, f0, lock_window=(200, 400))
    tgrid = np.arange(2, dur, 2.0)
    win_s = float(np.clip(8 / f0, 6, 30))
    in_m = (tgrid >= 210) & (tgrid < 390)
    df = 0.4
    plv_off, _ = _plv_power_series(morlet_analytic(sig, f0 + df, fs), f0 + df, fs, tgrid, win_s)
    off = np.nanmean(plv_off[in_m])
    print(f"[2] detuned ({f0+df:.2f} Hz) PLV in lock window={off:.3f}")
    assert off < 0.4, "lock is not frequency-specific"


def test_tempo_mismatch_erodes_lock():
    fs, dur = 256.0, 1000.0
    f_true, f_wrong = 124 / 60, 122 / 60
    t, sig = _make_signal(fs, dur, f_true, lock_window=(0, dur))  # locked throughout
    tgrid = np.arange(2, dur, 2.0)
    win_s = float(np.clip(8 / f_true, 6, 30))
    pv_true, _ = _plv_power_series(morlet_analytic(sig, f_true, fs), f_true, fs, tgrid, win_s)
    pv_wrong, _ = _plv_power_series(morlet_analytic(sig, f_wrong, fs), f_wrong, fs, tgrid, win_s)
    a, b = np.nanmean(pv_true), np.nanmean(pv_wrong)
    print(f"[3] correct-tempo PLV={a:.3f}  vs wrong-tempo (122 bpm) PLV={b:.3f}")
    assert a > 0.85, "correct tempo should recover the lock"
    assert b < a, "wrong tempo should degrade the measured lock"


if __name__ == "__main__":
    test_detects_and_localises_lock()
    test_frequency_specific()
    test_tempo_mismatch_erodes_lock()
    print("all synthetic controls PASS")
