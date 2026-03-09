FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL="/root/.bun"
ENV PATH="${BUN_INSTALL}/bin:/usr/local/bin:${PATH}"

# Base system tooling
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    apt-transport-https \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    lsb-release \
    openssh-client \
    procps \
    ripgrep \
    software-properties-common \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# Docker CLI and compose/buildx support
RUN mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && chmod a+r /etc/apt/keyrings/docker.gpg \
  && echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    docker-ce-cli \
    docker-buildx-plugin \
    docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# Bun runtime
RUN curl -fsSL https://bun.sh/install | bash \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# Pnpm via Corepack (ships with Node 22)
RUN corepack enable \
  && corepack prepare pnpm@9.15.0 --activate

# Codex CLI for in-environment provider execution
RUN npm install -g @openai/codex@latest

WORKDIR /workspace

CMD ["sleep", "infinity"]
