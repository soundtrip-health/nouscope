/**
 * timelineDecor — quality-ribbon + event-tick rendering shared by every
 * per-track timeline strip. Extracted from the old single-store `Scrubber` so
 * each track can paint its own store's ribbon/ticks, positioned in the shared
 * master-timeline coordinate frame (`[0, masterDuration]`) via `offsetSeconds`:
 * a track's local time `t` lands at master position `t - offsetSeconds`, the
 * inverse of `Track.effectiveCursor` (`masterCursor + offsetSeconds`).
 */

const RIBBON_SAMPLES = 300   // ribbon resolution, independent of canvas pixel width

/**
 * One thin row per EEG channel (TP9/AF7/AF8/TP10, top→bottom), stretched
 * across `[0, masterDuration]` and shifted by `-offsetSeconds` so tracks
 * started at different times line up visually under the master playhead.
 */
export function renderQualityRibbon(canvas, store, colors, { offsetSeconds, masterDuration }) {
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  if (!W || !H) return
  ctx.clearRect(0, 0, W, H)
  const dur = store.duration()
  if (dur <= 0 || masterDuration <= 0) return

  const perChannel = store.qualityRibbon(RIBBON_SAMPLES)
  const nc = perChannel.length
  const cellH = H / nc
  const gap = Math.max(1, Math.round(cellH * 0.2))
  for (let ch = 0; ch < nc; ch++) {
    const y0 = Math.round(ch * cellH)
    const y1 = Math.round((ch + 1) * cellH) - gap
    const row = perChannel[ch]
    for (let i = 0; i < RIBBON_SAMPLES; i++) {
      const t0 = (i / RIBBON_SAMPLES) * dur - offsetSeconds
      const t1 = ((i + 1) / RIBBON_SAMPLES) * dur - offsetSeconds
      const x0 = Math.floor((t0 / masterDuration) * W)
      const x1 = Math.max(x0 + 1, Math.floor((t1 / masterDuration) * W))
      if (x1 <= 0 || x0 >= W) continue
      ctx.fillStyle = colors[row[i]] || colors.poor
      ctx.fillRect(Math.max(0, x0), y0, Math.min(W, x1) - Math.max(0, x0), Math.max(1, y1 - y0))
    }
  }
}

/**
 * Music-BPM-change ticks, recording-gap ticks, and user-placed markers,
 * positioned the same way as the ribbon. `store` is nullable so this can also
 * render the master transport's own tick row (markers only, no store).
 *
 * Markers are already in *master*-timeline seconds (unlike `store.music`/
 * `store.gaps()`, which are in each track's own local time), so their tick
 * position adds `offsetSeconds` rather than subtracting it — that cancels out
 * `addTick`'s `- offsetSeconds` conversion, landing every marker at the same
 * absolute position on every track's strip regardless of that track's offset.
 *
 * Marker ticks are also genuinely clickable (music/gap ticks are purely
 * visual, `pointer-events: none`): `onMarkerClick`, if given, fires on
 * `pointerdown` with the exact marker object, and stops the event from
 * bubbling to the strip's own click-to-seek handler — so a click lands on
 * the marker's precise time rather than wherever the pointer happened to be.
 */
export function renderEventTicks(container, store, { offsetSeconds, masterDuration }, markers = [], onMarkerClick) {
  container.innerHTML = ''
  if (masterDuration <= 0) return
  const addTick = (t, cls, title, onClick) => {
    const pos = ((t - offsetSeconds) / masterDuration) * 100
    if (pos < 0 || pos > 100) return
    const el = document.createElement('div')
    el.className = `scrub-tick ${cls}`
    el.style.left = `${pos.toFixed(2)}%`
    if (title) el.title = title
    if (onClick) el.addEventListener('pointerdown', (e) => { e.stopPropagation(); onClick() })
    container.appendChild(el)
  }
  if (store) {
    for (const rec of store.music) addTick(rec.t, 'scrub-tick--music')
    for (const gap of store.gaps()) addTick(gap.t0, 'scrub-tick--gap')
  }
  for (const m of markers) addTick(m.t + offsetSeconds, 'scrub-tick--marker', m.label, () => onMarkerClick?.(m))
}
