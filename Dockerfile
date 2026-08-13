# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json drizzle.config.ts ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/git/package.json packages/git/package.json
COPY packages/runners/package.json packages/runners/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/workflow/package.json packages/workflow/package.json

RUN pnpm install --frozen-lockfile --filter . --filter @devloop/server... --filter @devloop/web...

COPY apps/server apps/server
COPY apps/web apps/web
COPY packages packages
COPY schemas schemas

RUN pnpm --filter @devloop/server... --filter @devloop/web... build

FROM node:24-bookworm-slim AS runtime

ARG CODEX_CLI_VERSION=0.145.0

ENV NODE_ENV=production
ENV DEVLOOP_HOST=0.0.0.0
ENV DEVLOOP_PORT=4317
ENV DEVLOOP_ALLOW_LAN=true
ENV DEVLOOP_DATA_DIR=/data
ENV DEVLOOP_RUNNER=codex
ENV HOME=/home/devloop
ENV CODEX_HOME=/home/devloop/.codex

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git openssh-client tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "pnpm@10.24.0" "@openai/codex@${CODEX_CLI_VERSION}" \
  && useradd --create-home --uid 10001 --shell /bin/bash devloop \
  && mkdir -p /app /data /home/devloop/.codex /home/devloop/.ssh \
  && chown -R devloop:devloop /app /data /home/devloop

WORKDIR /app

COPY --from=build --chown=devloop:devloop /app/node_modules ./node_modules
COPY --from=build --chown=devloop:devloop /app/apps/server ./apps/server
COPY --from=build --chown=devloop:devloop /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=devloop:devloop /app/packages ./packages
COPY --from=build --chown=devloop:devloop /app/schemas ./schemas
COPY --chown=devloop:devloop package.json pnpm-workspace.yaml ./

USER devloop

EXPOSE 4317

VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
