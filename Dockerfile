# syntax=docker/dockerfile:1.7
# Build a reviewed runtime image, then export its native artifact. No model
# runtime or weights are installed. Repository root context; only public package inputs.
ARG NODE_IMAGE=node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_IMAGE} AS builder
WORKDIR /opt/ardent-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund --ignore-scripts \
    && npm rebuild better-sqlite3 \
    && npm run build \
    && mkdir -p /packages \
    && npm pack --ignore-scripts --pack-destination /packages \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && mkdir -p /opt/ardent/node_modules \
    && cp -a node_modules/. /opt/ardent/node_modules/ \
    && find /opt/ardent/node_modules -maxdepth 2 -type l -delete \
    && mkdir -p /opt/ardent/node_modules/@hivemagnus/ardent \
    && tar -xzf /packages/hivemagnus-ardent-*.tgz --strip-components=1 -C /opt/ardent/node_modules/@hivemagnus/ardent

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="ardent" \
      org.opencontainers.image.description="Optional native Ardent runtime export; inference remains external" \
      org.opencontainers.image.source="https://github.com/ChefTaco/Ardent" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /opt/ardent
COPY --from=builder /opt/ardent/ ./
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "/opt/ardent/node_modules/@hivemagnus/ardent/dist/cli.js"]
CMD ["help"]
