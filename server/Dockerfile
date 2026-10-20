# syntax=docker/dockerfile:1
# Backend image. Targets:
#   dev  - all dependencies, source mounted by docker-compose, auto-restart on change
#   prod - production dependencies only, runs as the unprivileged "node" user
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS dev
ENV NODE_ENV=development
RUN npm ci
COPY . .
EXPOSE 4000
CMD ["npm", "run", "dev"]

FROM base AS prod
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /app/private-uploads && chown node:node /app/private-uploads && chmod 700 /app/private-uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "src/server.js"]
