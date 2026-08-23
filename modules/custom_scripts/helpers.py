"""
自定义脚本模块 - helpers
"""

import json
import os
import datetime

from modules.inspection.models import InspectionResult
from modules.inspection.helpers import execute_sql
from modules.config_mgmt.helpers import get_config
from modules.custom_scripts.cross_db import (
    compare_cross_db, cross_db_summary_text, cross_db_config_to_text,
)

# 脚本文件路径
SCRIPTS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'config', 'custom_scripts.json')

# 脚本存储
custom_scripts = []
script_id_counter = 1


def load_scripts():
    """从文件加载脚本"""
    global custom_scripts, script_id_counter
    if os.path.exists(SCRIPTS_FILE):
        try:
            with open(SCRIPTS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                custom_scripts = data.get('scripts', [])
                script_id_counter = data.get('next_id', 1)
        except Exception as e:
            print(f"加载脚本失败: {e}")

    # 校正历史遗留的重复 id（重新分配），并同步 next_id。
    # 部署/容器重启后文件可能被覆盖或回退到旧版本，导致文件内的 id
    # 与内存 script_id_counter 不同步：此处以文件实际状态为准重新校正，
    # 避免后续新增脚本时分配到与现有脚本冲突的 id。
    if _normalize_ids():
        save_scripts()
    script_id_counter = max(script_id_counter, _max_existing_id() + 1)


def _max_existing_id():
    """返回当前脚本列表中最大的数值 id（忽略非数字 id），无则返回 0。"""
    max_id = 0
    for s in custom_scripts:
        try:
            sid = int(s.get('id'))
            if sid > max_id:
                max_id = sid
        except (TypeError, ValueError):
            continue
    return max_id


def allocate_script_id():
    """分配一个不与现有脚本冲突的新 id（字符串）。

    基于 custom_scripts 中最大的数值 id + 1 计算，而非依赖模块级
    script_id_counter——后者在容器重启或文件被外部覆盖后会与文件实际
    状态不同步，曾导致新增脚本分配到已存在的 id（重复 id）。
    同时推进 script_id_counter，保证写入文件的 next_id 不落后。
    """
    global script_id_counter
    base = max(_max_existing_id(), script_id_counter - 1)
    next_id = base + 1
    script_id_counter = next_id + 1
    return str(next_id)


def _normalize_ids():
    """校正重复 id：对出现多次的 id 重新分配，返回是否有改动。"""
    seen = set()
    changed = False
    for s in custom_scripts:
        sid = str(s.get('id', ''))
        if sid in seen:
            new_id = allocate_script_id()  # 基于当前最大 id + 1，天然不与现有 id 冲突
            s['id'] = new_id
            seen.add(new_id)
            changed = True
        else:
            seen.add(sid)
    if changed:
        print(f"[{datetime.datetime.now()}] 检测到重复脚本 id，已自动重新分配并校正 next_id")
    return changed


def save_scripts():
    """保存脚本到文件"""
    global custom_scripts, script_id_counter
    try:
        data = {
            'scripts': custom_scripts,
            'next_id': script_id_counter
        }
        with open(SCRIPTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"保存脚本失败: {e}")


def _split_collection_values(value):
    """将逗号、中文逗号或换行分隔的集合值规范化为非空元素列表。"""
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        raw_values = value
    else:
        raw_values = str(value).replace('，', ',').replace('\r', '\n').split(',')
    values = []
    for raw_value in raw_values:
        values.extend(part.strip() for part in str(raw_value).split('\n') if part.strip())
    return values


def format_sql_value(variable_or_type, var_value):
    """根据变量配置格式化 SQL 值，支持集合变量安全展开。"""
    if isinstance(variable_or_type, dict):
        var_type = variable_or_type.get('type', 'text')
        collection_item_type = variable_or_type.get('collection_item_type', 'text')
    else:
        var_type = variable_or_type
        collection_item_type = 'text'

    if var_type == 'collection':
        values = _split_collection_values(var_value)
        if not values:
            return 'NULL'
        if collection_item_type == 'number':
            normalized_values = []
            for value in values:
                try:
                    normalized_values.append(str(int(value)))
                except ValueError:
                    try:
                        normalized_values.append(str(float(value)))
                    except ValueError:
                        raise ValueError(f'集合变量包含无效数字: {value}')
            return ', '.join(normalized_values)
        return ', '.join("'" + value.replace("'", "''") + "'" for value in values)

    if var_value is None or var_value == '':
        return 'NULL'
    if var_type == 'number':
        return str(var_value)
    if var_type == 'period':
        # 年月/周期变量主要用于表名等标识符（如 produce_mes_reporting_work_cache_2026_7），
        # 不做引号包装，原样插值；WHERE 等场景由用户在 SQL 中自行加引号。
        return str(var_value)
    escaped_value = str(var_value).replace("'", "''")
    return f"'{escaped_value}'"


def resolve_period_value(period_type, period_format='yyyy-MM'):
    """根据周期类型和格式计算年月值。

    period_type: current_month / current_year / last_month / last_year
    period_format: yyyy / yyyy-MM / yyyy-M / yyyy_MM / yyyy_M
    返回示例：2026 / 2026-07 / 2026-7 / 2026_07 / 2026_7
    """
    today = datetime.datetime.now()

    if period_type == 'last_year':
        target = today.replace(year=today.year - 1, day=1)
    elif period_type == 'last_month':
        if today.month == 1:
            target = today.replace(year=today.year - 1, month=12, day=1)
        else:
            target = today.replace(month=today.month - 1, day=1)
    else:
        # current_month / current_year / 未知类型均按当前月处理
        target = today

    year = target.year
    month = target.month

    if period_format == 'yyyy':
        return f"{year}"
    elif period_format == 'yyyy-MM':
        return f"{year}-{month:02d}"
    elif period_format == 'yyyy-M':
        return f"{year}-{month}"
    elif period_format == 'yyyy_MM':
        return f"{year}_{month:02d}"
    elif period_format == 'yyyy_M':
        return f"{year}_{month}"
    else:
        return f"{year}-{month:02d}"


def get_variable_value(var, params):
    """根据变量配置和参数获取实际变量值。

    动态日期类型（date_range_type）在运行时解析，保证定时/日常/实时通知每次
    都取最新日期，而不是保存脚本那一刻的快照：
      - last_n_days（含 last_n_to_yesterday / last_n_to_today）：最近N天，起始 = 今天 - (N - 1)
      - today：今天
      - yesterday：昨天
    执行路径(execute_custom_script)若显式传入值则优先使用（支持临时改期测试），
    否则按上述规则动态计算；定时/通知路径传入 {} 故始终动态计算。
    年月(period)：按当前日期动态解析（当前月/当前年/上个月/去年），优先使用前端传值。

    页面执行与定时/日常/实时通知共用本函数，确保变量解析口径一致。
    """
    var_name = var.get('name', '')
    var_type = var.get('type', 'text')
    date_range_type = var.get('date_range_type')
    last_n_days = var.get('last_n_days', 7)

    if var_type == 'period':
        computed = resolve_period_value(
            var.get('period_type'),
            var.get('period_format', 'yyyy-MM'))
        return params.get(var_name) or computed

    today = datetime.datetime.now()

    if date_range_type in ('last_n_days', 'last_n_to_yesterday', 'last_n_to_today'):
        # 执行路径若显式传值则优先，否则按“最近N天（含今天）”计算
        if params.get(var_name):
            return params.get(var_name)
        start_date = today - datetime.timedelta(days=last_n_days - 1)
        return start_date.strftime('%Y-%m-%d')

    if date_range_type == 'today':
        return params.get(var_name) or today.strftime('%Y-%m-%d')

    if date_range_type == 'yesterday':
        yesterday = today - datetime.timedelta(days=1)
        return params.get(var_name) or yesterday.strftime('%Y-%m-%d')

    return params.get(var_name, var.get('default_value', ''))


def check_row_against_rules(row, columns, rules):
    """根据规则检查单行数据是否异常

    规则组方案：
    1. 将规则分为异常规则组和正常规则组
    2. 异常组：满足任一规则即判定为异常
    3. 正常组：满足任一规则即判定为正常
    4. 如果同时满足异常和正常规则，异常优先
    """
    if not rules:
        return False, []

    abnormal_reasons = []
    normal_reasons = []

    for rule in rules:
        column = rule.get('column')
        operator = rule.get('operator')
        value = rule.get('value')
        result = rule.get('result', '异常')

        if not column or not operator:
            continue

        try:
            column_index = columns.index(column)
            row_value = row[column_index]

            rule_value = value

            if isinstance(row_value, (int, float)):
                try:
                    rule_value = float(value)
                except (ValueError, TypeError):
                    continue

            is_match = False
            if operator == '>' and row_value > rule_value:
                is_match = True
            elif operator == '>=' and row_value >= rule_value:
                is_match = True
            elif operator == '<' and row_value < rule_value:
                is_match = True
            elif operator == '<=' and row_value <= rule_value:
                is_match = True
            elif operator == '==' and row_value == rule_value:
                is_match = True
            elif operator == '!=' and row_value != rule_value:
                is_match = True
            elif operator == '=' and row_value == rule_value:
                is_match = True
            elif operator == 'is null' and row_value is None:
                is_match = True
            elif operator == 'is not null' and row_value is not None:
                is_match = True

            if is_match:
                abnormal_description = str(rule.get('abnormal_description') or '').strip()
                reason = abnormal_description if result == '异常' and abnormal_description else f"{column} {operator} {value} ({result})"
                if result == '异常':
                    abnormal_reasons.append(reason)
                else:
                    normal_reasons.append(reason)
        except (ValueError, IndexError):
            continue

    if abnormal_reasons:
        return True, abnormal_reasons
    elif normal_reasons:
        return False, normal_reasons
    else:
        return False, []


def _resolve_variables_for_scheduled(variables):
    """定时任务场景下解析变量值：返回 {变量名: 格式化后SQL值} 字典。

    与页面执行(execute_custom_script)/测试(test_custom_script)路径共用
    get_variable_value 解析口径，保证 date_range_type（today/yesterday/
    last_n_days 等）在定时/日常/实时通知时也动态取当天值，避免漏报。
    date/time 无动态配置且无默认值时兜底取今天/今天开始时间。
    """
    today = datetime.datetime.now().strftime('%Y-%m-%d')
    today_start = datetime.datetime.now().strftime('%Y-%m-%d 00:00:00')
    resolved = {}

    for var in variables:
        var_name = var.get('name', '')
        var_type = var.get('type', 'text')
        # 定时路径传空 params，强制按 date_range_type/period 动态计算
        var_value = get_variable_value(var, {})

        # date/time 无动态配置且无默认值时兜底（保留原定时场景行为）
        if var_type == 'date' and not var_value:
            var_value = today
        elif var_type == 'time' and not var_value:
            var_value = today_start

        resolved[var_name] = format_sql_value(var, var_value)
    return resolved


def _apply_variables(sql_content, variables):
    """把变量占位符 #{name} 替换为解析后的值，返回替换后的 SQL。"""
    if not sql_content:
        return sql_content
    resolved = _resolve_variables_for_scheduled(variables)
    for var_name, formatted_value in resolved.items():
        sql_content = sql_content.replace(f'#{{{var_name}}}', formatted_value)
    return sql_content


def run_custom_scripts(script_type):
    """执行自定义脚本（定时/日常/实时触发）。

    支持 single_db 与 cross_db 两种模式：
    - single_db: 执行单库 SQL，按 rules 判定异常行
    - cross_db:  执行两库 SQL，按维度对齐对比，不一致/缺失计入告警
    """
    global custom_scripts
    results = {}
    DATABASE_CONFIG = get_config('databaseConfig')

    for script in custom_scripts:
        try:
            if script_type == 'scheduled' and not script.get('scheduled', False):
                continue
            elif script_type == 'daily' and not script.get('daily', False):
                continue
            elif script_type == 'realtime' and not script.get('realtime', False):
                continue

            mode = script.get('mode', 'single_db')
            if mode == 'cross_db':
                result_dict = _run_cross_db_script_scheduled(script, DATABASE_CONFIG)
            else:
                result_dict = _run_single_db_script_scheduled(script, DATABASE_CONFIG)

            if result_dict is not None:
                results[f'custom_script_{script.get("id")}'] = result_dict
        except Exception as e:
            print(f"执行自定义脚本 {script.get('name')} 出错: {e}")
            import traceback
            traceback.print_exc()

    return results


def _run_single_db_script_scheduled(script, database_config):
    """定时场景执行单库脚本，返回 to_dict 结果（失败返回 None）。"""
    database = script.get('database')
    db_config = None
    if database == 'mes':
        db_config = database_config.get('mes')
    elif database == 'hanging':
        db_config = database_config.get('hanging')

    if not db_config:
        return None

    content = _apply_variables(script.get('content'), script.get('variables', []))
    columns, rows = execute_sql(db_config['type'], db_config, content)

    if columns is None:
        script_result = InspectionResult()
        script_result.add_info(f"执行自定义脚本: {script.get('name')}")
        script_result.add_warning(f"自定义脚本 {script.get('name')} 执行失败: {rows}")
        script_result.set_end_time()
        result_dict = script_result.to_dict()
        result_dict['script_name'] = script.get('name')
        result_dict['script_mode'] = 'single_db'
        return result_dict

    script_result = InspectionResult()
    script_result.add_info(f"执行自定义脚本: {script.get('name')}")
    script_result.add_info(f"查询结果: {len(rows)} 条记录")

    rules = script.get('rules', [])
    if rules:
        abnormal_rows = []
        abnormal_reasons_set = set()

        for row in rows:
            is_abnormal, reasons = check_row_against_rules(row, columns, rules)
            if is_abnormal:
                abnormal_rows.append(row)
                abnormal_reasons_set.update(reasons)

        if abnormal_rows:
            script_result.add_warning(f"自定义脚本 {script.get('name')} 发现 {len(abnormal_rows)} 条异常记录（共 {len(rows)} 条记录）")
            for reason in abnormal_reasons_set:
                script_result.add_warning(f"异常原因: {reason}")
        else:
            script_result.add_normal(f"自定义脚本 {script.get('name')} 未发现异常（共 {len(rows)} 条记录）")
    else:
        if len(rows) > 0:
            script_result.add_warning(f"自定义脚本 {script.get('name')} 发现 {len(rows)} 条记录")
        else:
            script_result.add_normal(f"自定义脚本 {script.get('name')} 未发现异常")

    script_result.set_end_time()
    result_dict = script_result.to_dict()
    result_dict['script_name'] = script.get('name')
    result_dict['script_mode'] = 'single_db'
    return result_dict


def _run_cross_db_script_scheduled(script, database_config):
    """定时场景执行跨库对比脚本，返回 to_dict 结果（含跨库 summary，失败返回 None）。

    不一致/仅单库数据计入 warnings，用于触发钉钉告警。
    """
    source_db = script.get('source_db')
    target_db = script.get('target_db')
    source_db_config = database_config.get(source_db)
    target_db_config = database_config.get(target_db)

    script_result = InspectionResult()
    script_result.add_info(f"执行自定义脚本: {script.get('name')}（跨库对比）")

    if not source_db_config or not target_db_config:
        script_result.add_warning(f"自定义脚本 {script.get('name')} 数据库配置不存在，跳过")
        script_result.set_end_time()
        result_dict = script_result.to_dict()
        result_dict['script_name'] = script.get('name')
        result_dict['script_mode'] = 'cross_db'
        return result_dict

    variables = script.get('variables', [])
    source_sql = _apply_variables(script.get('source_sql', ''), variables)
    target_sql = _apply_variables(script.get('target_sql', ''), variables)

    source_columns, source_rows = execute_sql(source_db_config['type'], source_db_config, source_sql)
    if source_columns is None:
        script_result.add_warning(f"自定义脚本 {script.get('name')} 源数据库查询失败: {source_rows}")
        script_result.set_end_time()
        result_dict = script_result.to_dict()
        result_dict['script_name'] = script.get('name')
        result_dict['script_mode'] = 'cross_db'
        return result_dict

    target_columns, target_rows = execute_sql(target_db_config['type'], target_db_config, target_sql)
    if target_columns is None:
        script_result.add_warning(f"自定义脚本 {script.get('name')} 目标数据库查询失败: {target_rows}")
        script_result.set_end_time()
        result_dict = script_result.to_dict()
        result_dict['script_name'] = script.get('name')
        result_dict['script_mode'] = 'cross_db'
        return result_dict

    cross_db_config = script.get('cross_db_config', {}) or {}
    compare_result = compare_cross_db(source_columns, source_rows, target_columns, target_rows, cross_db_config)
    summary = compare_result.get('summary', {})

    script_result.add_info(f"跨库配置: {cross_db_config_to_text(cross_db_config)}")
    script_result.add_info(f"对比结果: {cross_db_summary_text(summary)}")

    if compare_result.get('is_consistent'):
        script_result.add_normal(f"自定义脚本 {script.get('name')} 跨库对比一致（{cross_db_summary_text(summary)}）")
    else:
        script_result.add_warning(f"自定义脚本 {script.get('name')} 跨库对比发现差异（{cross_db_summary_text(summary)}）")

    script_result.set_end_time()
    result_dict = script_result.to_dict()
    result_dict['script_name'] = script.get('name')
    result_dict['script_mode'] = 'cross_db'
    result_dict['cross_db_summary'] = summary
    result_dict['is_consistent'] = compare_result.get('is_consistent')
    return result_dict


# 启动时加载脚本
load_scripts()