# syntax=docker/dockerfile:1.7
# Build a reviewed runtime image, then export its native artifact. No model
# runtime or weights are installed. Repository root context; only public package inputs.
ARG NODE_IMAGE=node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
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
# Native exports and the CLI run on node alone. Package managers are build-only
# tools; retaining their bundled dependencies would ship avoidable vulnerabilities.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
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
