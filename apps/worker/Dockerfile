# syntax=docker/dockerfile:1
# context: repo root
FROM node:22-bookworm-slim AS base
RUN set -eux; for i in 1 2 3 4 5; do apt-get update && break || sleep 4; done; apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng poppler-utils antiword ca-certificates && rm -rf /var/lib/apt/lists/* && tesseract --list-langs && tesseract --list-langs 2>/dev/null | grep -E '^(eng|chi_sim)$'
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

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
RUN pnpm install --frozen-lockfile --filter @note-hub/worker...

FROM deps AS worker
COPY packages packages
COPY apps/worker apps/worker
COPY skills skills
ENV NOTE_HUB_ROOT=/app
CMD ["pnpm", "--filter", "@note-hub/worker", "start"]
