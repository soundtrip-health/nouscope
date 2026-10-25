# Deployment

Production is https://nouscope.org on host `solaris`. It is a static build served by `server.js` on loopback and published through the shared Cloudflare tunnel, with no Cloudflare Access because the site is public and static. Host-side details are in the IT repo (`it/apps/nouscope.md`, `it/runbooks/cloudflare-tunnel.md`).

## Build and serve (container, since 2026-10)

Production runs as a hardened container built from a commit. The live checkout is never used:

```bash
~/git/it/bin/deploy nouscope                 # deploy origin/main
~/git/it/bin/deploy nouscope --ref <sha>     # or any committed ref
~/git/it/bin/deploy nouscope --rollback      # back to the previous build
~/git/it/bin/status                          # running sha vs origin/main
```

- `Dockerfile`: the build stage runs `npm ci && npm run build`. muse-js, a public fork, is fetched over https, so no SSH keys are needed. The runtime stage is `node:22-bookworm-slim` holding only `server.js`, `package.json` and `dist/`. It runs as `node`, and both base images are pinned by digest.
- `compose.prod.yml` applies the hardening: read-only rootfs, all capabilities dropped, `no-new-privileges`, pids/mem/cpu limits, and `127.0.0.1:8080` only. The `sol-nouscope` bridge puts the app under the host's egress rules, so no private-network egress is possible. The baseline is in `it/standards/container.md`.
- `bin/deploy` works through these steps:
  1. `git archive`s the commit into a clean build tree.
  2. Builds `nouscope:<sha12>`, labelled with the full sha.
  3. Starts it and waits for the healthcheck.
  4. Rolls back automatically if the healthcheck fails.
  5. Logs to `it/logs/deploys.log`.
  A deploy takes a few seconds once the image is cached.
- `server.js` itself is unchanged. It binds `HOST`/`PORT`, which the image sets to `0.0.0.0:8080` inside the container, so it is reachable only through the loopback port mapping.

## Dev

`~/git/it/bin/dev nouscope` runs Vite with hot reload from `compose.dev.yml`. It mounts the live checkout, with `.git` read-only. Its `node_modules` is built in the container under `~/.local/state/solaris/nouscope/dev-cache`, so npm install scripts never run on the host. It is published on the tailnet IP only, at `http://100.121.203.40:5173`.

Web Bluetooth and the microphone need a secure context. For headset work, open `http://localhost:5173` through `ssh -L 5173:100.121.203.40:5173 solaris`. Stop it with `bin/dev nouscope down`.

## Tunnel

The ingress for `nouscope.org` is `http://localhost:8080`, configured in the Cloudflare dashboard. Only port 8080 (`server.js`) may be the tunnel target.

**Never tunnel the Vite dev server (`npm run dev`).** It serves raw source modules at stable `.js` URLs, which Cloudflare's edge caches by extension, so visitors end up with stale code. It also binds to every interface (`host: true` in `vite.config.js`) and exposes the dev tooling and source tree. `allowedHosts: ["nouscope.org"]` in `vite.config.js` exists only for ad-hoc testing and must not be read as permission to tunnel it.

## Deployed build must match a commit

`bin/deploy` enforces this. It builds only committed refs and labels the image with the sha (`docker inspect nouscope-web-1`). `bin/status` warns if the sha that is running is behind `origin/main`.

## Rollback

Run `~/git/it/bin/deploy nouscope --rollback`. It also happens automatically when a deploy fails its health check.
