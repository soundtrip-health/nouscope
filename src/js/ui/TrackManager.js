import SessionStore from '../managers/SessionStore'
import Track from './Track'

const FILE_NORMALIZE_BANDS = new Set(['theta', 'alpha', 'beta', 'gamma'])
let _nextTrackId = 1

/**
 * TrackManager — owns the stack of `Track`s in the multi-track review view.
 * At most one track is `'live'` (the always-on EEG/DVR session); every other
 * track is a loaded `.jsonl` file, added independently of the live pipeline.
 */
export default class TrackManager {
  /**
   * @param {HTMLElement} containerEl — `#analysis-panel`, the track stack
   * @param {object} sourceFns
   * @param {() => number} sourceFns.getMasterDuration — read the master scrubber's current duration
   * @param {(t: number) => void} sourceFns.seekMaster — seek the master scrubber
   * @param {() => void} [sourceFns.markDirty] — force the master scrubber to redraw next frame
   */
  constructor(containerEl, { getMasterDuration, seekMaster, markDirty } = {}) {
    this._container = containerEl
    this._template = document.getElementById('track-lane-template')
    this._getMasterDuration = getMasterDuration ?? (() => 0)
    this._seekMaster = seekMaster ?? (() => {})
    this._markDirty = markDirty ?? (() => {})
    this.tracks = []
    this.focusedTrack = null
  }

  _cloneLane() {
    return this._template.content.firstElementChild.cloneNode(true)
  }

  _mountTrack(track) {
    const wrapper = document.createElement('div')
    wrapper.className = 'track'
    wrapper.dataset.trackId = track.id
    wrapper.appendChild(track.headerEl)

    const laneCol = document.createElement('div')
    laneCol.className = 'track-lane-col'
    laneCol.appendChild(track.timelineStripEl)
    laneCol.appendChild(track.laneEl)
    wrapper.appendChild(laneCol)

    wrapper.addEventListener('pointerdown', () => { this.focusedTrack = track }, { capture: true })
    track.root = wrapper
    this._container.appendChild(wrapper)
    track.init()
    this.tracks.push(track)
    return track
  }

  /** Wrap the already-live `SessionStore` (App's DVR capture) as the live track. */
  addLiveTrack(store) {
    const track = new Track({
      id: `track-${_nextTrackId++}`,
      kind: 'live',
      store,
      laneEl: this._cloneLane(),
      label: 'Live',
      normalizeBands: null,   // shown by the connected EEGManager's own set
      getMasterDuration: this._getMasterDuration,
      seekMaster: this._seekMaster,
      markDirty: this._markDirty,
    })
    return this._mountTrack(track)
  }

  /**
   * Parse a saved `.jsonl` recording into a brand-new store and add it as a
   * track. Additive: never touches the live track or its store.
   * @returns {Track}
   */
  addFileTrack(text, label) {
    const store = new SessionStore()
    store.loadFromText(text)
    const track = new Track({
      id: `track-${_nextTrackId++}`,
      kind: 'file',
      store,
      laneEl: this._cloneLane(),
      label,
      normalizeBands: FILE_NORMALIZE_BANDS,
      getMasterDuration: this._getMasterDuration,
      seekMaster: this._seekMaster,
      markDirty: this._markDirty,
    })
    return this._mountTrack(track)
  }

  removeTrack(track) {
    const i = this.tracks.indexOf(track)
    if (i === -1) return
    this.tracks.splice(i, 1)
    if (this.focusedTrack === track) this.focusedTrack = null
    track.dispose()
  }

  get liveTrack() {
    return this.tracks.find(t => t.kind === 'live') ?? null
  }

  forEach(fn) {
    this.tracks.forEach(fn)
  }

  maxDuration() {
    let d = 0
    for (const t of this.tracks) d = Math.max(d, t.duration())
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
