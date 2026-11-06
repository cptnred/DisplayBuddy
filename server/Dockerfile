# syntax=docker/dockerfile:1
#
# Display Buddy sync server + PWA (PLAN_V3_SYNC §11, D-40).
#
# Build context is the repository root (buddy-server uses the path dependency
# ../crates/buddy-core and the PWA lives in the root npm project):
#
#   docker build -f server/Dockerfile -t buddy-server .
#   (or: cd deploy && docker compose build)
#
# Stages (Docker docs "Multi-stage builds"):
#   web    – npm ci && npm run build:web   → /src/dist-web
#   server – cargo build --release --locked → /usr/local/bin/buddy-server
#   final  – Debian slim, non-root user, /data volume, HEALTHCHECK
#
# Base images are pinned by tag and digest (multi-arch index digest from Docker Hub,
# checked 2026-11-06). Update both together.

ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
ARG RUST_IMAGE=rust:1.99.1-slim-trixie@sha256:7eab7ce19273ce785e0ca7578bdf7bc1fcbae621775a8197379a04c9f6e03cd5
ARG RUNTIME_IMAGE=debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

# --- PWA ----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
WORKDIR /src
# Dependencies first so they stay cached while only sources change.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build:web && test -f dist-web/index.html

# --- Server -------------------------------------------------------------------------------
FROM ${RUST_IMAGE} AS server
# web-push encrypts via ece/OpenSSL (D-56): headers + pkg-config at build time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY crates/buddy-core crates/buddy-core
COPY server server
WORKDIR /src/server
# The target dir is a cache mount, so the binary is copied out in the same step.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/server/target \
    cargo build --release --locked --bin buddy-server \
 && install -m 0755 target/release/buddy-server /usr/local/bin/buddy-server

# --- Runtime ------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}
# libssl3t64 = OpenSSL 3 runtime on Debian 13 (D-56); ca-certificates for HTTPS to the
# push services; curl only for the HEALTHCHECK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3t64 curl \
 && rm -rf /var/lib/apt/lists/*
# Fixed, unprivileged UID/GID; /data is created owned by it, so a fresh named volume
# inherits the ownership.
RUN groupadd --system --gid 10001 buddy \
 && useradd --system --uid 10001 --gid buddy --home-dir /data --no-create-home \
      --shell /usr/sbin/nologin buddy \
 && mkdir -p /data \
 && chown buddy:buddy /data \
 && chmod 0700 /data
COPY --from=server /usr/local/bin/buddy-server /usr/local/bin/buddy-server
COPY --from=web /src/dist-web /app/web

ENV BUDDY_LISTEN=0.0.0.0:8080 \
    BUDDY_DB=/data/buddy.db \
    BUDDY_WEB_DIR=/app/web \
    RUST_LOG=info,sqlx=warn,tower_http=warn

USER buddy:buddy
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8080

# Docker docs, Dockerfile reference "HEALTHCHECK". The endpoint answers without login.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS -o /dev/null http://127.0.0.1:8080/api/v1/health || exit 1

# buddy-server handles SIGTERM itself (graceful shutdown), so it may run as PID 1.
# Admin commands: docker compose run --rm -it buddy buddy-server user add <name>
CMD ["buddy-server", "serve"]
