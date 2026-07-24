---
name: custom-audit-script
description: 编写或排查自定义稽核脚本（custom_scripts.json）。说明两种执行模式、变量类型与 #{var} 占位符、动态日期(date_range_type)与 period 年月解析、规则引擎、以及三条执行路径变量口径必须一致这一关键不变量。
---

# 自定义稽核脚本开发

自定义脚本存于 `config/custom_scripts.json`，由 [modules/custom_scripts/helpers.py](modules/custom_scripts/helpers.py) 加载执行，**不改后端代码**，通过 Web 配置页或直接编辑 JSON 即可新增。
若需要新增硬编码的 check 函数（进注册表/调度），用 `add-inspection-check` skill。

## 脚本结构

```jsonc
{
  "id": "12",
  "name": "脚本名",
  "mode": "single_db",          // 或 "cross_db"
  "database": "mes",            // single_db：databaseConfig 里的 key
  "content": "SELECT ... WHERE d = #{report_date}",   // 单库 SQL
  // cross_db 模式不用 database/content，改用：
  // "source_db":"mes", "target_db":"hanging",
  // "source_sql":"...", "target_sql":"...",
  "variables": [ { "name":"report_date", "type":"date", ... } ],
  "rules": [ { "column":"报工次数", "operator":">", "value":"1", "result":"异常" } ],
  "scheduled": false, "daily": true, "realtime": false,  // 三档调度开关
  "created_at": "...", "updated_at": "..."
}
```

## 变量（核心）

占位符语法：`#{varName}`（注意是 `#{}`，不是 `${}`）。执行时被 `format_sql_value(var_type, var_value)` 的结果替换。

| type | 取值方式 | format_sql_value 行为 |
|---|---|---|
| `text` | `params[name]` 或 `default_value` | 单引号包裹，`'` 转义为 `''`；空值 -> `NULL` |
| `number` | 同上 | 原样插值（不加引号） |
| `date` | `params[name]` 或 `default_value`；配 `date_range_type` 时动态算 | 当 text 处理（加引号） |
| `period` | `resolve_period_value()` 动态算，`params[name]` 优先 | 原样插值（用于表名等标识符，**不加引号**） |

### 动态日期 `date_range_type`（运行时解析，非保存快照）
`today` / `yesterday` / `last_n_days` / `last_n_to_yesterday` / `last_n_to_today`。
配合 `last_n_days`（默认 7）算「最近 N 天」。页面执行时若 `params[name]` 传了值则优先用（支持临时改期测试）；定时/通知路径传 `{}`，故**始终动态计算当天日期**。

### period（年月，主要用于分表表名）
`period_type`：`current_month` / `current_year` / `last_month` / `last_year`。
`period_format`：`yyyy` / `yyyy-MM` / `yyyy-M` / `yyyy_MM` / `yyyy_M`。
例：`last_month` + `yyyy_M` 在 2026-07 得 `2026_6`，可拼 `produce_mes_reporting_work_cache_2026_6`。

> **period 不加引号**：因为它通常用于表名/标识符；WHERE 里要用日期值请用 `date` 类型变量，自行在 SQL 里加引号。

## 规则引擎
`rules` 可选。`check_row_against_rules(row, columns, rules)` 把规则分两组：
- **异常组**（`result: "异常"`）：命中任一即判异常，写入 `warnings`。
- **正常组**（其他 `result`）：命中任一判正常。
- 同时命中异常和正常 -> **异常优先**。

`operator` 支持：`>` `>=` `<` `<=` `==` `!=` `=` `is null` `is not null`。`column` 必须与 SELECT 的列别名（中文别名亦可）一致。
无 `rules` 时：查出 0 行算正常，>0 行直接判 warning（“发现 N 条记录”）。

## 三条执行路径（关键不变量）

变量解析**必须**在以下三处走同一个 `get_variable_value()`，切勿复制逻辑：
1. 页面执行：`/api/custom_scripts/<id>/execute`（[custom_scripts/routes.py](modules/custom_scripts/routes.py) `execute_custom_script`）
2. 测试执行：`/api/test_custom_script`（[app.py](app.py)）
3. 定时/日常/实时通知：`run_custom_scripts(script_type)`（helpers.py）

历史教训：曾因测试/通知路径把 `last_n_days` 的 startDate 错解析成“今天”，与固定 endDate 构成反向区间，导致查询返回 0 条而**漏报**。改脚本时若动了变量逻辑，务必确认三处一致（现在已统一到 `get_variable_value`）。

## 调度与通知
- `scheduled`/`daily`/`realtime` 三个布尔控制是否进对应批次（见 [scheduler/routes.py](modules/scheduler/routes.py)）。
- `daily` 支持 `only_error_notification`：开则仅异常通知，关则无论是否异常都通知。
- `scheduled`/`realtime` 仅在有 criticals/warnings 时通知（带 300s 冷却）。
- 自定义脚本结果 category 为 `custom_script_<id>`，钉钉里显示 `script_name`（见 [dingtalk.py](dingtalk.py) 对 `category.startswith('custom_script_')` 的处理）。

## 排查清单
- 查询返回 0 条但预期有数据：检查变量解析是否走了 `get_variable_value`；`date_range_type=last_n_days` 的 startDate 是否被算成今天。
- 通知里不显示脚本结果：确认对应 `scheduled/daily/realtime` 开关为 true。
- 表名拼接报错：period 变量别在 WHERE 里当值用；`date` 变量在 WHERE 里需自己加引号。
- 规则不生效：`column` 名要与结果列别名完全一致（含中文）。
