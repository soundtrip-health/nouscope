/**
 * ShortcutsModal — the shared keyboard-shortcuts reference dialog.
 *
 * One instance, opened from either tab's own "?" transport button
 * (`#scrub-shortcuts-btn` / `#mt-scrub-shortcuts-btn` — see index.html/
 * index.js). The dialog itself is tab-agnostic: it always lists every
 * shortcut from both tabs, since the shortcuts are memorized independent of
 * which tab happens to be open at the moment.
 */
export default class ShortcutsModal {
  constructor() {
    this._overlay = document.getElementById('shortcuts-overlay')
    this._closeBtn = document.getElementById('shortcuts-close-btn')

    const openBtns = [
      document.getElementById('scrub-shortcuts-btn'),
      document.getElementById('mt-scrub-shortcuts-btn'),
    ]
    openBtns.forEach(btn => btn?.addEventListener('click', () => this.open()))

    this._closeBtn.addEventListener('click', () => this.close())
    // Clicking the dimmed backdrop closes it; clicking inside the modal itself
    // must not, so only a click whose target *is* the overlay (not something
    // it bubbled up from) counts.
    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) this.close()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this._overlay.hidden) this.close()
    })
  }

  open() { this._overlay.hidden = false }
  close() { this._overlay.hidden = true }
}
