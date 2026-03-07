import App from './App'
;(() => {
  new App()
  window._App = App   // dev-only: console access to App.eegManager etc.
})()
