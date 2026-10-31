# syntax=docker/dockerfile:1
# Single production image: Express API + the built React app, served from one origin.

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /repo
# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-fund --no-audit
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @locallens/api --no-fund --no-audit && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/web/dist web
ENV STATIC_DIR=/app/web PORT=4100
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:4100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
