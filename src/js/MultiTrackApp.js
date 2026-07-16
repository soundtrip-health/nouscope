import TrackManager, { MAX_TRACKS } from './ui/TrackManager'
import MultiTrackScrubber from './ui/MultiTrackScrubber'
import AudioTrack, { AUDIO_TRACK_ID } from './ui/AudioTrack'
import { TRACK_ACCENT_VARS } from './ui/Track'
import { cssVar } from './ui/palette'
import { formatTime as fmtTime, parseTime } from './ui/formatTime'

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
 * - Markers (`this._markers`, `{t, label, color, trackIds}` in *master*-
 *   timeline seconds) are user-authored annotations ("music started here"),
 *   not session data — they live here, not on any `SessionStore`. A marker
 *   with `trackIds == null` is global (shown on every strip); one with an
 *   explicit `trackIds` array (each entry a track's own `id`, or
 *   `AUDIO_TRACK_ID`) shows only on those rows — so the same marker can cover
 *   e.g. two tracks but not a third or the audio row. The master transport
 *   always shows every marker (the full-session overview); each track/the
 *   audio row shows only the global ones plus any whose `trackIds` includes
 *   its own id.
 *
 *   Markers are only ever created/edited through `#mt-marker-modal` (see
 *   `_openMarkerModal`/`_saveMarkerFromModal`) — there is a single trigger,
 *   the master transport's "+ Marker" button (or the `M` shortcut), which
 *   opens it pre-filled with the current time and every track/audio row
 *   checked ("All tracks"); the user narrows the track set, picks a name and
 *   color, before saving. Tracks/the audio row have no add-marker control of
 *   their own — narrowing which rows a marker shows on happens entirely in
 *   the modal's checklist. Editing an existing marker (the popover list's ✎
 *   button) reopens the same modal pre-filled with its current fields and
 *   updates it in place on save.
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
    this._markerAddBtn  = document.getElementById('mt-marker-add-btn')
    this._markerMenu    = document.getElementById('mt-marker-menu')
    this._markerCountEl = document.getElementById('mt-marker-count')
    this._markerListEl  = document.getElementById('mt-marker-list')

    this._modalOverlay    = document.getElementById('mt-marker-modal-overlay')
    this._modalTitleEl    = document.getElementById('mt-marker-modal-title')
    this._modalNameInput  = document.getElementById('mt-marker-modal-name')
    this._modalTimeInput  = document.getElementById('mt-marker-modal-time')
    this._modalSwatchesEl = document.getElementById('mt-marker-modal-swatches')
    this._modalTracksEl   = document.getElementById('mt-marker-modal-tracks')
    const modalCancelBtn  = document.getElementById('mt-marker-modal-cancel-btn')
    const modalSaveBtn    = document.getElementById('mt-marker-modal-save-btn')
    this._editingMarker   = null   // the marker object being edited, or null while adding a new one

    // Resolved once here (not at module load — cssVar needs the stylesheet
    // already parsed, see palette.js) rather than hardcoded: neutral grey
    // first (the default new-marker color — see `_openMarkerModal`; grey
    // keeps the white "selected" ring visible, unlike white-on-white), then
    // blue, then each track's own accent, then the violet/salmon fallbacks
    // already used elsewhere for "no closer color to use" (timelineDecor.js
    // doc / AudioTrack.color), neutral text color last.
    this._markerColorSwatches = [
      cssVar('--marker-neutral'),
      cssVar('--band-theta'),
      ...TRACK_ACCENT_VARS.map(cssVar),
      cssVar('--band-delta'),
      cssVar('--ppg'),
      cssVar('--color-text'),
    ]

    this._markerAddBtn.addEventListener('click', () => {
      this._openMarkerModal({ t: this._scrubber.getCursor(), trackIds: null })
    })

    modalCancelBtn.addEventListener('click', () => this._closeMarkerModal())
    modalSaveBtn.addEventListener('click', () => this._saveMarkerFromModal())
    // Deliberately no backdrop-click-to-close (unlike ShortcutsModal) — a
    // marker's fields (name, track selection) are easy to lose to a stray
    // click just off the panel, so only an explicit Cancel/Escape/Save closes it.
    const submitOnEnter = (e) => { if (e.key === 'Enter') this._saveMarkerFromModal() }
    this._modalNameInput.addEventListener('keydown', submitOnEnter)
    this._modalTimeInput.addEventListener('keydown', submitOnEnter)

    // Escape closes the marker modal first if it's open, regardless of the
    // scrubber-active gating below (mirrors ShortcutsModal's own Escape
    // handling). "M" opens the modal at the current instant (global scope by
    // default) instead of adding anything directly — the user picks the
    // name/color/track set before it's actually created. "[" / "]" jump the
    // playhead to the previous/next marker (across every scope — global,
    // per-track, and audio-row alike), since `this._markers` is kept sorted
    // by `t` on every add.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this._modalOverlay.hidden) { this._closeMarkerModal(); return }
      if (!this._scrubber.isActive() || !this._scrubber.isVisible()) return
      if (e.target && /^(input|textarea)$/i.test(e.target.tagName)) return
      if (e.key === 'm' || e.key === 'M') this._openMarkerModal({ t: this._scrubber.getCursor(), trackIds: null })
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

  /** Rebuild the "All tracks" + per-track/audio-row checkbox list, checked according to `selectedIds` (null = all). */
  _buildTrackRows(selectedIds) {
    const container = this._modalTracksEl
    container.innerHTML = ''
    const isAll = selectedIds == null

    const allRow = document.createElement('label')
    allRow.className = 'mt-marker-modal-track-row'
    const allCheck = document.createElement('input')
    allCheck.type = 'checkbox'
    allCheck.checked = isAll
    allRow.append(allCheck, 'All tracks')
    container.appendChild(allRow)
    this._modalAllCheckbox = allCheck

    const entries = [
      ...this._trackManager.tracks.map(t => ({ id: t.id, label: t.label || 'Track', color: t.color })),
      ...(this._audioTrack ? [{ id: AUDIO_TRACK_ID, label: this._audioTrack.label || 'Music', color: this._audioTrack.color }] : []),
    ]
    this._modalTrackChecks = entries.map(({ id, label, color }) => {
      const row = document.createElement('label')
      row.className = 'mt-marker-modal-track-row'
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = isAll || selectedIds.includes(id)
      check.disabled = isAll
      const dot = document.createElement('span')
      dot.className = 'mt-marker-modal-track-dot'
      dot.style.background = color
      row.append(check, dot, label)
      container.appendChild(row)
      return { id, checkbox: check }
    })

    allCheck.addEventListener('change', () => {
      this._modalTrackChecks.forEach(({ checkbox }) => {
        checkbox.disabled = allCheck.checked
        if (allCheck.checked) checkbox.checked = true
      })
    })
  }

  /** Rebuild the color swatch row, marking `selectedColor` as active. */
  _buildSwatches(selectedColor) {
    const container = this._modalSwatchesEl
    container.innerHTML = ''
    this._modalColor = selectedColor
    for (const hex of this._markerColorSwatches) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mt-marker-modal-swatch'
      btn.style.background = hex
      if (hex === selectedColor) btn.classList.add('selected')
      btn.addEventListener('click', () => {
        this._modalColor = hex
        container.querySelectorAll('.mt-marker-modal-swatch').forEach(b => b.classList.remove('selected'))
        btn.classList.add('selected')
      })
      container.appendChild(btn)
    }
  }

  /**
   * Open the Add/Edit marker modal. `trackIds` (null = all tracks, or an
   * explicit array of track/audio-row ids) seeds which rows start checked;
   * pass `editing` (the marker being modified) to prefill name/color/time
   * from it and update it in place on save instead of creating a new one.
   */
  _openMarkerModal({ t, trackIds, label = '', editing = null }) {
    this._editingMarker = editing
    this._modalTitleEl.textContent = editing ? 'Edit marker' : 'Add marker'
    this._modalNameInput.value = label
    this._modalTimeInput.value = fmtTime(t)
    this._modalRawTime = t
    this._buildTrackRows(trackIds)
    this._buildSwatches(editing?.color ?? this._markerColorSwatches[0])
    this._modalOverlay.hidden = false
    this._modalNameInput.focus()
    this._modalNameInput.select()
  }

  _closeMarkerModal() {
    this._modalOverlay.hidden = true
    this._editingMarker = null
  }

  /** Validate the modal's fields and create/update the marker; silently no-ops (like before) if the name or track selection is empty. */
  _saveMarkerFromModal() {
    const label = this._modalNameInput.value.trim()
    if (!label) { this._modalNameInput.focus(); return }

    const parsed = parseTime(this._modalTimeInput.value)
    const t = parsed != null ? Math.max(0, Math.min(this._scrubber.getDuration(), parsed)) : this._modalRawTime

    const trackIds = this._modalAllCheckbox.checked
      ? null
      : this._modalTrackChecks.filter(({ checkbox }) => checkbox.checked).map(({ id }) => id)
    if (trackIds && trackIds.length === 0) return   // nothing selected — same silent no-op as a missing name

    const color = this._modalColor

    if (this._editingMarker) Object.assign(this._editingMarker, { t, label, color, trackIds })
    else this._markers.push({ t, label, color, trackIds })
    this._markers.sort((a, b) => a.t - b.t)

    this._closeMarkerModal()
    this._onMarkersChanged()
  }

  _removeMarker(marker) {
    const i = this._markers.indexOf(marker)
    if (i === -1) return
    this._markers.splice(i, 1)
    this._onMarkersChanged()
  }

  /** Drop a removed track/audio row from every marker's `trackIds`, dropping the marker itself if that empties it. Global markers (`trackIds == null`) are never affected. */
  _pruneMarkersForScope(trackId) {
    let changed = false
    this._markers = this._markers.filter(m => {
      if (m.trackIds == null || !m.trackIds.includes(trackId)) return true
      m.trackIds = m.trackIds.filter(id => id !== trackId)
      changed = true
      return m.trackIds.length > 0
    })
    if (changed) this._onMarkersChanged()
  }

  /** Human-readable scope label for the markers popover — "All" or the owning track/audio row label(s), comma-joined. */
  _scopeLabel(trackIds) {
    if (trackIds == null) return 'All'
    if (!trackIds.length) return '—'
    return trackIds.map(id => id === AUDIO_TRACK_ID
      ? (this._audioTrack?.label || 'Music')
      : (this._trackManager.tracks.find(t => t.id === id)?.label || 'Track')
    ).join(', ')
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

      const dot = document.createElement('span')
      dot.className = 'mt-marker-color-dot'
      dot.style.background = m.color

      const timeBtn = document.createElement('button')
      timeBtn.type = 'button'
      timeBtn.className = 'mt-marker-time scrub-btn'
      timeBtn.textContent = fmtTime(m.t)
      timeBtn.title = 'Jump to this marker'
      timeBtn.addEventListener('click', () => this._scrubber.seek(m.t))

      const nameEl = document.createElement('span')
      nameEl.className = 'mt-marker-name'
      nameEl.textContent = m.label
      nameEl.title = m.label

      const scopeLabel = this._scopeLabel(m.trackIds)
      const scopeEl = document.createElement('span')
      scopeEl.className = 'mt-marker-scope'
      scopeEl.textContent = scopeLabel
      scopeEl.title = m.trackIds == null ? 'Shown on every track' : `Shown on: ${scopeLabel}`

      const editBtn = document.createElement('button')
      editBtn.type = 'button'
      editBtn.className = 'mt-marker-edit-btn controls-upload-btn'
      editBtn.textContent = '✎'
      editBtn.title = 'Edit this marker'
      editBtn.addEventListener('click', () => this._openMarkerModal({ t: m.t, trackIds: m.trackIds, label: m.label, editing: m }))

      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'mt-marker-delete-btn controls-upload-btn'
      delBtn.textContent = '✕'
      delBtn.title = 'Delete this marker'
      delBtn.addEventListener('click', () => this._removeMarker(m))

      row.append(dot, timeBtn, nameEl, scopeEl, editBtn, delBtn)
      this._markerListEl.appendChild(row)
    }
  }
}
