FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contract ./packages/contract
COPY apps/site ./apps/site
RUN pnpm install --frozen-lockfile --filter @site-engine/site... && pnpm --filter @site-engine/contract build && pnpm --filter @site-engine/site build

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
COPY --from=build /workspace/apps/site/dist /usr/share/nginx/html
COPY apps/site/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O - http://127.0.0.1:8080/healthz || exit 1
