"""
巡检模块 - 工具函数和注册表
run_command, execute_sql, run_full_inspection, inspection_functions
使用延迟导入避免循环依赖
"""

import subprocess
import decimal

# 延迟导入：check_* 模块从本模块导入 run_command/execute_sql，
# 而本模块需要从 check_* 模块构建 inspection_functions 注册表，
# 所以注册表在第一次访问时才构建（Lazy Registry Pattern）

def run_command(command):
    """执行命令并返回结果"""
    try:
        result = subprocess.run(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=30)
        return str(result.stdout), str(result.stderr), result.returncode
    except subprocess.TimeoutExpired:
        return '', '命令执行超时', 1
    except Exception as e:
        return '', str(e), 1


def execute_sql(database_type, config, sql):
    """执行SQL查询"""
    try:
        import psycopg2
        import pymysql
    except ImportError:
        pass

    conn = None
    cursor = None
    try:
        if database_type == 'postgresql':
            conn = psycopg2.connect(
                host=config['host'], port=config['port'],
                user=config['user'], password=config['password'],
                database=config['database'],
                options='-c password_encryption=md5'
            )
        elif database_type == 'mysql':
            conn = pymysql.connect(
                host=config['host'], port=config['port'],
                user=config['user'], password=config['password'],
                database=config['database'],
                cursorclass=pymysql.cursors.DictCursor
            )
        else:
            return None, "不支持的数据库类型"

        cursor = conn.cursor()
        cursor.execute(sql)
        columns = [desc[0] for desc in cursor.description]
        rows = cursor.fetchall()

        converted_rows = []
        for row in rows:
            if isinstance(row, dict):
                converted_row = {}
                for key, value in row.items():
                    if isinstance(value, decimal.Decimal) or isinstance(value, int):
                        converted_row[key] = str(value)
                    else:
                        converted_row[key] = value
                converted_rows.append(converted_row)
            else:
                converted_row = []
                for value in row:
                    if isinstance(value, decimal.Decimal) or isinstance(value, int):
                        converted_row.append(str(value))
                    else:
                        converted_row.append(value)
                converted_rows.append(converted_row)

        return columns, converted_rows
    except Exception as e:
        return None, str(e)
    finally:
        if cursor: cursor.close()
        if conn: conn.close()


# 延迟注册表 - 第一次访问时才构建
_inspection_functions = None


def get_inspection_functions():
    """获取巡检函数映射（延迟构建，避免循环导入）"""
    global _inspection_functions
    if _inspection_functions is None:
        from modules.inspection.check_system import check_system_info
        from modules.inspection.check_cpu import check_cpu
        from modules.inspection.check_memory import check_memory
        from modules.inspection.check_disk import check_disk, check_disk_io
        from modules.inspection.check_network import check_network
        from modules.inspection.check_processes import check_processes
        from modules.inspection.check_swap import check_swap
        from modules.inspection.check_slow_sql import check_slow_sql
        from modules.inspection.check_database import check_database
        from modules.inspection.check_worker import check_worker_output, check_worker_output_without_color_size, check_worker_output_sfd, check_mes_hanging

        _inspection_functions = {
            'system_info': check_system_info,
            'cpu': check_cpu,
            'memory': check_memory,
            'swap': check_swap,
            'disk': check_disk,
            'disk_io': check_disk_io,
            'processes': check_processes,
            'slow_sql': check_slow_sql,
            'database': check_database,
            'network': check_network,
            'worker_output_with_color_size': check_worker_output,
            'worker_output_without_color_size': check_worker_output_without_color_size,
            'worker_output_sfd': check_worker_output_sfd,
            'mes_hanging': check_mes_hanging
        }
    return _inspection_functions


# 兼容旧代码：inspection_functions 作为属性访问
inspection_functions = property(lambda self: get_inspection_functions())


def run_full_inspection(deduplicate=None):
    """执行完整巡检"""
    if deduplicate is None:
        deduplicate = True
    functions = get_inspection_functions()
    results = {}
    
    from modules.config_mgmt.helpers import get_config
    full_inspection_items = get_config('fullInspectionItems', {})
    
    for item, func in functions.items():
        if full_inspection_items.get(item, True):
            if item == 'slow_sql':
                result = func(deduplicate)
            else:
                result = func()
            results[item] = result.to_dict()
    return results