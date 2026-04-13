FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

ARG NODE_MAJOR=22
ARG PNPM_VERSION=9.15.0
ARG CODEX_VERSION=0.117.0

# Base system packages for bb development inside a sandbox.
# Keep this intentionally minimal: enough for git-driven Node work,
# repo search, health checks, and native npm fallback builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap \
    ca-certificates \
    curl \
    g++ \
    gh \
    git \
    make \
    pkg-config \
    python3 \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js from the official NodeSource apt repo so we control the major
# version independently from the Ubuntu release cadence.
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
  && apt-get update && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Match the repo's pinned pnpm version instead of inheriting whatever the base
# image or npm happens to provide.
RUN corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate

# Codex remains the only external provider CLI we need in the image today.
RUN npm install -g @openai/codex@${CODEX_VERSION} \
  && npm cache clean --force
