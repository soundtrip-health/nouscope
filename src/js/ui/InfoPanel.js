/**
 * InfoPanel — the landing / about panel (`#info-overlay` in index.html).
 *
 * One panel, two roles. On a fresh page it is the landing content: open by
 * default over the otherwise-empty black viewport, describing the project and
 * how to use it. The moment a session comes up (EEG connect or a loaded
 * `.jsonl` — see App._showPanel) it is dismissed, and the small "i" toggle in
 * the top-left corner reopens it as a semi-transparent overlay on whichever
 * renderer is active (panel grid or helix).
 *
 * The overlay wrapper is pointer-transparent (see _info.scss), so the controls
 * bar and scrubber stay usable while it's open — closing happens via the ✕
 * button, the "i" toggle, or Escape, not a backdrop click.
 */
export default class InfoPanel {
  constructor() {
    this._overlay = document.getElementById('info-overlay')
    this._toggle = document.getElementById('info-toggle')

    this._toggle.addEventListener('click', () => this.toggle())
    document.getElementById('info-close-btn').addEventListener('click', () => this.close())
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close()
    })

    // Landing mode: visible until a session starts.
    this.open()
  }

  get isOpen() { return !this._overlay.hidden }

  open() {
    this._overlay.hidden = false
    this._toggle.classList.add('active')
  }

  close() {
    this._overlay.hidden = true
    this._toggle.classList.remove('active')
  }

  toggle() {
    if (this.isOpen) this.close()
    else this.open()
  }
}
