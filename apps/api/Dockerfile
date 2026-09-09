# syntax=docker/dockerfile:1
# context: repo root
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/skill-runner/package.json apps/skill-runner/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/normalize/package.json packages/normalize/package.json
COPY packages/preview/package.json packages/preview/package.json
COPY packages/retrieve/package.json packages/retrieve/package.json
COPY packages/skills-runtime/package.json packages/skills-runtime/package.json
RUN pnpm install --frozen-lockfile --filter @note-hub/api...

FROM deps AS api
COPY packages packages
COPY apps/api apps/api
COPY skills skills
COPY fixtures fixtures
ENV NOTE_HUB_ROOT=/app
EXPOSE 3001
CMD ["pnpm", "--filter", "@note-hub/api", "start"]
