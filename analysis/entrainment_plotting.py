"""Plotting for the phase-locking entrainment pipeline (entrainment.py)."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from entrainment import MUSIC_START_S, MUSIC_END_S


def _smooth(y, k=5):
    """NaN-aware centred rolling mean, for legible display only (analysis uses
    the raw series)."""
    if k <= 1:
        return np.asarray(y, float)
    y = np.asarray(y, float)
    n = len(y)
    out = np.full(n, np.nan)
    half = k // 2
    for i in range(n):
        seg = y[max(0, i - half):min(n, i + half + 1)]
        v = seg[np.isfinite(seg)]
        if v.size:
            out[i] = v.mean()
    return out


def _shade_segments(ax, duration):
    ax.axvspan(0, MUSIC_START_S, color="0.9", zorder=0)
    ax.axvspan(MUSIC_END_S, duration, color="0.9", zorder=0)
    ax.axvline(MUSIC_START_S, color="k", lw=0.6, ls=":")
    ax.axvline(MUSIC_END_S, color="k", lw=0.6, ls=":")


def plot_entrainment(res, save_path: str | Path | None = None):
    import matplotlib.pyplot as plt

    ladder_names = [n for _f, n, _m in res.ladder]
    ladder_freqs = [f for f, _n, _m in res.ladder]
    beat_r = next(i for i, (_f, _n, m) in enumerate(res.ladder) if abs(m - 1.0) < 1e-9)

    fig = plt.figure(figsize=(13, 15))
    gs = fig.add_gridspec(5, 2, height_ratios=[0.5, 1.1, 1.1, 1.0, 1.0])

    # Banner: clock QC + fundamental
    axb = fig.add_subplot(gs[0, :]); axb.axis("off")
    c = res.clock
    txt = (f"Session clock QC:  effective EEG rate {c['effective_fs']:.3f} Hz "
           f"({c['drift_ppm']:+.0f} ppm vs 256)   ok={c['ok']}\n"
           f"Beat fundamental {res.fundamental_hz:.4f} Hz "
           f"(audioBpm={res.meta.get('audioBpm')}, NOMINAL — swap when reference audio arrives)\n"
           f"Grey = quiet; white = assumed music window {MUSIC_START_S:.0f}–{MUSIC_END_S:.0f}s")
    axb.text(0.01, 0.5, txt, va="center", ha="left", fontsize=11, family="monospace")

    # Ladder-PLV matrix over time
    ax = fig.add_subplot(gs[1, :])
    im = ax.imshow(res.plv, aspect="auto", origin="lower", cmap="magma", vmin=0,
                   vmax=np.nanpercentile(res.plv, 99) if np.isfinite(res.plv).any() else 1,
                   extent=[res.tgrid[0], res.tgrid[-1], -0.5, len(res.ladder) - 0.5])
    ax.set_yticks(range(len(res.ladder)))
    ax.set_yticklabels([f"{n}\n{f:.2f}Hz" for n, f in zip(ladder_names, ladder_freqs)], fontsize=8)
    ax.axvline(MUSIC_START_S, color="w", lw=0.8, ls=":")
    ax.axvline(MUSIC_END_S, color="w", lw=0.8, ls=":")
    ax.set_title("Phase-locking (PLV) across the beat ladder over time")
    ax.set_xlabel("time (s)")
    fig.colorbar(im, ax=ax, label="PLV", pad=0.01)

    # The discriminator: PLV vs power on the beat rung
    axl = fig.add_subplot(gs[2, 0])
    _shade_segments(axl, res.duration_s)
    axl.plot(res.tgrid, res.plv[beat_r], color="C3", lw=0.5, alpha=0.25)
    axl.plot(res.tgrid, _smooth(res.plv[beat_r]), color="C3", lw=1.4, label="PLV (10 s smooth)")
    axl.axhline(res.floor[beat_r], color="k", ls="--", lw=0.8, label="null floor (pre-quiet)")
    axl.set_ylabel("PLV"); axl.set_title("Beat rung: phase-locking (rises only under music)")
    axl.legend(fontsize=8); axl.set_ylim(0, 1)

    axr = fig.add_subplot(gs[2, 1])
    _shade_segments(axr, res.duration_s)
    axr.plot(res.tgrid, res.power[beat_r], color="C0", lw=0.5, alpha=0.25)
    axr.plot(res.tgrid, _smooth(res.power[beat_r]), color="C0", lw=1.4)
    axr.set_ylabel("band power"); axr.set_title("Beat rung: power (rises in quiet AND music)")

    # Segment-mean bars: PLV-above-floor per rung
    axseg = fig.add_subplot(gs[3, 0])
    x = np.arange(len(res.ladder)); w = 0.26
    for j, (seg, col) in enumerate(zip(("pre", "music", "post"), ("0.6", "C3", "C0"))):
        vals = [res.segments[seg][n]["above_floor"] for n in ladder_names]
        axseg.bar(x + (j - 1) * w, vals, w, label={"pre": "pre-quiet", "music": "music", "post": "post-quiet"}[seg], color=col)
    axseg.axhline(0, color="k", lw=0.6)
    axseg.set_xticks(x); axseg.set_xticklabels(ladder_names, rotation=45, ha="right", fontsize=7)
    axseg.set_ylabel("PLV above floor"); axseg.set_title("Per-rung phase-lock above chance, by segment")
    axseg.legend(fontsize=8)

    # Ring-down on the beat rung around music offset
    axrd = fig.add_subplot(gs[3, 1])
    m = (res.tgrid >= MUSIC_END_S - 60) & (res.tgrid <= MUSIC_END_S + 200)
    axrd.plot(res.tgrid[m], res.plv[beat_r][m], color="C3", lw=0.5, alpha=0.3, marker=".", ms=2)
    axrd.plot(res.tgrid[m], _smooth(res.plv[beat_r][m], 5), color="C3", lw=1.3)
    axrd.axvline(MUSIC_END_S, color="k", ls=":", lw=0.8)
    rd = res.ringdown
    if rd["ok"]:
        tt = np.linspace(0, 180, 100)
        axrd.plot(MUSIC_END_S + tt, rd["A"] * np.exp(-tt / rd["tau_s"]) + rd["C"],
                  "k--", lw=1.2, label=f"tau={rd['tau_s']:.0f}s")
        axrd.legend(fontsize=8)
    axrd.set_title("Persistence / ring-down after music stops"); axrd.set_xlabel("time (s)"); axrd.set_ylabel("PLV")

    # Off-ladder scan
    axo = fig.add_subplot(gs[4, 0])
    ol = res.off_ladder
    axo.plot(ol["freqs"], ol["plv"], color="C4", lw=1.0)
    axo.axhline(ol["floor"], color="k", ls="--", lw=0.8, label="null floor")
    for f in ladder_freqs:
        axo.axvline(f, color="0.7", lw=0.7, ls=":")
    axo.set_title("Off-ladder PLV scan (music segment); dotted = ladder rungs")
    axo.set_xlabel("freq (Hz)"); axo.set_ylabel("PLV"); axo.legend(fontsize=8)

    # Bistable meter
    axbi = fig.add_subplot(gs[4, 1])
    _shade_segments(axbi, res.duration_s)
    bi = res.bistable
    axbi.plot(bi["tgrid"], _smooth(bi["in2_plv"], 7), color="C1", lw=1.1, label=bi["in2_name"])
    axbi.plot(bi["tgrid"], _smooth(bi["in3_plv"], 7), color="C2", lw=1.1, label=bi["in3_name"])
    axbi.set_title("Bistable meter: in-2 vs in-3 grouping"); axbi.set_xlabel("time (s)")
    axbi.set_ylabel("PLV"); axbi.legend(fontsize=8); axbi.set_ylim(0, 1)

    fig.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=110)
        print(f"saved -> {save_path}")
    return fig
