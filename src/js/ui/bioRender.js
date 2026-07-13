/**
 * bioRender — shared rendering primitives for the bio-data visualizations.
 *
 * The scale factors, per-panel time windows, color tokens, viridis colormap and
 * per-column spectrogram blit that `AnalysisDisplay` draws with all live here,
 * separate from the renderer, so the numbers that define how the data reads are
 * in one place rather than buried in drawing code.
 *
 * Nothing here is stateful — these are pure constants and functions. Color
 * tokens are resolved lazily (see palette.js) inside the renderer's init().
 */

// ── Transparent clear color for WebGL plots ─────────────────────────────────
export const TRANSPARENT = [0, 0, 0, 0]

// ── EEG trace geometry ──────────────────────────────────────────────────────
export const EEG_SCALE     = 200   // µV mapped to full per-channel half-height
export const EEG_AMPLITUDE = 0.22  // normalized half-height per channel stripe
export const EEG_OFFSETS   = [0.75, 0.25, -0.25, -0.75]  // TP9, AF7, AF8, TP10

// ── IMU trace scales ────────────────────────────────────────────────────────
export const ACCEL_SCALE = 2.0    // ±2 g (Muse full range)
export const GYRO_SCALE  = 300    // ±300 dps

// ── MSE mapping ─────────────────────────────────────────────────────────────
export const MSE_Y_MAX = 2.5   // SampEn rarely exceeds this; maps values into [-1, +1]

// ── Per-panel time windows (seconds) ────────────────────────────────────────
// Each panel shows `[cursor - PANEL_WINDOWS[panel], cursor]`. A single shared
// window across every panel is wrong: a 2 s span is right for reading individual
// EEG deflections but shows one MSE step and half a breath of PPG, while the 70 s
// span the spectrograms need turns the EEG trace into a solid block. These values
// reproduce the spans the old live scrolling panel had, which were tuned against
// user feedback:
//   eeg 512 samples @256 Hz · ppg 384 @64 Hz · imu 208 @52 Hz
//   bands 300 frames @~60 fps · mse 1800 frames @~60 fps
//   spectrograms 140 columns (280 px / 2 px per column) @~2 columns/s
// The audio tempogram scrolled far faster live (a column per frame), which was an
// artifact of its polling rate rather than a choice; it is pinned to the other two
// heatmaps here so all three share one time axis.
export const PANEL_WINDOWS = {
  eeg:       2,
  spec:     70,
  specLo:   70,
  specAudio: 70,
  bands:     5,
  mse:      30,
  ppg:       6,
  imu:       4,
}

// The live band chart lerped toward the ~2 Hz band-power updates at 0.08 per
// frame, i.e. an exponential with a ~0.21 s time constant, turning the staircase
// into a continuous curve. The analysis renderer resamples the same records onto
// pixels, so it applies an equivalent one-pole filter derived from this constant
// and the per-pixel time step — see AnalysisDisplay._renderBands.
export const BAND_SMOOTH_TAU = 0.21   // seconds

// ── Color tokens (resolved from CSS at init via palette.js) ─────────────────
export const EEG_TOKENS  = ['--eeg-tp9', '--eeg-af7', '--eeg-af8', '--eeg-tp10']
export const BAND_TOKENS = ['--band-delta', '--band-theta', '--band-alpha', '--band-beta', '--band-gamma']
export const IMU_TOKENS  = ['--imu-accel-x', '--imu-accel-y', '--imu-accel-z',
                            '--imu-gyro-x', '--imu-gyro-y', '--imu-gyro-z']
// MSE scale colors — violet→amber across the 5 scales (τ=1 → τ=9)
export const MSE_TOKENS  = ['--mse-1', '--mse-2', '--mse-3', '--mse-4', '--mse-5']

// ── Spectrogram layout ──────────────────────────────────────────────────────
export const SPEC_BINS         = 50
export const SPEC_START_BIN    = 8     // first Hz shown in main spec (1–7 Hz shown in lo-spec only)
export const SPEC_START_IDX    = SPEC_START_BIN - 1          // array index for SPEC_START_BIN
export const SPEC_DISPLAY_BINS = SPEC_BINS - SPEC_START_IDX  // bins shown: 8–50 Hz = 43
export const SPEC_PX_PER_BIN   = 2     // vertical pixels per frequency bin
export const SPEC_COL_WIDTH    = 2     // horizontal pixels per time column (scroll speed)
export const SPEC_SCALE_DECAY  = 0.995 // running floor decay per column
export const SPEC_MIN_RANGE    = 2     // minimum log₁₀ dynamic range
export const SPEC_SCALE_WIN    = 30    // columns in sliding window for robust ceiling (~15 s at 2 Hz)
export const SPEC_SCALE_PCT    = 0.9   // percentile of window used as scale ceiling
export const SPEC_FLOOR_PCT    = 0.05  // low percentile used as scale floor (artifact-robust)
// Cap on values examined per `specColumnsScale` call: a wide analysis window can hold
// thousands of columns, and sorting every bin of every one of them every frame is the
// cost that made scrubbing at large window sizes laggy. Striding down to a bounded
// sample keeps the percentile estimate stable while making the cost flat regardless of
// window width.
export const SPEC_SCALE_SAMPLE_CAP = 4000
// log₁₀ cap ≈ 200 µV amplitude (Hann-DFT power ≈ A² × N²/16; log₁₀(200² × 4096) ≈ 8.2)
export const SPEC_LOG_CAP      = 8.2

// Low-end spectrogram (0.5–8.0 Hz at 0.1 Hz resolution, hi-res entrainment view)
export const SPEC_LO_BINS       = 76   // 0.5–8.0 Hz at 0.1 Hz steps
export const SPEC_LO_PX_PER_BIN = 1    // 1 pixel per bin → 76 px tall

// ── Viridis colormap ────────────────────────────────────────────────────────
// Piecewise-linear from 9 key stops, precomputed to a 256-entry LUT.
const _VIRIDIS_STOPS = [
  [0.000,  68,   1,  84],
  [0.125,  72,  36, 117],
  [0.250,  59,  82, 139],
  [0.375,  44, 114, 142],
  [0.500,  33, 145, 140],
  [0.625,  57, 175, 120],
  [0.750, 122, 209,  81],
  [0.875, 189, 223,  38],
  [1.000, 253, 231,  37],
]

export const VIRIDIS_LUT = (() => {
  const lut = new Array(256)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let seg = 1
    while (seg < _VIRIDIS_STOPS.length - 1 && t > _VIRIDIS_STOPS[seg][0]) seg++
    const [t0, r0, g0, b0] = _VIRIDIS_STOPS[seg - 1]
    const [t1, r1, g1, b1] = _VIRIDIS_STOPS[seg]
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0
    lut[i] = [
      Math.round(r0 + f * (r1 - r0)),
      Math.round(g0 + f * (g1 - g0)),
      Math.round(b0 + f * (b1 - b0)),
    ]
  }
  return lut
})()

/** Viridis [r, g, b] for a normalized value (clamped to [0, 1]). */
export function viridisRGB(norm) {
  const idx = Math.max(0, Math.min(255, Math.round(norm * 255)))
  return VIRIDIS_LUT[idx]
}

/**
 * Robust color scale (floor + range) for a set of spectrogram columns: each
 * value is clamped to `cap`, the ceiling is the
 * `SPEC_SCALE_PCT` percentile and the floor is the low `SPEC_FLOOR_PCT`
 * percentile — so a single saturating (e.g. jaw-clench) or near-silent column
 * can't blow the range out the way a raw min/max would.
 *
 * Percentiles are taken over the columns visible in the window, which the
 * random-access renderer always has in hand at once.
 *
 * @param {{col:ArrayLike<number>}[]} columns
 * @param {number} startIdx — first bin index considered
 * @param {number} endIdx — one past the last bin index
 * @param {number} [cap=Infinity] — per-value ceiling (pass SPEC_LOG_CAP for EEG)
 * @returns {{lo:number, range:number}|null} null if no usable values
 */
export function specColumnsScale(columns, startIdx, endIdx, cap = Infinity) {
  const binsPerCol = endIdx - startIdx
  const maxCols = Math.max(1, Math.floor(SPEC_SCALE_SAMPLE_CAP / binsPerCol))
  const stride = Math.max(1, Math.ceil(columns.length / maxCols))

  const vals = []
  for (let c = 0; c < columns.length; c += stride) {
    const col = columns[c].col
    for (let i = startIdx; i < endIdx; i++) {
      const v = col[i]
      if (Number.isNaN(v) || v <= -9) continue   // skip gaps / near-zero padding
      vals.push(v < cap ? v : cap)
    }
  }
  if (!vals.length) return null
  vals.sort((a, b) => a - b)
  const hi = vals[Math.floor((vals.length - 1) * SPEC_SCALE_PCT)]
  const lo = vals[Math.floor((vals.length - 1) * SPEC_FLOOR_PCT)]
  return { lo, range: Math.max(hi - lo, SPEC_MIN_RANGE) }
}

/**
 * Draw a subtle "No Audio" placeholder on a 2D canvas context.
 * Clears to black, then draws centered, semi-transparent white text.
 * @param {CanvasRenderingContext2D} ctx
 */
export function paintNoAudioPlaceholder(ctx) {
  const c = ctx.canvas
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.font = '12px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('No Audio', c.width / 2, c.height / 2)
}

/**
 * Paint one spectrogram column into an ImageData buffer using the viridis LUT.
 *
 * Frequency runs bottom-up: bin `startIdx` sits at the bottom, higher bins
 * stack upward. Each bin fills `pxPerBin` rows; the column is `colWidth` px wide.
 * Used identically by the live scroll renderer (draw into a fresh right-edge
 * column) and the analysis renderer (draw into a per-time-slice column).
 *
 * The column may be drawn into a buffer wider than itself: pass `stride` (the
 * imgData row width in px) and `x0` (this column's left pixel) to paint one
 * output pixel of a full-width `stride × H` buffer, so the analysis renderer can
 * build the whole spectrogram in one ImageData and blit it once.
 *
 * @param {ImageData} imgData — target, at least `(x0 + colWidth) × H`
 * @param {ArrayLike<number>} col — log-power values, one per frequency bin
 * @param {object} o
 * @param {number} o.lo — floor of the value→color mapping
 * @param {number} o.range — value span mapped across the colormap
 * @param {number} o.H — imgData height in px
 * @param {number} o.colWidth — px this column spans horizontally
 * @param {number} o.pxPerBin — vertical px per frequency bin
 * @param {number} [o.stride=colWidth] — imgData row width in px
 * @param {number} [o.x0=0] — left pixel of this column in the buffer
 * @param {number} [o.startIdx=0] — first bin index to draw
 * @param {number} [o.endIdx=col.length] — one past the last bin index to draw
 */
export function paintSpecColumn(imgData, col, o) {
  const startIdx = o.startIdx ?? 0
  const endIdx   = o.endIdx ?? col.length
  const { lo, range, H, colWidth, pxPerBin } = o
  const stride = o.stride ?? colWidth   // imgData row width in px (≥ colWidth)
  const x0     = o.x0 ?? 0              // left pixel of this column in the buffer
  const data = imgData.data
  for (let i = startIdx; i < endIdx; i++) {
    const norm = (col[i] - lo) / range
    const [r, g, b] = viridisRGB(norm)
    const binInDisplay = i - startIdx
    for (let p = 0; p < pxPerBin; p++) {
      const y = H - 1 - (binInDisplay * pxPerBin + p)
      for (let cx = 0; cx < colWidth; cx++) {
        const off = (y * stride + x0 + cx) * 4
        data[off]     = r
        data[off + 1] = g
        data[off + 2] = b
        data[off + 3] = 255
      }
    }
  }
}
