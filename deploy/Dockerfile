# Pomelobot Dockerfile (production-friendly, keep original Ubuntu tooling)

# -------- Base stage: keep original image + preinstalled tools --------
FROM ubuntu:24.04 AS base

ENV DEBIAN_FRONTEND=noninteractive

# Configure mirror source (same as original)
RUN sed -i 's@//archive.ubuntu.com@//mirrors.aliyun.com@g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; \
    sed -i 's@//security.ubuntu.com@//mirrors.aliyun.com@g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; \
    sed -i 's@//ports.ubuntu.com@//mirrors.aliyun.com@g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true

# Keep original preinstalled toolset
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates git vim python3 python3-pip python3-venv && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED

# Reuse built-in ubuntu user (same as original behavior)
RUN usermod -g 0 -s /bin/bash ubuntu && \
    mkdir -p /app /home/ubuntu/.npm-global && \
    chown -R ubuntu:0 /app /home/ubuntu

USER ubuntu

ENV NPM_CONFIG_PREFIX=/home/ubuntu/.npm-global
ENV PATH=/home/ubuntu/.npm-global/bin:$PATH
ENV HOME=/home/ubuntu

# 安装pnpm，claude code,  uvx等
RUN npm install -g pnpm && \
curl -LsSf https://astral.sh/uv/install.sh | sh && \
curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /app


# -------- Builder stage: compile dist and prune production deps --------
FROM base AS builder

COPY --chown=ubuntu:0 package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY --chown=ubuntu:0 src ./src
RUN pnpm build && pnpm prune --prod


# -------- Runtime stage: keep original tooling, copy only runtime files --------
FROM base AS runtime

WORKDIR /app

# Runtime app files
COPY --from=builder --chown=ubuntu:0 /app/dist ./dist
COPY --from=builder --chown=ubuntu:0 /app/node_modules ./node_modules
COPY --chown=ubuntu:0 package.json ./package.json

# Runtime config artifacts
COPY --chown=ubuntu:0 exec-commands.json ./exec-commands.json
COPY --chown=ubuntu:0 config-example.json ./config-example.json

# Runtime writable dirs
RUN mkdir -p workspace logs

# Multi-channel server entrypoint
CMD ["pnpm", "start:server"]
