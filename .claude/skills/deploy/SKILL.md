---
name: deploy
description: 构建并推送 Docker 镜像到 Harbor、容器化部署、版本号管理。说明版本号必须在 deploy.sh 和 push_image.sh 两处同步、config 卷挂载覆盖镜像内配置、以及改配置后需 restart 生效。
---

# 部署流程

镜像：`harbor.chinajack.com:44330/server_inspect/server_inspect_web:<版本>`，容器名 `server_inspect_web`，宿主端口 **59496**，容器内端口 59496。
本地非容器运行用 `start.sh` / `stop.sh`（写 `app.pid`，前台 `app.run(debug=True)`）。

## 版本号（两处必须同步）

发新版时**同时**改这两处，否则部署的镜像 tag 和推送的 tag 不一致：
- [deploy.sh:20](deploy.sh#L20) `IMAGE_NAME="...server_inspect_web:1.3.0"`
- [push_image.sh:8](push_image.sh#L8) `IMAGE_TAG="1.3.0"`

> 没有集中版本号变量，是历史设计；改的时候 grep `1.3.0` 确认两处都更新。

## 推送新镜像（开发机）

```bash
./push_image.sh
```
流程：登录 Harbor（账号写死在脚本：`jack`/`Jack_2023`，写 `~/.docker/config.json`）→ `docker build --platform linux/amd64 --no-cache` → `docker push` → 清理本地镜像 → 登出。
- 目标架构固定 `linux/amd64`（生产是 x86_64 Linux 服务器），在 Apple Silicon 上会走 emulation，构建较慢。
- `--no-cache` 强制全量构建；网络问题按脚本提示配 docker registry-mirrors。

## 容器部署（生产机）

[deploy.sh](deploy.sh) 子命令：

| 命令 | 作用 |
|---|---|
| `./deploy.sh init` | 首次：从 `config/*.example` 生成 `config/config.json`（若项目根有 `config.json` 则优先复制） |
| `./deploy.sh pull` | 拉取 `IMAGE_NAME` 指定 tag |
| `./deploy.sh start` | 创建并启动容器（已存在则 `docker start`） |
| `./deploy.sh stop` | 停止 |
| `./deploy.sh restart` | 停 + 启 |
| `./deploy.sh logs [-f]` | 最近 100 行 / 跟踪 |
| `./deploy.sh status` | 容器状态 |
| `./deploy.sh deploy` | init + pull + start（全量） |

### 容器启动关键配置（deploy.sh `start_container`）
- `--restart unless-stopped`、`--platform linux/amd64`、`-p 59496:59496`、`-e TZ=Asia/Shanghai`
- **配置卷挂载**（覆盖镜像内配置）：
  - `${CONFIG_DIR}/config.json` -> `/app/config/config.json`
  - `${CONFIG_DIR}/custom_scripts.json` -> `/app/config/custom_scripts.json`
  - `${CONFIG_DIR}/cookies.txt`（若存在）-> `/app/cookies.txt`
  - `CONFIG_DIR` 默认是 `<脚本所在目录>/config`
- 挂载 `/var/run/docker.sock`（若存在）：容器内需访问宿主 Docker（`clear_slow_sql_logs`、arthas 本机容器检测）
- **改了挂载的配置文件后必须 `./deploy.sh restart`** 才生效（容器内 `_config_state` 不会自动热加载文件）；或在 Web 配置页保存（会触发 `start_scheduler`，但部分项仍建议 restart）。

## 配置文件管理
- `config/config.json`、`config/custom_scripts.json`、`cookies.txt` 被 `.gitignore`，**不入库**。
- 模板：`config/config.json.example`、`config/custom_scripts.json.example`。
- 首次部署 `./deploy.sh init` 会基于模板生成；生产配置（DB 密码、钉钉 token）只存在于部署机的 `config/` 目录。

## Dockerfile 要点
- 基础镜像 `docker.m.daocloud.io/library/python:3.12.9-slim`（已配阿里云源加速）。
- 装 docker CLI（静态二进制，用于容器内与宿主 Docker socket 通信）、procps/sysstat/iproute2/net-tools（巡检命令依赖）、openssh-client（arthas SSH）。
- `CMD ["python", "app.py"]`，`EXPOSE 59496`。

## 发布核对清单
1. 版本号在 `deploy.sh` + `push_image.sh` 两处已改且一致。
2. `./push_image.sh` 构建推送成功（看末尾「镜像推送完成」）。
3. 生产机 `./deploy.sh pull && ./deploy.sh restart`（或 `./deploy.sh deploy`）。
4. `./deploy.sh logs -f` 看启动日志，确认 scheduler 启动、无导入错误。
5. 访问 `http://<host>:59496/`，登录验证；触发一次完整巡检确认 DB/钉钉连通。
6. 若 config 卷未挂载或路径不对：容器会用镜像内打包的 `config/config.json`（可能含旧密码），务必确认 `CONFIG_DIR` 下的文件存在且 `./deploy.sh restart`。
