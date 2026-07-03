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
ENV AMBER_DATA_DIR=/data
EXPOSE 3000

CMD ["node", "dist/index.js"]
