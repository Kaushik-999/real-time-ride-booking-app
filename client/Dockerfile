# syntax=docker/dockerfile:1
# Frontend image. Targets:
#   dev   - Vite dev server with hot reload (source mounted by docker-compose)
#   build - produces the static bundle in /app/dist
#   prod  - nginx serving the bundle and proxying /api + /socket.io to the backend
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS dev
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM base AS build
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
