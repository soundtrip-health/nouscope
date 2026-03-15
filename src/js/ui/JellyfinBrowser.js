/**
 * JellyfinBrowser
 *
 * Modal UI for connecting to a Jellyfin server and browsing/loading music.
 * Manages two views: login and library browser.
 *
 * @param {import('../managers/JellyfinManager').default} manager
 * @param {function(url: string, title: string): void} onTrackSelected
 */
export default class JellyfinBrowser {
  constructor(manager, onTrackSelected) {
    this._mgr             = manager
    this._onTrackSelected = onTrackSelected

    this._modal       = document.getElementById('jellyfin-modal')
    this._loginView   = document.getElementById('jellyfin-login')
    this._browserView = document.getElementById('jellyfin-browser')
    this._searchInput = document.getElementById('jellyfin-search')
    this._trackList   = document.getElementById('jellyfin-track-list')
    this._loadMoreBtn = document.getElementById('jellyfin-load-more')
    this._errorEl     = document.getElementById('jellyfin-login-error')

    this._debounceTimer = null
    this._startIndex    = 0
    this._totalCount    = 0

    this._bindEvents()
  }

  show() {
    this._modal.hidden = false
    if (this._mgr.isConnected) {
      this._showBrowser()
      this._loadItems(true)
    } else {
      this._showLogin()
    }
  }

  hide() {
    this._modal.hidden = true
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _showLogin() {
    this._loginView.hidden   = false
    this._browserView.hidden = true
  }

  _showBrowser() {
    this._loginView.hidden   = true
    this._browserView.hidden = false
  }

  _bindEvents() {
    // Close on × button or clicking the backdrop
    document.getElementById('jellyfin-close').addEventListener('click', () => this.hide())
    this._modal.addEventListener('click', (e) => { if (e.target === this._modal) this.hide() })

    // Auth type toggle (user/pass ↔ API key)
    const toggle     = document.getElementById('jellyfin-auth-toggle')
    const userPass   = document.getElementById('jellyfin-userpass')
    const apiKeyWrap = document.getElementById('jellyfin-apikey-wrap')
    toggle.addEventListener('change', () => {
      userPass.hidden   =  toggle.checked
      apiKeyWrap.hidden = !toggle.checked
    })

    // Login form
    document.getElementById('jellyfin-login-form').addEventListener('submit', (e) => {
      e.preventDefault()
      this._handleLogin()
    })

    // Disconnect
    document.getElementById('jellyfin-disconnect').addEventListener('click', () => {
      this._mgr.disconnect()
      this._trackList.innerHTML = ''
      this._showLogin()
    })

    // Search (debounced)
    this._searchInput.addEventListener('input', () => {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = setTimeout(() => this._loadItems(true), 300)
    })

    // Pagination
    this._loadMoreBtn.addEventListener('click', () => this._loadItems(false))
  }

  async _handleLogin() {
    const serverUrl = document.getElementById('jellyfin-server-url').value.trim()
    const useApiKey = document.getElementById('jellyfin-auth-toggle').checked
    const submitBtn = document.getElementById('jellyfin-submit')

    this._errorEl.textContent = ''
    submitBtn.disabled        = true
    submitBtn.textContent     = 'Connecting…'

    try {
      if (useApiKey) {
        const key = document.getElementById('jellyfin-api-key').value.trim()
        this._mgr.connectWithApiKey(serverUrl, key)
      } else {
        const username = document.getElementById('jellyfin-username').value.trim()
        const password = document.getElementById('jellyfin-password').value
        await this._mgr.authenticate(serverUrl, username, password)
      }
      this._showBrowser()
      this._loadItems(true)
    } catch (err) {
      this._errorEl.textContent = /fetch|network|CORS/i.test(err.message)
        ? 'Could not reach server. Check the URL and ensure Nouscope is allowed in your Jellyfin CORS settings.'
        : err.message
    } finally {
      submitBtn.disabled    = false
      submitBtn.textContent = 'Connect'
    }
  }

  async _loadItems(reset) {
    if (reset) {
      this._startIndex      = 0
      this._trackList.innerHTML = ''
      this._loadMoreBtn.hidden  = true
    }

    const searchTerm = this._searchInput.value.trim()
    this._loadMoreBtn.disabled = true

    try {
      const data = await this._mgr.getItems({ searchTerm, startIndex: this._startIndex })
      this._totalCount  = data.TotalRecordCount
      this._startIndex += data.Items.length
      this._renderItems(data.Items)
      this._loadMoreBtn.hidden   = this._startIndex >= this._totalCount
      this._loadMoreBtn.disabled = false
    } catch (err) {
      const li = document.createElement('li')
      li.className   = 'jellyfin-list-error'
      li.textContent = `Error: ${err.message}`
      this._trackList.appendChild(li)
    }
  }

  _renderItems(items) {
    for (const item of items) {
      const artist   = item.AlbumArtist || item.Artists?.[0] || ''
      const album    = item.Album || ''
      const duration = item.RunTimeTicks ? _fmtDuration(item.RunTimeTicks) : ''

      const li = document.createElement('li')
      li.className = 'jellyfin-track'

      const info = document.createElement('div')
      info.className = 'jellyfin-track-info'

      const titleEl = document.createElement('span')
      titleEl.className   = 'jellyfin-track-title'
      titleEl.textContent = item.Name

      const metaEl = document.createElement('span')
      metaEl.className   = 'jellyfin-track-meta'
      metaEl.textContent = artist + (album ? ' \u2014 ' + album : '')

      info.append(titleEl, metaEl)

      const dur = document.createElement('span')
      dur.className   = 'jellyfin-track-dur'
      dur.textContent = duration

      const btn = document.createElement('button')
      btn.className   = 'jellyfin-play-btn'
      btn.textContent = '▶'
      btn.title       = 'Load track'
      btn.addEventListener('click', () => {
        const url   = this._mgr.getStreamUrl(item.Id)
        const title = artist ? `${item.Name} — ${artist}` : item.Name
        this._onTrackSelected(url, title)
        this.hide()
      })

      li.append(info, dur, btn)
      this._trackList.appendChild(li)
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _fmtDuration(ticks) {
  const s = Math.floor(ticks / 10_000_000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
