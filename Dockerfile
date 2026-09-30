# Colab CLI backend — Python 3.12 (required by google-colab-cli) + Node 20
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080 \
    COLAB_HOME=/data \
    HOME=/data \
    REQUIRE_API_KEY=1

# System deps + Node.js 20
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    git \
    procps \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node -v && npm -v && python3 --version

# Google Colab CLI (must be on Python >= 3.12)
RUN pip install --no-cache-dir google-colab-cli \
    && colab version

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .
RUN chmod +x colab_auth_helper.py \
    && mkdir -p /data/.config/colab-cli

# Persist Colab auth + session metadata on a volume mounted at /data
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
