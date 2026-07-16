/** Seconds → MM:SS (or H:MM:SS past an hour). Shared by every scrubber/marker-list readout. */
export function formatTime(s) {
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = m.toString().padStart(2, '0')
  const ss = sec.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** MM:SS or H:MM:SS → seconds. Returns null for anything that isn't 2-3 colon-separated numbers (the marker modal's time field falls back to its previous value on null). */
export function parseTime(str) {
  const parts = str.trim().split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null
  const nums = parts.map(Number)
  const [h, m, sec] = nums.length === 3 ? nums : [0, ...nums]
  return h * 3600 + m * 60 + sec
}
