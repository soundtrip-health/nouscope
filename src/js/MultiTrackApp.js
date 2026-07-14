import TrackManager, { MAX_TRACKS } from './ui/TrackManager'
import MultiTrackScrubber from './ui/MultiTrackScrubber'
import AudioTrack from './ui/AudioTrack'

/**
 * MultiTrackApp — orchestrator for the Multi-Track tab.
 *
 * A separate, independent feature from the original single-session `App`
 * (see App.js): file-review only, side by side. Each `↑ Add track` load
 * creates a brand-new `SessionStore` + `Track`; there is no live EEG
 * connection, no recording here — just loading and comparing saved `.jsonl`
 * recordings against one shared master timeline (see
 * `TrackManager`/`Track`/`MultiTrackScrubber`).
 *
 * Two things sit outside any one track, both scoped to this tab only:
 * - `↑ Add music` loads a single shared stimulus-audio file (`AudioTrack`),
 *   played back in sync with the master transport — for reviewing a
 *   recorded session alongside the audio participants actually heard.
 * - Markers (`this._markers`, `{t, label}` in *master*-timeline seconds) are
 *   user-authored annotations ("music started here"), not session data — they
 *   live here, not on any `SessionStore`, and are overlaid as ticks on every
 *   track's own strip plus the master transport's.
 */
export default class MultiTrackApp {
  constructor() {
    this._tracksEl = document.getElementById('mt-tracks')
    this._markers = []
    this._audioTrack = null

    this._scrubber = new MultiTrackScrubber((cursor) => {
      this._trackManager.renderAll(cursor)
      this._trackManager.renderAllTimelines(cursor)
      this._audioTrack?.renderTimeline(cursor)
      this._audioTrack?.sync(cursor, this._scrubber.isPlaying(), this._scrubber.getSpeed())
    })
    this._scrubber.attach()

    const addInput = document.getElementById('mt-add-track-input')

    this._trackManager = new TrackManager(this._tracksEl, {
      getMasterDuration: () => this._scrubber.getDuration(),
      seekMaster: (t) => this._scrubber.seek(t),
      markDirty: () => this._scrubber.refresh(),
      onCountChange: (count) => { addInput.disabled = count >= MAX_TRACKS },
      getMarkers: () => this._markers,
    })
    this._scrubber.setDurationSource(() => this._trackManager.maxDuration())
    this._scrubber.setFocusedTrackSource(() => this._trackManager.focusedTrack)
    this._scrubber.setMarkersSource(() => this._markers)

    addInput.addEventListener('change', (e) => {
      const file = e.target.files[0]
      if (!file) return
      e.target.value = ''
      this._loadTrackFile(file)
    })

    this._setupAudio()
    this._setupMarkers()

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

  // ── Stimulus audio ─────────────────────────────────────────────────────

  _setupAudio() {
    const addInput = document.getElementById('mt-add-music-input')
    const mount = document.getElementById('mt-audio-mount')

    addInput.addEventListener('change', async (e) => {
      const file = e.target.files[0]
      if (!file) return
      e.target.value = ''

      if (!this._audioTrack) {
        this._audioTrack = new AudioTrack({
          getMasterDuration: () => this._scrubber.getDuration(),
          seekMaster: (t) => this._scrubber.seek(t),
          markDirty: () => this._scrubber.refresh(),
          onRemove: () => this._removeAudio(),
          getMarkers: () => this._markers,
        })
        mount.appendChild(this._audioTrack.root)
      }
      await this._audioTrack.loadFile(file)
      this._scrubber.refresh()
    })
  }

  _removeAudio() {
    if (!this._audioTrack) return
    this._audioTrack.dispose()
    this._audioTrack = null
    this._scrubber.refresh()
  }

  // ── Markers ─────────────────────────────────────────────────────────────

  _setupMarkers() {
    this._markerLabelInput = document.getElementById('mt-marker-label-input')
    this._markerAddBtn     = document.getElementById('mt-marker-add-btn')
    this._markerMenu       = document.getElementById('mt-marker-menu')
    this._markerCountEl    = document.getElementById('mt-marker-count')
    this._markerListEl     = document.getElementById('mt-marker-list')

    const addFromInput = () => {
      const label = this._markerLabelInput.value.trim() || 'Marker'
      this._addMarker(this._scrubber.getCursor(), label)
      this._markerLabelInput.value = ''
    }
    this._markerAddBtn.addEventListener('click', addFromInput)
    this._markerLabelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addFromInput()
    })

    // "M" drops a default-labeled marker at the current cursor, immediately
    // editable in the list below — a quick way to mark a moment while
    // watching playback without breaking focus to type a label first.
    document.addEventListener('keydown', (e) => {
      if (!this._scrubber.isActive()) return
      if (e.target && /^(input|textarea)$/i.test(e.target.tagName)) return
      if (e.key === 'm' || e.key === 'M') this._addMarker(this._scrubber.getCursor(), 'Marker')
    })

    this._renderMarkerList()
  }

  _addMarker(t, label) {
    this._markers.push({ t, label })
    this._markers.sort((a, b) => a.t - b.t)
    this._onMarkersChanged()
  }

  _removeMarker(marker) {
    const i = this._markers.indexOf(marker)
    if (i === -1) return
    this._markers.splice(i, 1)
    this._onMarkersChanged()
  }

  _onMarkersChanged() {
    this._trackManager.notifyMarkersChanged()
    this._audioTrack?.notifyMarkersChanged()
    this._scrubber.refresh()
    this._renderMarkerList()
  }

  _renderMarkerList() {
    this._markerCountEl.textContent = `${this._markers.length}`
    this._markerListEl.innerHTML = ''
    if (!this._markers.length) {
      const empty = document.createElement('div')
      empty.className = 'mt-marker-empty'
      empty.textContent = 'No markers yet'
      this._markerListEl.appendChild(empty)
      return
    }
    for (const m of this._markers) {
      const row = document.createElement('div')
      row.className = 'mt-marker-item'

      const timeBtn = document.createElement('button')
      timeBtn.type = 'button'
      timeBtn.className = 'mt-marker-time scrub-btn'
      timeBtn.textContent = fmtTime(m.t)
      timeBtn.title = 'Jump to this marker'
      timeBtn.addEventListener('click', () => this._scrubber.seek(m.t))

      const labelInput = document.createElement('input')
      labelInput.type = 'text'
      labelInput.className = 'mt-marker-label-edit'
      labelInput.value = m.label
      labelInput.addEventListener('change', () => {
        m.label = labelInput.value.trim() || 'Marker'
        this._onMarkersChanged()
      })

      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'mt-marker-delete-btn controls-upload-btn'
      delBtn.textContent = '✕'
      delBtn.title = 'Delete this marker'
      delBtn.addEventListener('click', () => this._removeMarker(m))

      row.append(timeBtn, labelInput, delBtn)
      this._markerListEl.appendChild(row)
    }
  }
}

/** Seconds → MM:SS (or H:MM:SS past an hour) — same format as MultiTrackScrubber's. */
function fmtTime(s) {
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = m.toString().padStart(2, '0')
  const ss = sec.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
