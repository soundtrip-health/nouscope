import TrackManager from './ui/TrackManager'
import MultiTrackScrubber from './ui/MultiTrackScrubber'

/**
 * MultiTrackApp — orchestrator for the Multi-Track tab.
 *
 * A separate, independent feature from the original single-session `App`
 * (see App.js): file-review only, side by side. Each `↑ Add track` load
 * creates a brand-new `SessionStore` + `Track`; there is no live EEG
 * connection, no recording, no audio here — just loading and comparing saved
 * `.jsonl` recordings against one shared master timeline (see
 * `TrackManager`/`Track`/`MultiTrackScrubber`).
 */
export default class MultiTrackApp {
  constructor() {
    this._tracksEl = document.getElementById('mt-tracks')

    this._scrubber = new MultiTrackScrubber((cursor) => {
      this._trackManager.renderAll(cursor)
      this._trackManager.renderAllTimelines(cursor)
    })
    this._scrubber.attach()

    this._trackManager = new TrackManager(this._tracksEl, {
      getMasterDuration: () => this._scrubber.getDuration(),
      seekMaster: (t) => this._scrubber.seek(t),
      markDirty: () => this._scrubber.refresh(),
    })
    this._scrubber.setDurationSource(() => this._trackManager.maxDuration())
    this._scrubber.setFocusedTrackSource(() => this._trackManager.focusedTrack)

    const addInput = document.getElementById('mt-add-track-input')
    addInput.addEventListener('change', (e) => {
      const file = e.target.files[0]
      if (!file) return
      e.target.value = ''
      this._loadTrackFile(file)
    })

    window.addEventListener('resize', () => {
      if (document.getElementById('multitrack-view').hidden) return
      this._trackManager.resizeAll()
      this._scrubber.resize()
      this._scrubber.refresh()
    })
  }

  /** Called by the tab switcher when this tab becomes visible, to size freshly-visible canvases. */
  onShow() {
    this._trackManager.resizeAll()
    this._scrubber.resize()
    this._scrubber.refresh()
    if (!this._scrubber._active) this._scrubber.setActive(true, { atStart: true })
  }

  async _loadTrackFile(file) {
    let text
    try { text = await file.text() } catch (err) { console.error('Recording read failed:', err); return }

    let track
    try {
      track = this._trackManager.addFileTrack(text, file.name)
    } catch (err) {
      console.error('Recording parse failed:', err)
      return
    }

    const ts = track.store.meta?.startedAt
    const when = ts ? new Date(ts).toLocaleString() : 'unknown date'
    track.setLabel(`${file.name} — ${when}`)

    this._scrubber.refresh()
  }
}
