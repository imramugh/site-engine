FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/oauth/package.json apps/oauth/package.json
RUN corepack pnpm@12.8.1 install --frozen-lockfile --filter @site-engine/oauth...
COPY apps/oauth apps/oauth
RUN corepack pnpm@12.8.1 --filter @site-engine/oauth build

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/oauth/node_modules ./apps/oauth/node_modules
COPY --from=build /app/apps/oauth/dist ./apps/oauth/dist
WORKDIR /app/apps/oauth
EXPOSE 3001
USER node
CMD ["node", "dist/server.js"]
