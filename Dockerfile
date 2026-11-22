# syntax=docker/dockerfile:1

# Node version is pinned to match .nvmrc (v22.21.0). Keep the two in sync.
ARG NODE_VERSION=22.21.0

# Stage order matters: `runner` must stay LAST so an untargeted `docker build .`
# (which is what ci.yml does) still selects the production image.
#
#   deps ──┬── development   npm run dev / npm run worker:dev   (source bind-mounted)
#          ├── test          npm run test                       (self-contained)
#          └── build ── prod-deps ── runner   node dist/*.js     (non-root)

# ==============================================================================
# Stage 1: Dependencies (Full install including devDependencies)
# ==============================================================================
FROM node:${NODE_VERSION}-trixie-slim AS deps
WORKDIR /app

# HUSKY=0 stops the `prepare` script from trying to install git hooks:
# there is no .git directory inside the build context (see .dockerignore).
ENV HUSKY=0

COPY package.json package-lock.json ./

# --ignore-scripts skips the `preinstall` only-allow guard (dev ergonomics check)
# and `postinstall: prisma generate`. Stages requiring the Prisma client will
# execute `npx prisma generate` explicitly.
RUN npm ci --ignore-scripts

# ==============================================================================
# Stage 2: Local Development (tsx watch, develop.watch sync)
# ==============================================================================
FROM node:${NODE_VERSION}-trixie-slim AS local
WORKDIR /app
ENV HUSKY=0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.tools.json prisma.config.ts ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
COPY tests ./tests

RUN npx prisma generate

EXPOSE 3000 3001
CMD ["npm", "run", "dev"]

FROM local AS development

# ==============================================================================
# Stage 3: Test (Self-contained test execution environment)
# ==============================================================================
# Requires tsx, the Prisma CLI and the test suites. APP_ENV/NODE_ENV and
# .env.test are supplied by compose.test.yml, never baked in here.
FROM node:${NODE_VERSION}-trixie-slim AS test
WORKDIR /app
# HUSKY is a build-time flag, not application configuration.
ENV HUSKY=0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.tools.json prisma.config.ts ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
COPY tests ./tests

RUN npx prisma generate

# npm test handles --test-concurrency=1 and --test-force-exit execution rules.
CMD ["npm", "run", "test"]

# ==============================================================================
# Stage 4: Build (Compile TypeScript to JavaScript & alias path resolution)
# ==============================================================================
FROM node:${NODE_VERSION}-trixie-slim AS build
WORKDIR /app
ENV HUSKY=0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src

# Generate Prisma client for build environment (excluded from build context).
RUN npx prisma generate

# `npm run build` runs clean, tsc, tsc-alias (path rewrites), and copy-generated.
RUN npm run build

# ==============================================================================
# Stage 4b: Ops (Administrative, Migration & Seed Tasks with tsx & dev tools)
# ==============================================================================
FROM build AS ops
CMD ["npx", "prisma", "migrate", "status"]

# ==============================================================================
# Stage 5: Production Dependencies (Minimal node_modules footprint)
# ==============================================================================
FROM node:${NODE_VERSION}-trixie-slim AS prod-deps
WORKDIR /app
ENV HUSKY=0

COPY package.json package-lock.json ./
# --ignore-scripts also skips @prisma/engines' install script, which is what
# downloads the schema-engine binary. Without the rebuild below, the shipped
# prisma CLI tries to fetch it from binaries.prisma.sh at deploy time and
# `prisma migrate deploy` fails on any host without egress.
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild @prisma/engines \
    && npm cache clean --force

# ==============================================================================
# Stage 6: Production Runtime
# ==============================================================================
FROM node:${NODE_VERSION}-trixie-slim AS prod
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json prisma.config.ts ./
COPY --chown=node:node prisma ./prisma

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]

FROM prod AS runner
FROM prod AS production
