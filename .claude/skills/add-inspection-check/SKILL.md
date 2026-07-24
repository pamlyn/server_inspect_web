---
name: add-inspection-check
description: 新增或修改一个巡检项 / 数据稽核检查。给出后端 check 函数、延迟注册表、调度项配置、钉钉分类映射、前端接入的全栈改动清单，避免漏改导致定时任务不跑或通知不显示。
---

# 新增 / 修改巡检项与数据稽核

本 skill 适用于：新增一个 `check_*` 巡检函数、调整已有稽核 SQL、把稽核项接入定时/日常/实时调度与钉钉通知。
若只是写「自定义稽核脚本」（存到 custom_scripts.json，不改代码），用 `custom-audit-script` skill，不要走这里。

## 改动清单（按顺序核对）

### 1. 后端 check 函数
- 新建 `modules/inspection/check_xxx.py`，或改现有 `check_*.py`。
- 函数签名：**无参**（`slow_sql` 例外，接收 `deduplicate`）。返回 `InspectionResult`，结尾 `result.set_end_time(); return result`。
- 取配置：`from modules.config_mgmt.helpers import get_config`，读阈值/日期/数据库配置。
- 执行命令/SQL：用 `from modules.inspection.helpers import run_command, execute_sql`，**不要自己起 subprocess / psycopg2**。
  - `execute_sql` 失败约定：`columns is None` 时 `rows` 是错误信息。
  - 数据库连接通过 `get_config('databaseConfig').get('mes'/'hanging')` 拿配置再传 `execute_sql(db_config['type'], db_config, sql)`。
- 数据稽核类（对比明细 vs 报表）参考 [check_worker.py](modules/inspection/check_worker.py)：
  - 跨月分表用 `get_cache_table_months()` + `build_cache_union_subquery()`（schema 固定 `jack_mes`）。
  - FULL OUTER JOIN 的 COALESCE 哨兵值（`__NULL_STR__`/`-9999`/`1970-01-01`/`-99999`）两侧必须一致。
  - 报表表查询带 `is_deleted = 0`。
  - 差异统计用 `_count_check_status(columns, rows)`（按列名定位），别用硬编码索引。

### 2. 注册到延迟注册表
在 [modules/inspection/helpers.py](modules/inspection/helpers.py) 的 `get_inspection_functions()` 里：
- 顶部 `from modules.inspection.check_xxx import check_xxx`
- 字典里加 `'item_key': check_xxx,`

**不要**在模块顶层 import check_*（会和注册表构建形成循环导入，整个设计就是为绕开它）。

### 3. 配置项开关（4 处都要加，否则定时/日常不跑）
在 [modules/config_mgmt/helpers.py](modules/config_mgmt/helpers.py) 的 `_config_state` 里，把新 key 加进这些 dict（默认值按业务定，通常 `True`）：
- `inspectionItems` - 页面单项巡检可选
- `scheduledInspectionItems` - 定时巡检
- `dailyInspectionItems` - 日常巡检
- `fullInspectionItems` - 完整巡检

> 注意：`worker_output_sfd` 这类**只在** `fullInspectionItems` + `realTimeMonitoring.items` 出现，不在 scheduled/daily。新增项若不想进定时，就只加 `fullInspectionItems`。

同时在 [config.py](config.py) 的 `INSPECTION_ITEMS`（页面单项默认）和 `REAL_TIME_MONITORING.items`（实时监控默认）补上同名 key，保持默认值一致。

### 4. 钉钉通知分类名
在 [dingtalk.py](dingtalk.py) `send_inspection_report()` 里：
- 把 `'item_key': '中文名'` 加进 category 名映射 dict（约两处 `.get(category, category)` 附近）。
- 若希望该类**始终展示明细**（即使正常，如 worker/mes_hanging 那样），把 key 加进 `category in [...]` 的判断列表（约三处）。

### 5. 前端接入（按类型选）
- **系统类巡检**（cpu/memory/disk…）：结果由 [static/js/inspection.js](static/js/inspection.js) 渲染，单项按钮在 [templates/partials/inspection_section.html](templates/partials/inspection_section.html)。
- **数据稽核/工人产量类**：SQL 生成与结果展示在 [static/js/sql_inspect.js](static/js/sql_inspect.js)，UI 在 [templates/partials/sql_inspect_section.html](templates/partials/sql_inspect_section.html)。
- **调度项勾选开关**：[static/js/config.js](static/js/config.js) + [templates/partials/config/](templates/partials/config/) 下相关 partial。
- 改了任何 JS：**手 bump** [templates/base.html](templates/base.html) 里对应 `<script>` 的 `?v=` 缓存戳，否则浏览器用旧文件。

### 6. 验证
1. `python3 app.py` 启动，登录后页面单项触发该项，看结果。
2. `/api/scheduler/run` 或 `/run-daily` 立即触发，确认该项被纳入（看日志 `[...] 开始执行定时巡检...`）。
3. 若开了日志库，查 `inspection_logs` 表是否落了该 category 的行；`derive_status()` 会按 criticals/warnings 自动定级。

## 常见坑
- 漏加 `scheduledInspectionItems` → 定时巡检不跑该项（无报错，静默跳过）。
- 漏加钉钉分类映射 → 通知里显示英文 key 而非中文名。
- check 函数抛异常会中断**整个**巡检批次（`run_scheduled_inspection` 对每项独立 try，但单函数内异常会冒泡到该 item 失败）。数据库查询失败应 `add_warning` 并 `continue`，参考 `check_worker_output` 对 `columns is None` 的处理。
