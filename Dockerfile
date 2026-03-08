# --- Build Stage ---
FROM node:22-bookworm AS builder

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Copy dependency files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

# Install dependencies
RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# --- Production Stage ---
FROM node:22-bookworm

LABEL org.opencontainers.image.source="https://github.com/openclaw/openclaw" \
  org.opencontainers.image.url="https://openclaw.ai" \
  org.opencontainers.image.documentation="https://docs.openclaw.ai/install/docker" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="OpenClaw" \
  org.opencontainers.image.description="OpenClaw gateway and CLI runtime container image"

WORKDIR /app

# Install runtime essentials
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  age \
  git \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy built assets from builder
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist/control-ui ./ui/dist
COPY --from=builder /app/openclaw.mjs ./
COPY --from=builder /app/scripts/healthcheck.js ./scripts/healthcheck.js
COPY --from=builder /app/extensions ./extensions
COPY --from=builder /app/skills ./skills

# Install only production dependencies
RUN corepack enable && pnpm install --prod --frozen-lockfile --ignore-scripts

# Expose the CLI binary
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
  && chmod 755 /app/openclaw.mjs

# Optionally install Chromium and Docker CLI (handled via build args if requested)
# Note: In a true slim multi-stage, these should be carefully layered or separate images.
# For compatibility with existing scripts, we keep them available as build-time opts.
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb chromium && \
  apt-get clean && rm -rf /var/lib/apt/lists/*; \
  fi

ARG OPENCLAW_INSTALL_DOCKER_CLI=""
RUN if [ -n "$OPENCLAW_INSTALL_DOCKER_CLI" ]; then \
  apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
  install -m 0755 -d /etc/apt/keyrings && \
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
  chmod a+r /etc/apt/keyrings/docker.gpg && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
  apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin && \
  apt-get clean && rm -rf /var/lib/apt/lists/*; \
  fi

# Final security hardening
ENV NODE_ENV=production
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=2m --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

ENTRYPOINT ["node", "openclaw.mjs"]
CMD ["gateway", "--allow-unconfigured"]
