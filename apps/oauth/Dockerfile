FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY apps/oauth/package.json apps/oauth/package.json
RUN corepack pnpm@12.10.1 install --frozen-lockfile --filter @site-engine/oauth...
COPY apps/oauth apps/oauth
RUN corepack pnpm@12.10.1 --filter @site-engine/oauth build

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/site-engine && chown node:node /var/lib/site-engine
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/oauth/node_modules ./apps/oauth/node_modules
COPY --from=build /app/apps/oauth/dist ./apps/oauth/dist
WORKDIR /app/apps/oauth
EXPOSE 3001
VOLUME ["/var/lib/site-engine"]
USER node
CMD ["node", "dist/server.js"]
