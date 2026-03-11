const STORAGE_KEY = 'nouscope_jellyfin'
const CLIENT_INFO  = 'MediaBrowser Client="Nouscope", Device="Browser", DeviceId="nouscope-browser", Version="1.0.0"'
const PAGE_SIZE    = 50

/**
 * JellyfinManager
 *
 * Client-side Jellyfin API integration. Handles authentication (username/password
 * or API key), music library browsing, and stream URL generation. Credentials
 * (server URL + token) are persisted to localStorage; passwords are never stored.
 */
export default class JellyfinManager {
  constructor() {
    this.serverUrl = null
    this.token     = null
    this.userId    = null
    this._load()
  }

  get isConnected() {
    return !!(this.serverUrl && this.token)
  }

  /**
   * Authenticate with username + password.
   * Stores the returned access token (not the password).
   * @param {string} serverUrl  e.g. "http://192.168.1.100:8096"
   * @param {string} username
   * @param {string} password
   */
  async authenticate(serverUrl, username, password) {
    const base = serverUrl.replace(/\/$/, '')
    const res = await fetch(`${base}/Users/AuthenticateByName`, {
      method:  'POST',
      headers: {
        'Content-Type':        'application/json',
        'X-Emby-Authorization': `${CLIENT_INFO}, Token=""`,
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    })
    if (!res.ok) {
      throw new Error(res.status === 401 ? 'Invalid username or password.' : `Server error ${res.status}.`)
    }
    const data = await res.json()
    this.serverUrl = base
    this.token     = data.AccessToken
    this.userId    = data.User?.Id ?? null
    this._save()
  }

  /**
   * Connect using a pre-existing Jellyfin API key (no userId).
   * @param {string} serverUrl
   * @param {string} apiKey
   */
  connectWithApiKey(serverUrl, apiKey) {
    this.serverUrl = serverUrl.replace(/\/$/, '')
    this.token     = apiKey
    this.userId    = null
    this._save()
  }

  /** Clear credentials and remove from localStorage. */
  disconnect() {
    this.serverUrl = null
    this.token     = null
    this.userId    = null
    localStorage.removeItem(STORAGE_KEY)
  }

  /**
   * Fetch a page of audio items from the library.
   * @param {Object} opts
   * @param {string} [opts.searchTerm]
   * @param {string} [opts.sortBy]       default "SortName"
   * @param {number} [opts.startIndex]   default 0
   * @returns {Promise<{Items: Array, TotalRecordCount: number}>}
   */
  async getItems({ searchTerm = '', sortBy = 'SortName', startIndex = 0 } = {}) {
    const params = new URLSearchParams({
      IncludeItemTypes: 'Audio',
      Recursive:        'true',
      Fields:           'RunTimeTicks,AlbumArtist,Album,Artists',
      SortBy:           sortBy,
      SortOrder:        'Ascending',
      Limit:            String(PAGE_SIZE),
      StartIndex:       String(startIndex),
    })
    if (searchTerm) params.set('searchTerm', searchTerm)
    if (this.userId)  params.set('UserId', this.userId)

    const res = await fetch(`${this.serverUrl}/Items?${params}`, {
      headers: this._authHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch library: ${res.status}`)
    return res.json()
  }

  /**
   * Build a stream URL for an audio item.
   * The URL is passed directly to AudioManager.loadAudioBuffer().
   * @param {string} itemId
   * @returns {string}
   */
  getStreamUrl(itemId) {
    const params = new URLSearchParams({
      api_key:             this.token,
      Container:           'mp3,aac,ogg,flac,wav',
      MaxStreamingBitrate: '140000000',
    })
    if (this.userId) params.set('UserId', this.userId)
    return `${this.serverUrl}/Audio/${itemId}/universal?${params}`
  }

  _authHeaders() {
    return { 'X-Emby-Authorization': `${CLIENT_INFO}, Token="${this.token}"` }
  }

  _save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      serverUrl: this.serverUrl,
      token:     this.token,
      userId:    this.userId,
    }))
  }

  _load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
      if (data?.serverUrl && data?.token) {
        this.serverUrl = data.serverUrl
        this.token     = data.token
        this.userId    = data.userId ?? null
      }
    } catch {
      // ignore corrupt storage
    }
  }
}
