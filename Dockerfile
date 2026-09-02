# Multi-stage production image for Fly.io (TanStack Start / Nitro node-server).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Emit a Node server under .output (not the Vercel preset).
ENV NITRO_PRESET=node-server
# migrate.mjs no-ops without DATABASE_URL (schema applied at runtime / deploy).
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
COPY --from=build /app/.output ./.output
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
CMD ["node", ".output/server/index.mjs"]
