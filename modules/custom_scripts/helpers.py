"""
自定义脚本模块 - helpers
"""

import json
import os
import datetime

from modules.inspection.models import InspectionResult
from modules.inspection.helpers import execute_sql
from modules.config_mgmt.helpers import get_config

# 脚本文件路径
SCRIPTS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'custom_scripts.json')

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


def format_sql_value(var_type, var_value):
    """根据变量类型格式化SQL值"""
    if var_value is None or var_value == '':
        return 'NULL'

    if var_type == 'number':
        return str(var_value)
    else:
        escaped_value = str(var_value).replace("'", "''")
        return f"'{escaped_value}'"


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
                reason = f"{column} {operator} {value} ({result})"
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


def run_custom_scripts(script_type):
    """执行自定义脚本"""
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

            database = script.get('database')
            db_config = None
            if database == 'mes':
                db_config = DATABASE_CONFIG.get('mes')
            elif database == 'hanging':
                db_config = DATABASE_CONFIG.get('hanging')

            if not db_config:
                continue

            content = script.get('content')
            variables = script.get('variables', [])
            today = datetime.datetime.now().strftime('%Y-%m-%d')
            today_start = datetime.datetime.now().strftime('%Y-%m-%d 00:00:00')

            for var in variables:
                var_name = var.get('name', '')
                var_type = var.get('type', 'text')
                var_value = var.get('default_value', '')

                if var_type == 'date' and not var_value:
                    var_value = today
                elif var_type == 'time' and not var_value:
                    var_value = today_start

                formatted_value = format_sql_value(var_type, var_value)
                content = content.replace(f'#{{{var_name}}}', formatted_value)

            columns, rows = execute_sql(db_config['type'], db_config, content)

            if columns is not None:
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
                results[f'custom_script_{script.get("id")}'] = result_dict
        except Exception as e:
            print(f"执行自定义脚本 {script.get('name')} 出错: {e}")

    return results


# 启动时加载脚本
load_scripts()