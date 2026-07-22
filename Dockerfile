# syntax=docker/dockerfile:1

# Node version is pinned to match .nvmrc (v26.4.0). Keep the two in sync.
ARG NODE_VERSION=26.4.0

# ──────────────────────────────────────────────────────────────
# Stage 1: dependencies (full, including dev — needed to compile)
# ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-trixie-slim AS deps
WORKDIR /app

# HUSKY=0 stops the `prepare` script from trying to install git hooks:
# there is no .git directory inside the build context (see .dockerignore).
ENV HUSKY=0

COPY package.json package-lock.json ./
# --ignore-scripts also skips the `preinstall` only-allow guard, which is a
# developer ergonomics check and has no meaning inside a container build.
RUN npm ci --ignore-scripts

# ──────────────────────────────────────────────────────────────
# Stage 2: build (tsc -> dist, then rewrite tsconfig path aliases)
# ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-trixie-slim AS build
WORKDIR /app
ENV HUSKY=0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

# `npm run build` = clean && tsc && tsc-alias. The tsc-alias step is required:
# tsc leaves "@config" / "@shared/*" imports untouched and the output would
# crash at startup with "Cannot find module '@config'".
RUN npm run build

# ──────────────────────────────────────────────────────────────
# Stage 3: production dependencies only
# ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-trixie-slim AS prod-deps
WORKDIR /app
ENV HUSKY=0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ──────────────────────────────────────────────────────────────
# Stage 4: runtime
# ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-trixie-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# dumb-init reaps zombies and forwards SIGTERM to node, so the graceful
# shutdown path in bootstrap/shutdown.bootstrap.ts actually runs on scale-down.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

# The node image ships an unprivileged `node` user (uid 1000). Never run as root.
USER node

EXPOSE 3000

# Liveness only. Readiness (DB/Redis reachable) is the orchestrator's job via
# /ready — see docs/03_OPERATIONS/DEPLOYMENT.md §6.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
