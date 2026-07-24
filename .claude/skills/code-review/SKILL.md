---
name: code-review
description: 针对本项目不变量的代码审查清单。覆盖变量解析口径一致性、跨月 UNION ALL、null-safe FULL OUTER JOIN 哨兵值、check_status 统计、SQL 注入面、调度/通知语义、配置项四同步等高频出错点。
---

# 代码审查清单（项目不变量）

对本项目的改动做 review 时，按以下清单逐条核对。每条都对应历史上的真实坑或设计约束。

## A. 变量解析口径一致性（最高优先）
- [ ] 改动若涉及自定义脚本变量取值，确认三条执行路径都走 `get_variable_value()`：页面执行 `execute_custom_script`、测试 `/api/test_custom_script`（[app.py](app.py)）、定时/日常/实时 `run_custom_scripts`（[custom_scripts/helpers.py](modules/custom_scripts/helpers.py)）。
- [ ] 没有在任何路径里复制日期/period 解析逻辑（曾导致 `last_n_days` startDate 被算成今天、与 endDate 反向、返回 0 条漏报）。
- [ ] `date_range_type` 动态类型在定时/通知路径（传 `{}`）能正确取当天值，而非保存时刻的快照。

## B. 数据稽核 SQL（check_worker.py 系列）
- [ ] 跨月分表用 `get_cache_table_months()` + `build_cache_union_subquery()`，没有手写单表名导致跨月漏数据。
- [ ] `last_n_days` 上限被 clamp 到 28（`min(..., 28)`），保证跨月最多 2 张分表。
- [ ] FULL OUTER JOIN 的 COALESCE 哨兵值两侧**完全一致**：`__NULL_STR__`（字符串列）、`-9999`（整数）、`1970-01-01`（日期）、`-99999`（craft_seq）。改一侧漏另一侧会全表误判差异。
- [ ] 报表表查询带 `is_deleted = 0`（`report_mes_user_process_output_cache` / `sfd_repo_mes_sfd_user_process_output_report`）。
- [ ] schema 固定 `jack_mes`，没有被误改成其他值。
- [ ] `check_status` 统计用 `_count_check_status(columns, rows)`（按列名定位，兼容 PG list / MySQL dict），不是硬编码索引。若改动仍残留硬编码索引（如 `check_worker_output_sfd` 的 `row[17]`），记为技术债并提醒。

## C. SQL 与数据安全
- [ ] `execute_sql` 失败判据：`columns is None` 时 `rows` 是错误信息，调用方有处理（不能直接当空结果用）。
- [ ] 用户可控的日期/变量通过 f-string 拼进 SQL：`inspect_sql`/`export_sql_result`/`mes_hanging` 路径直接执行用户 SQL（管理员工具，设计如此），但不要把这类拼接扩散到非 admin 路径。
- [ ] 自定义脚本变量经 `format_sql_value`：text 加引号并转义 `'`，number/period 原样插值（period 用于表名，确认不会被当成值放进 WHERE 而不加引号）。
- [ ] PG 连接保留 `options='-c password_encryption=md5'`（特定认证环境依赖）。
- [ ] `execute_sql` 已把 `Decimal`/`int` 转 str，下游不要假设类型再做强类型比较。

## D. 调度与通知
- [ ] 新增巡检项已加入**四个** item dict：`inspectionItems`/`scheduledInspectionItems`/`dailyInspectionItems`/`fullInspectionItems`（[config_mgmt/helpers.py](modules/config_mgmt/helpers.py) `_config_state`），并在 [config.py](config.py) 的 `INSPECTION_ITEMS` 和 `REAL_TIME_MONITORING.items` 同步默认值。漏加 scheduled 项会静默不跑。
- [ ] 新项已注册进 `get_inspection_functions()`（延迟注册表，**不在顶层 import**）。
- [ ] 新项的中文名已加进 [dingtalk.py](dingtalk.py) category 映射；若需“始终展示明细”已加入对应 `category in [...]` 列表。
- [ ] `daily` 的 `only_error_notification` 语义正确：开=仅异常通知；关=总是通知。
- [ ] `scheduled`/`real_time` 仅在有 criticals/warnings 时通知，且受 `notification_cooldowns` 冷却（300s）。
- [ ] check 函数内 DB 查询失败应 `add_warning` + `continue`/`return`，不要抛异常中断整个批次。

## E. 日志与状态
- [ ] 手动/定时/日常/实时/自定义脚本执行都调了 `record_inspection_log`（成功与失败都记）。
- [ ] 日志库未启用时 `record_inspection_log` 静默跳过，不影响主流程。
- [ ] `derive_status()` 按 criticals>warnings>success 定级，新结果结构保留了 `criticals`/`warnings` 键。

## F. 前端
- [ ] 改了 JS 文件后，bump 了 [templates/base.html](templates/base.html) 对应 `<script>` 的 `?v=` 缓存戳。
- [ ] 新增结果展示走对应 JS（系统类 inspection.js / 数据稽核 sql_inspect.js / 自定义 custom_inspect.js），没有在错误文件里加渲染逻辑。

## G. 部署与配置
- [ ] 若改了版本号，`deploy.sh` 和 `push_image.sh` 两处同步。
- [ ] `config/config.json`、`config/custom_scripts.json`、`cookies.txt` 未被误提交（已 gitignore，含密钥）。
- [ ] 依赖若新增，已加进 [requirements.txt](requirements.txt) 且 Dockerfile 能装上。

## 审查输出建议
- 按严重度排序：先「会漏报/误报异常」（A/B）>「会中断巡检」（D）>「通知缺失」（D/E）>「缓存/展示」（F）>「部署/规范」（G）。
- 对每条问题给出 `file:line` 和具体修复方向，不要泛泛而谈。
