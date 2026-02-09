# Pomelobot Dockerfile

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# 配置阿里云镜像源
RUN sed -i 's@//archive.ubuntu.com@//mirrors.aliyun.com@g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; \
    sed -i 's@//security.ubuntu.com@//mirrors.aliyun.com@g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; \
    sed -i 's@//ports.ubuntu.com@//mirrors.aliyun.com@g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true

# 安装系统依赖
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates git vim python3 python3-pip python3-venv && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED

# 复用 Ubuntu 24.04 内置 ubuntu 用户(UID=1000)，加入 root 组获得类 root 权限
RUN usermod -g 0 -s /bin/bash ubuntu && \
    mkdir -p /app /home/ubuntu/.npm-global && \
    chown -R ubuntu:0 /app /home/ubuntu

# 切换到非 root 用户
USER ubuntu

# npm 全局安装目录设为用户空间，无需 sudo
ENV NPM_CONFIG_PREFIX=/home/ubuntu/.npm-global
ENV PATH=/home/ubuntu/.npm-global/bin:$PATH
ENV HOME=/home/ubuntu

# 安装 pnpm 和 qwen-code
RUN npm install -g pnpm && npm install -g @qwen-code/qwen-code@latest

# 创建应用目录
WORKDIR /app

# 复制依赖文件
COPY --chown=ubuntu:0 package.json pnpm-lock.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制源代码
COPY --chown=ubuntu:0 . .

# 配置 Qwen Code 
RUN mkdir -p ~/.qwen && \
    cp /app/.qwen/config/settings.json ~/.qwen/settings.json && \
    cp -r /app/.qwen/config/skills ~/.qwen/skills

# 创建 workspace 目录
RUN mkdir -p workspace

# 默认启动命令
CMD ["pnpm", "dingtalk"]
