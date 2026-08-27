#!/bin/bash

HARBOR_REGISTRY="harbor.chinajack.com:44330"
HARBOR_PROJECT="server_inspect"
HARBOR_USER="jack"
HARBOR_PASSWORD="Jack_2023"
IMAGE_NAME="server_inspect_web"
IMAGE_TAG="1.4.3.2"
FULL_IMAGE_NAME="${HARBOR_REGISTRY}/${HARBOR_PROJECT}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "===================================="
echo "一键推送镜像脚本"
echo "===================================="
echo "镜像名称: ${FULL_IMAGE_NAME}"
echo ""

echo "[1/5] 登录Harbor仓库..."
echo "提示: 如遇网络问题，请配置Docker镜像加速"
echo "      macOS Docker Desktop: Settings -> Docker Engine 添加 registry-mirrors"
echo "      Linux: /etc/docker/daemon.json 中添加 registry-mirrors"
DOCKER_CONFIG_FILE=~/.docker/config.json
mkdir -p ~/.docker
AUTH_TOKEN=$(python3 -c "import base64; print(base64.b64encode(b'${HARBOR_USER}:${HARBOR_PASSWORD}').decode())")
if [ -f "${DOCKER_CONFIG_FILE}" ]; then
    python3 -c "
import json, sys
try:
    with open('${DOCKER_CONFIG_FILE}', 'r') as f:
        cfg = json.load(f)
except:
    cfg = {}
cfg['auths'] = cfg.get('auths', {})
cfg['auths']['${HARBOR_REGISTRY}'] = {'auth': '${AUTH_TOKEN}'}
cfg['credsStore'] = ''
with open('${DOCKER_CONFIG_FILE}', 'w') as f:
    json.dump(cfg, f, indent=4)
"
else
    python3 -c "
import json
cfg = {'auths': {'${HARBOR_REGISTRY}': {'auth': '${AUTH_TOKEN}'}}, 'credsStore': '', 'currentContext': 'orbstack'}
with open('${DOCKER_CONFIG_FILE}', 'w') as f:
    json.dump(cfg, f, indent=4)
"
fi
echo "登录成功"
echo ""

echo "[2/5] 构建Docker镜像..."
echo "提示: 使用 --no-cache 强制重新构建，如需使用缓存加速请移除该参数"
echo "      移除 --pull 以避免基础镜像源不可达时元数据拉取失败"
# 目标架构：amd64（兼容 x86_64 Linux 服务器）
TARGET_PLATFORM="linux/amd64"
echo "目标架构: ${TARGET_PLATFORM}"

# 基础镜像默认用本地标签，不联网查元数据（公共镜像源经常挂，挂了就卡在第一层）。
# 想换源直接 BASE_IMAGE=xxx sh push_image.sh
BASE_IMAGE="${BASE_IMAGE:-python-base:3.12.9-slim-amd64}"
echo "基础镜像: ${BASE_IMAGE}"
# 本地没有这个标签就先说清楚怎么补，别让用户去猜 BuildKit 那句 load metadata 报错。
if ! docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
    echo "错误: 本地找不到基础镜像 ${BASE_IMAGE}"
    echo "      补齐办法（任选其一）："
    echo "      1) 已有其他 tag 的 amd64 python:3.12.9-slim，直接改名："
    echo "         docker tag <已有的镜像> ${BASE_IMAGE}"
    echo "      2) 从能访问的源拉一份 amd64 的："
    echo "         docker pull --platform linux/amd64 python:3.12.9-slim && \\"
    echo "         docker tag python:3.12.9-slim ${BASE_IMAGE}"
    echo "      3) 临时指定别的基础镜像：BASE_IMAGE=<镜像> sh push_image.sh"
    exit 1
fi
# 基础镜像架构必须跟目标架构一致，否则构建出来的镜像在服务器上起不来（exec format error）。
BASE_ARCH=$(docker image inspect "${BASE_IMAGE}" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null)
if [ "${BASE_ARCH}" != "${TARGET_PLATFORM}" ]; then
    echo "错误: 基础镜像架构是 ${BASE_ARCH}，跟目标 ${TARGET_PLATFORM} 不一致"
    echo "      拿它构建出来的镜像在 x86 服务器上会报 exec format error。"
    echo "      请换一份 ${TARGET_PLATFORM} 的基础镜像（见上面第 2 条）。"
    exit 1
fi

docker build --platform ${TARGET_PLATFORM} --no-cache \
    --build-arg BASE_IMAGE="${BASE_IMAGE}" \
    -t ${FULL_IMAGE_NAME} .
if [ $? -ne 0 ]; then
    echo "错误: 镜像构建失败"
    exit 1
fi
echo "镜像构建成功"
echo ""

echo "[3/5] 推送镜像到Harbor仓库..."
echo "目标架构: ${TARGET_PLATFORM}"
docker push ${FULL_IMAGE_NAME}
if [ $? -ne 0 ]; then
    echo "错误: 镜像推送失败"
    exit 1
fi
echo "镜像推送成功"
echo ""

echo "[4/5] 清理本地镜像..."
docker rmi ${FULL_IMAGE_NAME} 2>/dev/null || true
echo "清理完成"
echo ""

echo "[5/5] 登出Harbor仓库..."
python3 -c "
import json
try:
    with open('${DOCKER_CONFIG_FILE}', 'r') as f:
        cfg = json.load(f)
except:
    cfg = {}
cfg['auths'] = cfg.get('auths', {})
cfg['auths'].pop('${HARBOR_REGISTRY}', None)
with open('${DOCKER_CONFIG_FILE}', 'w') as f:
    json.dump(cfg, f, indent=4)
" 2>/dev/null || true
echo "登出成功"
echo ""

echo "===================================="
echo "镜像推送完成!"
echo "镜像地址: ${FULL_IMAGE_NAME}"
echo "===================================="