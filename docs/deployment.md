# Deployment

Production is https://nouscope.org on host `solaris`. It is a static build served by `server.js` on loopback and published through the shared Cloudflare tunnel, with no Cloudflare Access because the site is public and static. Host-side details are in the IT repo (`it/apps/nouscope.md`, `it/runbooks/cloudflare-tunnel.md`).

## Build and serve

```bash
git status --short                 # must be clean; deploy a commit, not a working tree
git rev-parse --short HEAD         # note the sha you are deploying
npm ci                             # lockfile install (muse-js comes from a git fork over SSH)
npm run build                      # vite build → dist/
npm start                          # node server.js → http://127.0.0.1:8080
```

- `server.js` binds `127.0.0.1:8080` by default. `HOST` and `PORT` override it. Keep `HOST` on loopback, because cloudflared runs on the same host and nothing else needs to reach the port.
- It serves only files under `dist/`, for GET and HEAD only. Hashed `/assets/*` files are cached as immutable for a year, and everything else (`index.html`) is `no-cache`. A new build is therefore picked up by browsers right away, and the Cloudflare edge never mixes stale and fresh modules.
- `server.js` has no dependencies and serves whatever is in `dist/` at request time. Rebuilding while it runs takes effect immediately and needs no restart. During the rebuild, though, `dist/` is briefly incomplete.
- On solaris it currently runs as `bobd` in tmux window `webapps:nouscope`.

## Tunnel

The ingress for `nouscope.org` is `http://localhost:8080`, configured in the Cloudflare dashboard. Only port 8080 (`server.js`) may be the tunnel target.

**Never tunnel the Vite dev server (`npm run dev`).** It serves raw source modules at stable `.js` URLs, which Cloudflare's edge caches by extension, so visitors end up with stale code. It also binds to every interface (`host: true` in `vite.config.js`) and exposes the dev tooling and source tree. `allowedHosts: ["nouscope.org"]` in `vite.config.js` exists only for ad-hoc testing and must not be read as permission to tunnel it.

## Deployed build must match a commit

Build `dist/` from a clean, committed checkout of `main` (or a tagged commit) and record the sha. For example, write it to the deploy log in the IT repo, or check with `git describe --always --dirty` before building. A `dist/` built from uncommitted or feature-branch work cannot be reproduced or audited. As of 2026-10-18 the live `dist/` (built 2026-09-07) does not correspond to any commit.

Prefer building in a separate clean checkout or worktree over the live development checkout. Feature work then can't leak into production, and production can be rebuilt without stashing someone's changes.

## Rollback

Check out the previous good commit in the deploy checkout, then run `npm ci && npm run build`. No restart is needed.
