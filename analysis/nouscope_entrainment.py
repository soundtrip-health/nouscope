# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "pandas", "matplotlib"]
# ///
"""CLI for the phase-locking (ITC/PLV) entrainment analysis.

Runs the *phase*-based entrainment pipeline (entrainment.py) — the tool that can
separate genuine EEG–music entrainment from drowsiness, which the power-based
tempogram cannot. Needs no reference audio; uses the nominal beat ladder from
meta.audioBpm and re-runs unchanged when the exact tempo lands.

# Run examples:
#   uv run nouscope_entrainment.py                 # first file in data/
#   uv run nouscope_entrainment.py data/session2.jsonl
#   uv run nouscope_entrainment.py data/session2.jsonl --bpm 122   # override tempo
"""
from pathlib import Path
import sys

from entrainment import analyse_entrainment, print_summary
from entrainment_plotting import plot_entrainment


def _main():
    argv = sys.argv[1:]
    bpm = None
    if "--bpm" in argv:
        i = argv.index("--bpm")
        bpm = float(argv[i + 1])
        del argv[i:i + 2]

    if argv:
        path = Path(argv[0])
    else:
        files = sorted((Path(__file__).parent / "data").glob("*.jsonl"))
        if not files:
            print("usage: nouscope_entrainment.py <recording.jsonl> [--bpm N]")
            sys.exit(1)
        path = files[0]
        print(f"no path given — using {path}")

    fundamental = (bpm / 60.0) if bpm else None
    print(f"loading {path} ...")
    res = analyse_entrainment(path, fundamental_hz=fundamental)
    print_summary(res)
    out = path.with_suffix(".entrainment.png")
    plot_entrainment(res, save_path=out)


if __name__ == "__main__":
    _main()
