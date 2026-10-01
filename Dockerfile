# Colab CLI backend — Python 3.12 + Node 20 + node-pty (real terminal)
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080 \
    COLAB_HOME=/data \
    HOME=/data \
    REQUIRE_API_KEY=1

# Установка системных зависимостей:
# - openssh-client: необходим для ssh-keygen и работы команды colab ssh
# - python3-dev, make, g++: сборка нативного модуля node-pty под Node 20
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    git \
    procps \
    openssh-client \
    python3-dev \
    make \
    g++ \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node -v && npm -v && python3 --version && ssh -V

# Системная конфигурация SSH для автоматического принятия ключей инстансов Colab
RUN mkdir -p /etc/ssh/ssh_config.d && \
    printf "Host *\n  StrictHostKeyChecking accept-new\n  ServerAliveInterval 30\n  ServerAliveCountMax 4\n  TCPKeepAlive yes\n" > /etc/ssh/ssh_config.d/99-colab.conf

# Установка официальной CLI-утилиты Colab
RUN pip install --no-cache-dir google-colab-cli \
    && colab version

WORKDIR /app

# Копирование манифестов и компиляция зависимостей с открытым выводом ошибок
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Подготовка прав и рабочей директории
RUN chmod +x colab_auth_helper.py \
    && mkdir -p /data/.config/colab-cli /data/.ssh \
    && chmod 700 /data/.ssh

VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
