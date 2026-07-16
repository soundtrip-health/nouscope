import SessionStore from '../managers/SessionStore'
import Track, { DEFAULT_PANELS, TRACK_ACCENT_VARS } from './Track'

let _nextTrackId = 1

// Hard cap on concurrent tracks: each enabled panel holds its own WebGL
// context (see `MAX_PANELS` in Track.js), so unbounded tracks risk
// exhausting the browser's live-context budget.
export const MAX_TRACKS = 4

/**
 * TrackManager — owns the stack of `Track`s in the Multi-Track tab. Every
 * track is a loaded `.jsonl` file (this tab is file-review only — there is no
 * live EEG connection here; see App.js/MultiTrackApp.js for that).
 */
export default class TrackManager {
  /**
   * @param {HTMLElement} containerEl — the track stack container
   * @param {object} sourceFns
   * @param {() => number} sourceFns.getMasterDuration — read the master scrubber's current duration
   * @param {(t: number) => void} sourceFns.seekMaster — seek the master scrubber
   * @param {() => void} [sourceFns.markDirty] — force the master scrubber to redraw next frame
   * @param {(count: number) => void} [sourceFns.onCountChange] — called after
   *   a track is added or removed, with the new track count (lets callers
   *   enforce `MAX_TRACKS` against the "+Add track" control).
   * @param {() => {t:number,label:string,color:string,trackIds:?string[]}[]} [sourceFns.getMarkers] —
   *   every marker, forwarded to every track (see `Track`, which filters to
   *   the global ones plus any whose `trackIds` includes its own id). Tracks
   *   have no add-marker control of their own — only the master transport's
   *   "+ Marker" button/modal creates markers.
   * @param {(trackId: string) => void} [sourceFns.onTrackRemoved] — called
   *   after a track is removed, with its `id` (lets callers prune markers
   *   scoped to a track that no longer exists).
   */
  constructor(containerEl, { getMasterDuration, seekMaster, markDirty, onCountChange, getMarkers, onTrackRemoved } = {}) {
    this._container = containerEl
    this._template = document.getElementById('mt-track-lane-template')
    this._getMasterDuration = getMasterDuration ?? (() => 0)
    this._seekMaster = seekMaster ?? (() => {})
    this._markDirty = markDirty ?? (() => {})
    this._onCountChange = onCountChange ?? (() => {})
    this._getMarkers = getMarkers ?? (() => [])
    this._onTrackRemoved = onTrackRemoved ?? (() => {})
    this.tracks = []
    this.focusedTrack = null

    // Clicking anywhere outside a track (the master transport, the empty
    // stack background, a marker, etc.) clears the focused track so shortcuts
    // target the main timeline again. A track's own listener (set in
    // _mountTrack) sets focus after this capture-phase clear runs.
    document.addEventListener('pointerdown', (e) => {
      const el = e.target
      if (!el || !el.closest || !el.closest('.mt-track')) this._setFocused(null)
    })
  }

  /**
   * Set or clear (with `track = null`) the focused track. Toggles a `.focused`
   * class on the focused track's wrapper so its edge lights up in that track's
   * accent color — the visible cue for which track keyboard shortcuts target
   * (see `MultiTrackScrubber._onKey` / `MultiTrackApp._jumpMarker`).
   * @param {Track|null} track
   */
  _setFocused(track) {
    if (this.focusedTrack === track) return
    if (this.focusedTrack && this.focusedTrack.root) this.focusedTrack.root.classList.remove('focused')
    this.focusedTrack = track
    if (track && track.root) track.root.classList.add('focused')
  }

  _cloneLane() {
    return this._template.content.firstElementChild.cloneNode(true)
  }

  _mountTrack(track) {
    const wrapper = document.createElement('div')
    wrapper.className = 'mt-track'
    wrapper.dataset.trackId = track.id
    wrapper.style.setProperty('--track-accent', track.color)
    wrapper.appendChild(track.headerEl)

    const laneCol = document.createElement('div')
    laneCol.className = 'mt-track-lane-col'
    laneCol.appendChild(track.timelineStripEl)
    laneCol.appendChild(track.laneEl)
    wrapper.appendChild(laneCol)

    wrapper.addEventListener('pointerdown', () => this._setFocused(track), { capture: true })
    track.root = wrapper
    this._container.appendChild(wrapper)
    track.init()
    this.tracks.push(track)
    this._onCountChange(this.tracks.length)
    return track
  }

  /**
   * Parse a saved `.jsonl` recording into a brand-new store and add it as a
   * track. Additive: never touches any other track.
   * @returns {Track}
   */
  addFileTrack(text, label) {
    const store = new SessionStore()
    store.loadFromText(text)
    // Cycle accent colors by current track count, so each concurrent slot
    // (bounded by MAX_TRACKS, same length as TRACK_ACCENT_VARS) gets a color
    // distinct from every other track on screen right now.
    const colorVar = TRACK_ACCENT_VARS[this.tracks.length % TRACK_ACCENT_VARS.length]
    const track = new Track({
      id: `track-${_nextTrackId++}`,
      store,
      laneEl: this._cloneLane(),
      label,
      colorVar,
      enabledPanels: DEFAULT_PANELS,
      getMasterDuration: this._getMasterDuration,
      seekMaster: this._seekMaster,
      markDirty: this._markDirty,
      onRemove: (t) => this.removeTrack(t),
      getMarkers: this._getMarkers,
    })
    return this._mountTrack(track)
  }

  removeTrack(track) {
    const i = this.tracks.indexOf(track)
    if (i === -1) return
    this.tracks.splice(i, 1)
    if (this.focusedTrack === track) this._setFocused(null)
    track.dispose()
    this._onCountChange(this.tracks.length)
    this._onTrackRemoved(track.id)
  }

  forEach(fn) {
    this.tracks.forEach(fn)
  }

  /** Force every track's ticks to refresh after a marker add/edit/delete. */
  notifyMarkersChanged() {
    this.tracks.forEach(t => t.notifyMarkersChanged())
  }

  /**
   * Master timeline length: long enough that every track's full local range
   * remains reachable. A track's local time `t` sits at master time
   * `t - offsetSeconds` (the inverse of `Track.effectiveCursor`, see Track.js),
   * so its own duration needs `duration() - offsetSeconds` of master range —
   * more than the raw duration whenever offsetSeconds is negative (its
   * recording started later than the reference track).
   */
  maxDuration() {
    let d = 0
    for (const t of this.tracks) d = Math.max(d, t.duration() - t.offsetSeconds)
    return d
  }

  resizeAll() {
    this.tracks.forEach(t => t.resize())
  }

  renderAll(masterCursor) {
    this.tracks.forEach(t => t.renderAt(masterCursor))
  }

  renderAllTimelines(masterCursor) {
    this.tracks.forEach(t => t.renderTimeline(masterCursor))
  }
}
