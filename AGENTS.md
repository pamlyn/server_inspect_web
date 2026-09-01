# 服务器巡检系统 (server_inspect_web)

基于 Flask 的服务器巡检 + 数据稽核 Web 应用，当前版本 **1.3.0**，运行端口 **59496**。
> 注意：[README.md](README.md) 里写的 5001 端口已过时，实际端口是 59496（见 [app.py:138](app.py#L138)、[deploy.sh:22](deploy.sh#L22)）。

## 快速运行

```bash
# 本地（非容器）
./start.sh          # 一键安装依赖 + 启动，写 app.pid
sh stop.sh          # 停止
python3 app.py      # 直接跑：app.run(debug=True, host='0.0.0.0', port=59496)

# Docker（推荐生产）
./deploy.sh init    # 首次：从 config/*.example 生成 config/config.json
./deploy.sh deploy  # init + pull + start
./deploy.sh logs -f # 跟踪日志
./deploy.sh restart # 改完挂载的配置后重启生效
```

默认登录：`admin` / `Jack_59496`（硬编码在 [modules/auth/helpers.py:13](modules/auth/helpers.py#L13)）。

## 架构

入口 [app.py](app.py)：Flask 工厂 + 注册 6 个 Blueprint + 启动时 `load_config_from_file()` + `__main__` 里启动 scheduler。
`/api/test_custom_script` 路由单独注册在 app.py（因需无 Blueprint 前缀）。

| Blueprint | 前缀 | 职责 |
|---|---|---|
| auth | `/` | 登录/登出/验证码（错 5 次后要验证码） |
| inspection | `/api` | `/inspect`、`/inspect/sql`、`/inspect/mes_hanging`、导出、`/clear_slow_sql_logs` |
| config_mgmt | `/api/config` | 读写配置、测库、测日志库、删库配置、reload |
| scheduler | `/api/scheduler` | 状态、立即跑定时/日常。含 `start_scheduler`、`real_time_monitor` 线程 |
| custom_scripts | `/api/custom_scripts` | 脚本 CRUD + `/execute` |
| arthas | `/api/arthas` | Java Arthas 诊断（SSH 远程 + 本机）。UI 已隐藏但路由仍生效 |

### 配置系统（两层）
- **默认值**：[config.py](config.py) 里的 `SCHEDULER_CONFIG`/`THRESHOLDS`/`DATABASE_CONFIG`/`REAL_TIME_MONITORING` 等。
- **运行时**：`config/config.json` 覆盖默认值。由 [modules/config_mgmt/helpers.py](modules/config_mgmt/helpers.py) 的 `_config_state` 全局 dict 管理，`get_config(key)` / `set_config` / `save_config_to_file`。
- 启动时 `load_config_from_file()` 把文件配置 merge 进 `_config_state`；保存配置后 `start_scheduler()` 会重启调度器。
- `config/config.json`、`config/custom_scripts.json`、`cookies.txt` **被 gitignore**，模板见 `config/*.example`。

### 巡检模块
- [modules/inspection/helpers.py](modules/inspection/helpers.py)：`run_command()`（subprocess shell）、`execute_sql()`（PG/MySQL，`Decimal`/`int` 转 str）、`get_inspection_functions()`（**延迟注册表**，首次访问构建以避免循环导入）、`run_full_inspection()`。
- [models.py](modules/inspection/models.py)：`InspectionResult`（info/warnings/criticals/normals/slow_sqls + 起止时间），`.to_dict()`。
- 每个 `modules/inspection/check_*.py` 的函数返回一个 `InspectionResult`。
- 已注册项：system_info、cpu、memory、swap、disk、disk_io、processes、slow_sql、database、network、worker_output_with_color_size、worker_output_without_color_size、worker_output_sfd、mes_hanging。

### 数据稽核核心（check_worker.py）
对比 MES 明细缓存分表（`jack_mes.produce_mes_reporting_work_cache_{year}_{month}`，**按月分表**）与报表表，用 FULL OUTER JOIN + COALESCE 哨兵值做 null-safe 比对，输出 `check_status`：报表多余记录 / 明细多余记录 / 数量不一致 / 一致。跨月用 `get_cache_table_months()` + `build_cache_union_subquery()` 做 UNION ALL（`last_n_days` 上限 28 天，保证 ≤2 张表）。

### 自定义稽核脚本
存于 `config/custom_scripts.json`，两种模式：`single_db`（database+content）/ `cross_db`（source_db+target_db + source_sql+target_sql）。
- 变量占位 `#{varName}`，类型 text/number/date/period。
- **动态日期** `date_range_type`（today/yesterday/last_n_days/last_n_to_yesterday/last_n_to_today）和 **period**（current_month/last_month 等 + format）都在**运行时**解析，由 [modules/custom_scripts/helpers.py](modules/custom_scripts/helpers.py) 的 `get_variable_value()` 统一处理。
- 规则引擎 `check_row_against_rules()`：异常组 + 正常组，命中任一异常规则即判异常。

### 钉钉通知 & 日志
- [dingtalk.py](dingtalk.py)：`DingTalkNotifier.send_inspection_report()`，含 category 中文名映射；worker/mes_hanging 类**始终**展示明细（即使正常），其他类仅异常时展示。
- [modules/log_storage/helpers.py](modules/log_storage/helpers.py)：单表 `inspection_logs` + JSON 结果列；`record_inspection_log()` 统一入口，日志库未启用时静默跳过；`derive_status()` 推导 success/warning/critical。

## 关键约定与陷阱

1. **变量解析口径必须一致**：页面执行（`execute_custom_script`）、测试（`/api/test_custom_script`）、定时/日常/实时通知（`run_custom_scripts`）三条路径都必须走 `get_variable_value()`，切勿在各处复制日期解析逻辑（曾因此漏报）。见 git log「统一自定义稽核变量解析口径」。
2. **延迟注册表**：新增巡检项要在 `get_inspection_functions()` 里注册；不要在模块顶层直接 import check_*（会循环导入）。
3. **null-safe JOIN 哨兵值**两侧必须一致（`__NULL_STR__`、`-9999`、`1970-01-01`、`-99999`）；改一边漏另一边会全表误判差异。
4. **`check_status` 统计**优先用 `_count_check_status()`（按列名定位，兼容 PG list / MySQL dict）；`check_worker_output_sfd()` 仍用硬编码索引 17，是技术债。
5. **报表表必须带 `is_deleted = 0`**。
6. **`inspect_sql`/`export_sql_result` 只支持 `mes`/`hanging`**（硬编码），自定义脚本才支持任意 `databaseConfig` key。
7. **PG 连接**用 `options='-c password_encryption=md5'`（特定认证配置）。
8. **`worker_output_sfd` 仅在 `fullInspectionItems` 和 `realTimeMonitoring.items`**，不在 scheduled/daily items。
9. **前端 JS 改动**需手 bump [templates/base.html](templates/base.html) 里的 `?v=` 缓存戳，否则浏览器用旧缓存。
10. **配置保存即重启调度器**：改 `config_mgmt` 路由会触发 `start_scheduler()`，注意线程安全。

## 代码风格
- 全中文 UI/注释/commit；后端注释常带「设计/为何」说明。
- 时间统一 `datetime.datetime.now()`（容器内 `TZ=Asia/Shanghai`）。
- `execute_sql` 返回 `(columns, rows)`，失败时 `columns is None` 且 `rows` 是错误信息——调用方按此判错。

## Skill 索引
本仓在 `.Codex/skills/` 下提供 5 个工作流 skill，按场景调用：
- `add-inspection-check` — 新增/修改巡检项或数据稽核（全栈改动清单）
- `custom-audit-script` — 编写自定义稽核脚本（变量/规则/跨库）
- `deploy` — 构建推送镜像 + 容器部署 + 版本号管理
- `code-review` — 针对本项目不变量的代码审查清单
- `troubleshoot-logs` - 故障排查与日志查询（五类日志来源 + 按现象决策树）
