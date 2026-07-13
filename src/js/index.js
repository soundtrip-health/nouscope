import App from './App'
import MultiTrackApp from './MultiTrackApp'

;(() => {
  new App()
  window._App = App   // dev-only: console access to App.eegManager etc.

  const multiTrackApp = new MultiTrackApp()

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
    // Canvases laid out while this tab was hidden report zero size; App.js
    // already re-sizes them on 'resize', so just re-fire that event now
    // rather than reaching into its internals.
    window.dispatchEvent(new Event('resize'))
  }
  const showMultiTrack = () => {
    sessionView.hidden = true
    multiTrackView.hidden = false
    multiTrackApp.onShow()
  }

  viewSelect.addEventListener('change', () => {
    if (viewSelect.value === 'multitrack') showMultiTrack()
    else showSession()
  })
})()
