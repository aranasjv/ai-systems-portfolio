FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile=false && pnpm store prune

COPY --from=build /app/dist ./dist
COPY sql ./sql
COPY evals ./evals

USER node
EXPOSE 3000

CMD ["node", "dist/api/server.js"]
