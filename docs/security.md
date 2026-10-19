# Security

Scope: the public static site https://nouscope.org and its build. See [`architecture.md`](architecture.md) for the data flow. Last reviewed 2026-10-18 at `e9af118`.

## Assets

1. **Visitors' biometric data**: EEG, PPG/heart rate and IMU streamed from their headset, plus any `.jsonl` recordings they load. It lives only in the browser tab. It is health-class data even though it never reaches our server.
2. **Device and browser permissions**: a granted Web Bluetooth connection to the Muse, the microphone (`getUserMedia`), and File System Access write handles for recordings.
3. **Integrity of the shipped JS**: whatever `dist/` contains runs with access to items 1 and 2 on every visitor's machine.
4. **The host**: `server.js` runs as `bobd` on solaris. It holds no secrets, sessions or server-side data.

## Threats

| Threat | Notes |
|---|---|
| Supply chain | All dependencies run in-page with full access to the session. The highest-risk one is `muse-js`, a **git fork** (`package.json:33`, `github:soundtrip-health/muse-js#muse3`). The lockfile pins it to commit `b98abbb9…` (`package-lock.json:1321`), but the `#muse3` branch spec means `npm install` (not `npm ci`) silently moves to the branch head. Others: `three`, `rxjs`, `webgl-plot`, `web-audio-beat-detector`, and build-time `vite`/`sass`. |
| Third-party runtime code | `src/scss/includes/base.scss:2` imports `https://use.typekit.net/rsf5rhz.css` on every page load. It is CSS only, but Adobe sees every visitor's IP address and referrer. Without a CSP we can't restrict what that origin serves. |
| XSS leading to sensor and permission abuse | Script injected into the origin could read live EEG/PPG, call `requestDevice` and `getUserMedia` (user-gesture and permission prompts still apply), read loaded recordings, and send all of it off-site. Inputs are local files only (`.jsonl` and audio). `SessionStore.loadFromText` (`SessionStore.js:544`) parses records with `JSON.parse`. Labels from file names and markers are set with `textContent`. The `innerHTML` templates (`Track.js:122`, `Track.js:239`, `AudioTrack.js:71`) interpolate only constants. **No injection path was found.** |
| Missing security headers | `server.js:73-77` sets only `Content-Type`, `Cache-Control` and `ETag`. There is no CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` or framing control, so the site can be framed (clickjacking the Connect/permission UI) and any future XSS is unconstrained. HSTS and TLS come from Cloudflare. |
| Dev server exposure | `vite.config.js:21` `host: true` binds `npm run dev` to `0.0.0.0`, so the source tree and the HMR socket are reachable on the LAN or tailnet, and `allowedHosts` (`:22`) admits `nouscope.org`. |
| Unreproducible deploy | The live `dist/` doesn't match any commit, so the code we serve can't be reviewed. |
| Static server bugs | Path traversal is blocked (`server.js:60`, a resolved-path prefix check), only GET and HEAD are allowed, and it binds to loopback (`server.js:23`). The remaining risk is low. |

## Mitigations in place

- No backend, accounts, cookies, analytics or telemetry. Biometric data stays in the tab unless the user saves it.
- Web Bluetooth and the microphone require a secure context and an explicit user choice in the browser's chooser or permission prompt.
- Loopback bind and a single tunnel ingress. Nothing is listening publicly.
- `server.js` has no dependencies and refuses paths outside `dist/`. Production builds ship without source maps.
- Lockfile pins exact versions and the muse-js commit.
- Research recordings in `analysis/data/` are gitignored.

## Open risks

| # | Sev | Risk | Where | Suggested fix |
|---|---|---|---|---|
| 1 | M | No security headers, so no CSP and no frame protection | `server.js:73-77` | Add `Content-Security-Policy` (`default-src 'self'; style-src 'self' https://use.typekit.net 'unsafe-inline'; font-src https://use.typekit.net; img-src 'self' data: https://p.typekit.net; frame-ancestors 'none'`; the inline `<script>` and `onclick` in `index.html:23-25` and `:61` need hashes or removal), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy: bluetooth=(self), microphone=(self), camera=(), geolocation=()`. Alternatively, set them with a Cloudflare response-header rule. |
| 2 | M | Git-fork dependency has no review or update process | `package.json:33`, `package-lock.json:1321` | Pin to the commit sha in `package.json`, not `#muse3`. Always deploy with `npm ci`. Review the fork's diffs before bumping it. Consider vendoring it or publishing a tagged release. |
| 3 | M | Deployed `dist/` ≠ any commit | live checkout `dist/` | Build from a clean commit and record the sha (`deployment.md`). |
| 4 | L | Typekit is a third-party request on every visit, which leaks visitor IP and referrer to Adobe | `src/scss/includes/base.scss:2` | Self-host the fonts (if the licence allows) or accept it and document it in the privacy notice. |
| 5 | L | Dev server binds to all interfaces and allows the production hostname | `vite.config.js:21-22` | Make `host: true` opt-in (`vite --host` when testing on mobile) and drop `nouscope.org` from `allowedHosts`. |
| 6 | L | `server.js` runs as the interactive user in tmux, not a supervised, sandboxed service | host | Run it as a systemd unit under a dedicated user with read-only access to `dist/` (see IT `standards/`). |
| 7 | Info | `npm ci` fetches muse-js over `git+ssh`, so a deploy host needs a GitHub SSH key | `package-lock.json:1321` | Use an HTTPS tarball URL for the pinned commit. |
