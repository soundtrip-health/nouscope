# syntax=docker/dockerfile:1
# nouscope prod image: Vite build baked into a minimal non-root runtime.
# Built by ~/git/it/bin/deploy from a clean `git archive` of a commit. See docs/deployment.md.

# --- build: full image (has git, for the muse-js GitHub dependency) ---
FROM node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 AS build
WORKDIR /src
# The lockfile pins muse-js as git+ssh; it is a public repo, so fetch it over https (no keys in the build).
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# --- runtime: server.js has zero dependencies, so no node_modules here ---
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/soundtrip-health/nouscope" \
      org.opencontainers.image.revision="${GIT_SHA}"
WORKDIR /app
COPY --chown=root:root package.json server.js ./
COPY --chown=root:root --from=build /src/dist ./dist
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
