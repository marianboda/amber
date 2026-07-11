FROM node:24-slim AS webbuild
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:24-slim

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/tsconfig.json ./
COPY server/migrations ./migrations
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

COPY --from=webbuild /app/web/dist /app/web/dist

ENV NODE_ENV=production
# Default mount point for archives/assets/backups/trash; the Dokku storage
# mount and DATA_DIR/AMBER_DATA_DIR config point here too. Metadata is in
# Postgres (DATABASE_URL), not on disk.
ENV AMBER_DATA_DIR=/app/data
EXPOSE 3000

# Unprivileged runtime user with the uid Dokku's storage:ensure-directory
# chowns mounts to (32767, "herokuish") — no root access needed on the host.
RUN useradd --uid 32767 --user-group --create-home amber
USER amber

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD ["node", "-e", "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
