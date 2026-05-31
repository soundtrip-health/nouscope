# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "pandas", "matplotlib"]
# ///
"""Slim CLI entrypoint for offline Nouscope recording analysis.

# Run examples:
#   uv run nouscope_analysis.py
#   uv run nouscope_analysis.py data/your_recording.jsonl
"""

from pathlib import Path
import sys

from plotting import plot_overview
from utils import analyse


def _main():
    if len(sys.argv) < 2:
        # Default to first file in analysis/data for convenience
        default_dir = Path(__file__).parent / "data"
        files = sorted(default_dir.glob("*.jsonl"))
        if not files:
            print("usage: nouscope_analysis.py <path/to/recording.jsonl>")
            sys.exit(1)
        path = files[0]
        print(f"no path given — using {path}")
    else:
        path = Path(sys.argv[1])

    print(f"loading {path} ...")
    res = analyse(path)
    print(f"  duration:        {res['duration_s']:.1f} s")
    print(
        f"  EEG missing:     {res['gaps_eeg']['missing_pct']:.1f}% "
        f"(longest gap {res['gaps_eeg']['max_gap_s']:.2f} s)"
    )
    print(
        f"  PPG missing:     {res['gaps_ppg']['missing_pct']:.1f}% "
        f"(longest gap {res['gaps_ppg']['max_gap_s']:.2f} s)"
    )
    print(f"  bands windows:   {len(res['bands_computed'])}  (recorded {len(res['bands_recorded'])})")
    print(f"  MSE windows:     {len(res['mse_computed'])}  (recorded {len(res['mse_recorded'])})")
    print(f"  HR estimates:    {len(res['hr_computed'])}  (recorded {len(res['hr_recorded'])})")
    out = path.with_suffix(".analysis.png")
    plot_overview(res, save_path=out)


if __name__ == "__main__":
    _main()
