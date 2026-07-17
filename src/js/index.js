import App from './App'
import MultiTrackApp from './MultiTrackApp'
import ShortcutsModal from './ui/ShortcutsModal'

;(() => {
  const app = new App()
  window._App = App   // dev-only: console access to App.eegManager etc.

  const multiTrackApp = new MultiTrackApp()
  new ShortcutsModal()

  // View switcher: two fully independent views, #session-view (the original
  // single-session app) and #multitrack-view (file-review only). Switching
  // never tears anything down — each view keeps running underneath; this
  // just toggles which one is visible.
  const sessionView = document.getElementById('session-view')
  const multiTrackView = document.getElementById('multitrack-view')
  const viewSelect = document.getElementById('view-select')

  const showSession = () => {
    sessionView.hidden = false
    multiTrackView.hidden = true
    // Stop the multi-track transport (and pause its synced audio) — its render
    // loop should not keep running against a hidden tab.
    multiTrackApp.onHide()
    // Give the single-session view its WebGL contexts back (freed while the
    // Multi-Track tab was shown) and re-size them now that it's visible again.
    app.resumeAnalysis()
    window.dispatchEvent(new Event('resize'))
  }
  const showMultiTrack = () => {
    sessionView.hidden = true
    multiTrackView.hidden = false
    // Free the single-session view's 5 WebGL contexts so the Multi-Track tab
    // can use its full panel budget without blowing the browser's context limit.
    app.suspendAnalysis()
    multiTrackApp.onShow()
  }

  viewSelect.addEventListener('change', () => {
    if (viewSelect.value === 'multitrack') showMultiTrack()
    else showSession()
  })
})()
