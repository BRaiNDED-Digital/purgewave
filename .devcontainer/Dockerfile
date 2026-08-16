FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Electron runtime dependencies on Debian (https://www.electronjs.org/docs/latest/development/build-instructions-linux)
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
       ca-certificates \
       curl \
       git \
       jq \
       libasound2 \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libatspi2.0-0 \
       libcups2 \
       libdrm2 \
       libgbm1 \
       libgtk-3-0 \
       libnss3 \
       libx11-xcb1 \
       libxcomposite1 \
       libxdamage1 \
       libxfixes3 \
       libxkbcommon0 \
       libxrandr2 \
       libxss1 \
       libxtst6 \
       xdg-utils \
       xvfb \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/*
