FROM node:22-alpine AS build

RUN apk add --no-cache openssl
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
ENV DATABASE_URL=file:./dev.sqlite
RUN pnpm exec prisma generate
RUN pnpm run build
RUN pnpm prune --prod

FROM node:22-alpine AS runtime

RUN apk add --no-cache openssl
RUN corepack enable

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

EXPOSE 3000

CMD ["pnpm", "run", "railway:start"]
