import TrackManager, { MAX_TRACKS } from './ui/TrackManager'
import MultiTrackScrubber from './ui/MultiTrackScrubber'
import AudioTrack, { AUDIO_TRACK_ID } from './ui/AudioTrack'
import { formatTime as fmtTime } from './ui/formatTime'

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
 * - Markers (`this._markers`, `{t, label, trackId}` in *master*-timeline
 *   seconds) are user-authored annotations ("music started here"), not
 *   session data — they live here, not on any `SessionStore`. A marker with
 *   `trackId == null` is global (shown on every strip); one scoped to a
 *   specific track's `id` (or `AUDIO_TRACK_ID`) shows only there — added via
 *   that row's own "+ Marker" button, vs. the master "+ Marker"/`M` shortcut
 *   for global ones. The master transport always shows every marker (the
 *   full-session overview); each track/the audio row shows only the global
 *   ones plus its own.
 *
 *   Markers can't be added without a name: every "+ Marker" trigger (the
 *   master button, a track/audio row's own button, or the `M` shortcut) only
 *   *queues* `this._pendingMarker` — `{t, trackId}` at the moment it was
 *   triggered — and focuses the shared label input; the marker itself is only
 *   created once that input actually holds a non-empty label and gets
 *   submitted (Enter, or the master button again). Queuing the *time* up
 *   front (rather than at submission) keeps `M`'s original point — mark this
 *   exact instant, then name it — even though naming is no longer optional.
 *
 *   `[` / `]` seek the playhead to the nearest marker before/after the
 *   cursor, across every scope — see `_jumpMarker`.
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
      onAddMarker: (trackId) => this._queueMarker(trackId),
      onTrackRemoved: (trackId) => this._pruneMarkersForScope(trackId),
    })
    // Master duration must cover both the loaded .jsonl tracks and the
    // separately-loaded stimulus audio (same offset convention as
    // TrackManager.maxDuration — see there), so an audio-only session (no
    // data track) can still play, and a track's data can't truncate a
    // longer audio file's tail.
    this._scrubber.setDurationSource(() => Math.max(
      this._trackManager.maxDuration(),
      this._audioTrack ? this._audioTrack.duration() - this._audioTrack.offsetSeconds : 0,
    ))
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
          onAddMarker: () => this._queueMarker(AUDIO_TRACK_ID),
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
    this._pruneMarkersForScope(AUDIO_TRACK_ID)
    this._scrubber.refresh()
  }

  // ── Markers ─────────────────────────────────────────────────────────────

  _setupMarkers() {
    this._markerLabelInput = document.getElementById('mt-marker-label-input')
    this._markerAddBtn     = document.getElementById('mt-marker-add-btn')
    this._markerMenu       = document.getElementById('mt-marker-menu')
    this._markerCountEl    = document.getElementById('mt-marker-count')
    this._markerListEl     = document.getElementById('mt-marker-list')
    this._pendingMarker    = null   // {t, trackId} queued by a "+ Marker" trigger, waiting on a name

    // The master button always means "a global marker, right now" — it
    // discards any track/audio row's pending scope rather than inheriting it,
    // since clicking this specific button is an explicit, independent choice.
    this._markerAddBtn.addEventListener('click', () => {
      this._commitMarker({ t: this._scrubber.getCursor(), trackId: null })
    })
    // Enter finalizes whatever's currently queued (a track/audio row's own
    // button, or `M`) — or a fresh global one if nothing was queued, so
    // typing straight into the field without pressing a button first still works.
    this._markerLabelInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      this._commitMarker(this._pendingMarker ?? { t: this._scrubber.getCursor(), trackId: null })
    })

    // "M" queues the current instant (global scope) and focuses the label
    // input — markers can't be added without a name, but capturing the *time*
    // up front still lets you mark an exact moment while watching playback
    // and only stop to type the name a beat later.
    // "[" / "]" jump the playhead to the previous/next marker (across every
    // scope — global, per-track, and audio-row alike), since `this._markers`
    // is kept sorted by `t` on every add.
    document.addEventListener('keydown', (e) => {
      if (!this._scrubber.isActive() || !this._scrubber.isVisible()) return
      if (e.target && /^(input|textarea)$/i.test(e.target.tagName)) return
      if (e.key === 'm' || e.key === 'M') this._queueMarker(null)
      else if (e.key === '[') this._jumpMarker(-1)
      else if (e.key === ']') this._jumpMarker(1)
    })

    this._renderMarkerList()
  }

  /** Seek to the nearest marker before (-1) or after (+1) the current playhead, if any. */
  _jumpMarker(dir) {
    if (!this._markers.length) return
    const cursor = this._scrubber.getCursor()
    const EPS = 0.05   // ignore a marker sitting right at the cursor already
    const target = dir < 0
      ? [...this._markers].reverse().find(m => m.t < cursor - EPS)
      : this._markers.find(m => m.t > cursor + EPS)
    if (target) this._scrubber.seek(target.t)
  }

  /** Queue a marker at the current playhead, scoped to `trackId`, and focus the label input to name it. */
  _queueMarker(trackId) {
    this._pendingMarker = { t: this._scrubber.getCursor(), trackId }
    this._markerLabelInput.focus()
    this._markerLabelInput.select()
  }

  /** Add `scope` as a marker if the label input actually holds a name; otherwise just focus it. */
  _commitMarker(scope) {
    const label = this._markerLabelInput.value.trim()
    if (!label) { this._markerLabelInput.focus(); return }
    this._markers.push({ t: scope.t, label, trackId: scope.trackId })
    this._markers.sort((a, b) => a.t - b.t)
    this._markerLabelInput.value = ''
    this._pendingMarker = null
    this._onMarkersChanged()
  }

  _removeMarker(marker) {
    const i = this._markers.indexOf(marker)
    if (i === -1) return
    this._markers.splice(i, 1)
    this._onMarkersChanged()
  }

  /** Drop any markers scoped to a track/audio row that no longer exists. */
  _pruneMarkersForScope(trackId) {
    const before = this._markers.length
    this._markers = this._markers.filter(m => m.trackId !== trackId)
    if (this._markers.length !== before) this._onMarkersChanged()
  }

  /** Human-readable scope label for the markers popover — "All" or the owning track/audio row's current label. */
  _scopeLabel(trackId) {
    if (trackId == null) return 'All'
    if (trackId === AUDIO_TRACK_ID) return this._audioTrack?.label || 'Audio'
    return this._trackManager.tracks.find(t => t.id === trackId)?.label || 'Track'
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

      const scopeEl = document.createElement('span')
      scopeEl.className = 'mt-marker-scope'
      scopeEl.textContent = this._scopeLabel(m.trackId)
      scopeEl.title = m.trackId == null ? 'Shown on every track' : 'Shown on this track/audio row only'

      const labelInput = document.createElement('input')
      labelInput.type = 'text'
      labelInput.className = 'mt-marker-label-edit'
      labelInput.value = m.label
      labelInput.addEventListener('change', () => {
        // Renaming can't clear a marker's name either — revert instead of
        // falling back to some generic placeholder, which would just be an
        // unnamed marker by another name.
        const next = labelInput.value.trim()
        if (!next) { labelInput.value = m.label; return }
        m.label = next
        this._onMarkersChanged()
      })

      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'mt-marker-delete-btn controls-upload-btn'
      delBtn.textContent = '✕'
      delBtn.title = 'Delete this marker'
      delBtn.addEventListener('click', () => this._removeMarker(m))

      row.append(timeBtn, scopeEl, labelInput, delBtn)
      this._markerListEl.appendChild(row)
    }
  }
}
