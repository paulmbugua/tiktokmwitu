
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps ./apps
ENV INTERNAL_API_URL=http://api:4000 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS api-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w api --include-workspace-root=false
COPY apps/api ./apps/api
RUN npm run build -w api && npm prune -w api --omit=dev --include-workspace-root=false && mkdir -p apps/api/node_modules

FROM build AS web-deps
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=api-build /app/node_modules ./node_modules
COPY --from=api-build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=api-build /app/apps/api/dist ./apps/api/dist
RUN node -e "require.resolve('google-auth-library', { paths: ['/app/apps/api/dist'] })"
RUN mkdir -p /media && chown node:node /media
USER node
ENV NODE_ENV=production API_HOST=0.0.0.0 MEDIA_DIR=/media
EXPOSE 4000
CMD ["node","apps/api/dist/main.js"]

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY --from=web-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/web/package.json /app/apps/web/next.config.mjs ./apps/web/
COPY --from=build --chown=node:node /app/apps/web/.next ./apps/web/.next
WORKDIR /app/apps/web
USER node
ENV NODE_ENV=production INTERNAL_API_URL=http://api:4000 NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["../../node_modules/.bin/next","start","-H","0.0.0.0"]
