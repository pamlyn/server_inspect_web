# 基础镜像走 build arg，默认指向本地已缓存的标签。
# 为何不直接写镜像源地址：原来写死 docker.m.daocloud.io，那个源已经停了（DNS 都不解析），
# 于是每次构建都倒在第一行「load metadata」上——哪怕本地早就有可用的基础镜像。
# 不带 registry 前缀的标签 BuildKit 只查本地镜像库，不联网，所以断网也能构建。
# 换源或升级 Python 版本时不用改这里，构建时传 --build-arg BASE_IMAGE=... 即可。
ARG BASE_IMAGE=python-base:3.12.9-slim-amd64
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources; \
        sed -i 's/security.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
        sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list; \
        sed -i 's/security.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    procps \
    iproute2 \
    net-tools \
    coreutils \
    gawk \
    grep \
    curl \
    wget \
    iputils-ping \
    sysstat \
    && rm -rf /var/lib/apt/lists/*
# 说明：DB 驱动用 psycopg2-binary（预编译 wheel，自带 libpq）+ PyMySQL（纯 Python），
# 无需任何编译，因此不装 gcc/g++/python3-dev/libpq-dev/default-libmysqlclient-dev
# 这套编译工具链（曾占镜像约 250MB+）。仅保留运行时巡检命令依赖。

# 安装 Docker CLI（静态二进制，用于从容器内与宿主机 Docker socket 通信）
# download.docker.com 偶发 HTTP/2 流中断(exit 18)，故强制 HTTP/1.1 + 自动重试，
# 并以阿里云 docker-ce 镜像兜底，保证构建在网络抖动下仍能成功
RUN (curl -fsSL --http1.1 --retry 5 --retry-delay 3 --retry-all-errors \
        https://download.docker.com/linux/static/stable/x86_64/docker-26.1.4.tgz -o /tmp/docker.tgz \
    || curl -fsSL --http1.1 --retry 5 --retry-delay 3 --retry-all-errors \
        https://mirrors.aliyun.com/docker-ce/linux/static/stable/x86_64/docker-26.1.4.tgz -o /tmp/docker.tgz) \
    && tar -xzf /tmp/docker.tgz -C /tmp/ \
    && cp /tmp/docker/docker /usr/local/bin/ \
    && chmod +x /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz

RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/ \
    && pip config set global.trusted-host mirrors.aliyun.com

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 59496

CMD ["python", "app.py"]