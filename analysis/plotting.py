"""Plotting helpers for offline Nouscope analysis outputs."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from utils import CH_NAMES


def plot_overview(res: dict, save_path: str | Path | None = None):
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(6, 1, figsize=(12, 14), sharex=True)
    duration = res["duration_s"]

    # Row 1: EEG quality (one stripe per channel)
    ax = axes[0]
    sq = res["sq"]
    if not sq.empty:
        cmap = {"good": 0, "marginal": 1, "poor": 2}
        for k, c in enumerate(CH_NAMES):
            codes = sq[f"q_{c}"].map(cmap).values
            ax.scatter(sq["t"], np.full_like(codes, k, dtype=float), c=codes, cmap="RdYlGn_r", vmin=0, vmax=2, s=4)
        ax.set_yticks(range(4))
        ax.set_yticklabels(CH_NAMES)
    ax.set_title("EEG signal quality (green=good, yellow=marginal, red=poor)")
    ax.set_ylabel("ch")

    # Row 2: computed band power
    ax = axes[1]
    b = res["bands_computed"]
    if not b.empty:
        for col in ("delta", "theta", "alpha", "beta", "gamma"):
            ax.plot(b["t"], b[col], label=col, lw=0.8)
    ax.set_title("Band power (recomputed offline)")
    ax.set_ylabel("rel. power")
    ax.legend(ncol=5, fontsize=8, loc="upper right")
    ax.set_ylim(0, 1)

    # Row 3: recorded vs computed alpha (sanity check)
    ax = axes[2]
    if not res["bands_recorded"].empty:
        for col in ("alpha", "beta", "gamma"):
            ax.plot(res["bands_recorded"]["t"], res["bands_recorded"][col], label=f"rec {col}", lw=0.6, alpha=0.7)
    if not b.empty:
        for col in ("alpha", "beta", "gamma"):
            ax.plot(b["t"], b[col], label=f"new {col}", lw=0.6, ls="--")
    ax.set_title("Recorded vs offline band power (alpha/beta/gamma)")
    ax.set_ylabel("rel. power")
    ax.legend(ncol=3, fontsize=7)

    # Row 4: complexity
    ax = axes[3]
    m = res["mse_computed"]
    mr = res["mse_recorded"]
    if not m.empty:
        ax.plot(m["t"], m["complexity"], label="offline", lw=1.0)
    if not mr.empty:
        ax.plot(mr["t"], mr["complexity"], label="recorded", lw=0.8, alpha=0.7)
    ax.set_title("Multiscale entropy (mean across scales)")
    ax.set_ylabel("complexity")
    ax.legend(fontsize=8)

    # Row 5: heart rate
    ax = axes[4]
    hc = res["hr_computed"]
    hr = res["hr_recorded"]
    if not hc.empty:
        ax.plot(hc["t"], hc["bpm"], label="offline", lw=0.8)
    if not hr.empty:
        ax.plot(hr["t"], hr["bpm"], label="recorded", lw=0.8, alpha=0.7)
    ax.set_title("Heart rate (BPM)")
    ax.set_ylabel("bpm")
    ax.legend(fontsize=8)

    # Row 6: EEG tempogram heatmap
    ax = axes[5]
    tg = res["tempogram"]
    if tg["times"].size and np.isfinite(tg["power"]).any():
        # Log-scale for display, mask NaNs
        p = np.log10(tg["power"] + 1e-12)
        ax.imshow(
            p,
            aspect="auto",
            origin="lower",
            extent=[tg["times"][0], tg["times"][-1], tg["freqs"][0], tg["freqs"][-1]],
            cmap="viridis",
        )
    ax.set_title("EEG tempogram (log power, 0.5–5 Hz)")
    ax.set_ylabel("freq (Hz)")
    ax.set_xlabel("time (s)")
    ax.set_xlim(0, duration)

    fig.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=120)
        print(f"saved -> {save_path}")
    return fig
