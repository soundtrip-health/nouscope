import App from './App'
import MultiTrackApp from './MultiTrackApp'

;(() => {
  new App()
  window._App = App   // dev-only: console access to App.eegManager etc.

  const multiTrackApp = new MultiTrackApp()

  // Tab switcher: two fully independent views, #session-view (the original
  // single-session app) and #multitrack-view (file-review only). Switching
  // never tears anything down — each view keeps running underneath; this
  // just toggles which one is visible.
  const sessionView = document.getElementById('session-view')
  const multiTrackView = document.getElementById('multitrack-view')
  const tabSession = document.getElementById('tab-session')
  const tabMultiTrack = document.getElementById('tab-multitrack')

  const showSession = () => {
    sessionView.hidden = false
    multiTrackView.hidden = true
    tabSession.classList.add('active')
    tabMultiTrack.classList.remove('active')
    // Canvases laid out while this tab was hidden report zero size; App.js
    // already re-sizes them on 'resize', so just re-fire that event now
    // rather than reaching into its internals.
    window.dispatchEvent(new Event('resize'))
  }
  const showMultiTrack = () => {
    sessionView.hidden = true
    multiTrackView.hidden = false
    tabMultiTrack.classList.add('active')
    tabSession.classList.remove('active')
    multiTrackApp.onShow()
  }

  tabSession.addEventListener('click', showSession)
  tabMultiTrack.addEventListener('click', showMultiTrack)
})()
