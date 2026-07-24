---
name: troubleshoot-logs
description: 故障排查与日志查询。汇总本项目的五类日志来源（应用日志、容器日志、巡检日志库、慢SQL容器日志、钉钉通知），给出按现象排查的决策树（定时不跑/通知不发/漏报/连不上库/容器起不来），以及纯 print 无 logging 这一约束下的调试方式。
---

# 故障排查与日志查询

本项目**全程用 `print()`，没有 logging 模块**（grep `import logging` 为空）。所有运行时输出靠 stdout 重定向，调试主要靠 print + 看日志文件 + 查 `inspection_logs` 表。

## 五类日志来源

### 1. 应用日志 `app.log`（本地非容器运行）
[start.sh:233](start.sh#L233)：`nohup "$PYTHON3_PATH" app.py > "$LOG_FILE" 2>&1 &`，即所有 `print()` 和异常栈都进 `app.log`。
```bash
tail -f app.log          # 实时
grep "定时巡检\|日常巡检\|实时监控" app.log   # 看调度触发
grep -i "错误\|error\|失败\|traceback" app.log
```
- 容器运行时**没有 app.log**，用 docker logs（见下）。
- `app.pid` 存进程 PID；`stop.sh` 靠它 kill。

### 2. 容器日志（生产/容器运行）
```bash
./deploy.sh logs          # 最近 100 行
./deploy.sh logs -f       # 跟踪
docker logs --tail 200 -f server_inspect_web
```
应用内 print 全部进容器 stdout，等价于 app.log。

### 3. 容器内业务日志（Docker logs API，需登录）
通过 arthas 模块的容器日志 API（即使 arthas UI 已隐藏，路由仍生效，[modules/arthas/routes.py](modules/arthas/routes.py)）：
- 本机容器：`GET /api/arthas/local/containers/<container_id>/logs?lines=500&follow=true`
- 远程容器：`GET /api/arthas/sessions/<session_id>/containers/<container_id>/logs?lines=500&follow=true`（需先建 SSH session）
`follow=true` 走 Streaming Response 实时推送，适合盯 Java 应用日志。

### 4. 巡检日志库 `inspection_logs`（结构化，最该查）
[modules/log_storage/helpers.py](modules/log_storage/helpers.py)：单表 + JSON 结果列。每次巡检动作（系统/SQL/mes_hanging/自定义脚本，含成功失败）记一行。
| 列 | 含义 |
|---|---|
| inspection_type | system / sql / mes_hanging / custom_script |
| trigger_source | manual / scheduled / daily / real_time |
| target | cpu / full / 脚本名 / 库名 等 |
| operator | 手动=登录用户，自动=NULL |
| status | success / warning / critical / error |
| start_time / end_time / duration | 时间 |
| record_count | 结果记录数 |
| result | JSONB（PG）/ TEXT（MySQL），完整结果 |
| error | 失败原因 |

查询示例（PG）：
```sql
-- 今天所有失败
SELECT inspection_type, trigger_source, target, status, error, start_time
FROM inspection_logs WHERE status='error' AND start_time::date = CURRENT_DATE
ORDER BY start_time DESC;
-- 某类最近定时结果明细
SELECT target, status, record_count, result->'criticals' AS crits, start_time
FROM inspection_logs
WHERE trigger_source='scheduled' AND inspection_type='system'
ORDER BY start_time DESC LIMIT 20;
```
> **先确认日志库启用**：`get_config('logDatabase')` 的 `enabled=true`。未启用时 `record_inspection_log` 静默跳过，表里不会有数据（不报错）。在配置页「日志数据库」开启并点测试（会自动建表 `ensure_table_exists`）。

### 5. 慢 SQL 日志（DB 容器内）
`check_slow_sql` 通过 `docker exec` 进 MySQL/PG 容器查慢查询日志（[check_slow_sql.py](modules/inspection/check_slow_sql.py)），依赖宿主 `/var/run/docker.sock` 挂载。**不跑**的原因通常是容器内访问不到 docker socket（检查 deploy.sh 是否挂了 sock）。
清理慢 SQL 容器日志：`POST /api/clear_slow_sql_logs`（[inspection/routes.py](modules/inspection/routes.py)），对匹配 mysql/postgres 的容器 `truncate` 其 docker 日志文件。

## 按现象排查（决策树）

### 定时/日常巡检不跑
1. `get_config('scheduler')` 的 `enabled`、`cron` 是否正确（cron 5 段格式，`*/20 * * * *`）。
2. `dailyInspection.enabled` + `hour/minute`。
3. 目标项是否在对应 item dict：`scheduledInspectionItems` / `dailyInspectionItems`（[config_mgmt/helpers.py](modules/config_mgmt/helpers.py)）。**漏加会静默跳过，无报错**。
4. `./deploy.sh restart` 或重启应用（scheduler 是进程级单例，改配置后必须重启）。
5. 看日志 `[...] ========== 开始启动定时任务 ==========` / `开始执行定时巡检...` 是否出现。
6. `/api/scheduler/status` 看运行态和 next_run_time。

### 钉钉通知不发
1. `get_config('dingtalk')` 的 `enabled=true`、webhooks 非空。
2. **非 daily 类型无异常不通知**（[dingtalk.py](dingtalk.py) `send_inspection_report` 开头）。scheduled/real_time 仅在有 criticals/warnings 时发。
3. daily 的 `only_error_notification`：开=仅异常发；关=总发。确认语义没搞反。
4. **冷却期** `notification_cooldowns`（300s）：同一来源短期内不重复发。等冷却过了再测，或看日志“发送钉钉通知...成功/失败”。
5. webhook 在敏感词/频率限制下 errcode≠0，日志会打印 `发送钉钉通知到 ... 失败: <errmsg>`。

### 巡检漏报异常（最危险）
1. **变量解析口径**：自定义脚本三条路径是否都走 `get_variable_value`（见 `custom-audit-script` skill）。典型症状：`last_n_days` 的 startDate 被算成今天，与 endDate 反向，返回 0 条。
2. 跨月分表：`get_cache_table_months` 是否覆盖了整个区间；`last_n_days` 是否被 clamp 到 28。
3. FULL JOIN 哨兵值两侧不一致会全表误判差异。
4. 报表表漏 `is_deleted=0` 会引入已删数据。
5. `execute_sql` 失败（`columns is None`）被当成空结果而非异常 -> 查 `inspection_logs.error` 或 result 里是否有“MES数据库查询失败”。

### 数据库连不上
1. 配置页点「测试连接」（`/api/config/test_database`）跑 `SELECT 1`。
2. PG 连接带 `options='-c password_encryption=md5'`，目标库若改了认证方式会失败。
3. `inspect_sql`/`export_sql_result` **只支持 mes/hanging**（硬编码），其他库名报“不支持的数据库类型”--用自定义脚本走任意 `databaseConfig` key。
4. 容器内连宿主库：`host` 别写 `localhost`，用宿主 IP 或 `host.docker.internal`。

### 容器起不来 / 异常退出
1. `./deploy.sh logs` 看退出原因（脚本会自动 dump 末尾 30 行）。
2. 端口 59496 被占：`lsof -i:59496`。
3. 配置文件挂载路径错（`CONFIG_DIR/config.json` 不存在 -> 用镜像内默认，可能含旧密码）。
4. 依赖缺失：Dockerfile 已装 procps/sysstat/iproute2/docker-cli；若巡检命令报 not found，检查镜像构建。
5. scheduler 启动失败（cron 格式错等）会在日志打印 traceback 但不阻塞 app.run（debug 模式）。

## 调试建议
- 加 `print(f"[{datetime.datetime.now()}] ...")` 临时定位问题，重跑 `./deploy.sh restart` 看日志（项目惯例就是 print，不必引 logging）。
- 复现定时场景：`POST /api/scheduler/run`（定时）、`/run-daily`（日常）立即触发，不等 cron。
- 临时改期测试自定义脚本：执行时 `params` 传 `{"varName": "2026-07-01"}`，`get_variable_value` 会优先用传入值。
- `inspection_logs.result` JSON 列能回放完整历史结果，比看 app.log 更结构化，排查“上次跑出来啥”优先查表。
