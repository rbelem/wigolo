# syntax=docker/dockerfile:1

# =============================================================================
# wigolo container image — two build targets:
#   default (slim): OS libraries for the browser engine baked at build time;
#                   the browser binary and on-device models download on FIRST USE
#                   into the /data volume. Smallest image; ideal for MCP stdio use.
#   full:           browser binary preinstalled at build time. Larger image;
#                   ideal for JS-render-heavy or ephemeral `--rm` runs with no
#                   persistent volume.
# Build the default target:  docker build --target default -t wigolo .
# Build the full target:     docker build --target full    -t wigolo:full .
#
# Base: oven/bun:1.4.5-slim is Debian 13 trixie. It ships a `bun` user (uid 1000)
# and a `node` symlink to Bun; every command here invokes Bun explicitly.
# =============================================================================

# ---- builder: compile TypeScript to dist/ ----
FROM oven/bun:1.4.5-slim AS builder
WORKDIR /app
# better-sqlite3 v12 has no prebuild for Bun's reported Node version, so its
# install falls back to node-gyp. Keep Python and a C++ compiler in the install
# stages only; the runtime stages do not carry them.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# onnxruntime-node reads this env var directly in its install script. Bun does
# not export the .npmrc key as npm_config_*, so set it here to skip CUDA blobs.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- deps: install production node_modules once, shared by both targets ----
FROM oven/bun:1.4.5-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json bun.lock ./
RUN bun install --production

# ---- base: shared runtime layout with the browser engine's OS libraries baked ----
# `playwright install-deps chromium` installs the OS shared libraries the browser
# engine needs (deps ONLY, NOT the browser binary) as ROOT at build time. Without
# them, a first-use lazy install as the non-root `bun` user cannot add system
# libs (no passwordless sudo) and the browser-engine launch smoke-test fails,
# degrading that tier permanently. With them baked, the lazy path works: the first
# JS-render fetch downloads only the browser binary into the /data volume and
# launches cleanly.
#
# No sudo in the image: the first-use deps-strategy probe treats its absence as
# the 'skip' strategy (the baked libraries make the deps step unnecessary anyway).
# No python either — it is only needed by the opt-in search-engine sidecar, and
# doctor's runtime check is scoped to that backend.
# Start from a CLEAN slim base (not `FROM deps`) so node_modules lands in the
# image exactly once, via a single --chown COPY. `FROM deps` + a second COPY +
# `chown -R /app` would triplicate the ~750MB node_modules tree.
FROM oven/bun:1.4.5-slim AS base
ENV NODE_ENV=production \
    WIGOLO_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/data/browsers
WORKDIR /app
# --chown at copy time avoids a costly `chown -R` layer that would duplicate the
# whole node_modules tree.
COPY --chown=bun:bun --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun --from=builder /app/dist ./dist
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun skills/ ./skills/
# Bake the browser engine's OS libraries via the LOCAL playwright CLI (already in
# node_modules) so the version matches the runtime and no throwaway playwright is
# downloaded. install-deps runs apt-get itself (we are root at build time).
RUN bun ./node_modules/playwright/cli.js install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Writable location for the local cache, on-device models, browser binary, and
# encrypted keys. The volume persists all of these across container runs.
RUN mkdir -p /data/browsers && chown bun:bun /data /data/browsers
VOLUME ["/data"]

# stdio MCP server by default. No image-level HEALTHCHECK: the default command
# speaks the stdio MCP protocol and exposes no HTTP endpoint, so a baked
# healthcheck would mark every container permanently unhealthy. For `serve` mode
# use packaging/compose.serve.yml, which adds a daemon HTTP healthcheck.
ENTRYPOINT ["bun", "dist/index.js"]
CMD ["mcp"]

# ---- default: slim image, browser binary + models download on first use ----
FROM base AS default
LABEL org.opencontainers.image.title="wigolo" \
      org.opencontainers.image.description="Local-first web intelligence MCP server. The browser engine binary and on-device models download on first use into the /data volume." \
      org.opencontainers.image.source="https://github.com/KnockOutEZ/wigolo"
USER bun

# ---- full: browser binary preinstalled at build for --rm / no-volume use ----
FROM base AS full
LABEL org.opencontainers.image.title="wigolo" \
      org.opencontainers.image.description="Local-first web intelligence MCP server with the browser engine preinstalled. On-device models download on first use." \
      org.opencontainers.image.source="https://github.com/KnockOutEZ/wigolo"
# Preinstall the browser binary into an image-baked path (not the volume) so
# JS-render works with no first-use download and no volume. Installed as root,
# then made readable by the bun user.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
RUN mkdir -p /opt/browsers \
    && bun ./node_modules/playwright/cli.js install chromium \
    && chown -R bun:bun /opt/browsers
USER bun
