"""
自定义脚本模块 - 路由定义
"""

from flask import Blueprint, jsonify, request
import datetime
import time

from modules.auth.helpers import login_required
from modules.custom_scripts.helpers import custom_scripts, script_id_counter, save_scripts, format_sql_value
from modules.inspection.helpers import execute_sql
from modules.config_mgmt.helpers import get_config

custom_scripts_bp = Blueprint('custom_scripts', __name__, url_prefix='/api/custom_scripts')


@custom_scripts_bp.route('', methods=['GET', 'POST'])
@login_required
def custom_scripts_api():
    """自定义稽核脚本管理"""
    global custom_scripts, script_id_counter

    if request.method == 'GET':
        return jsonify({'scripts': custom_scripts})
    elif request.method == 'POST':
        data = request.json
        script_id = data.get('id')
        name = data.get('name')
        mode = data.get('mode', 'single_db')
        variables = data.get('variables', [])
        rules = data.get('rules', [])

        if not name:
            return jsonify({'error': '脚本名称不能为空'}), 400

        if script_id:
            script = next((s for s in custom_scripts if s['id'] == script_id), None)
            if not script:
                return jsonify({'error': '脚本不存在'}), 404

            script['name'] = name
            script['mode'] = mode
            script['variables'] = variables
            script['rules'] = rules
            script['scheduled'] = data.get('scheduled', False)
            script['daily'] = data.get('daily', False)
            script['realtime'] = data.get('realtime', False)
            script['updated_at'] = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

            if mode == 'single_db':
                script['database'] = data.get('database')
                script['content'] = data.get('content')
                script.pop('source_db', None)
                script.pop('target_db', None)
                script.pop('source_sql', None)
                script.pop('target_sql', None)
            else:
                script['source_db'] = data.get('source_db')
                script['target_db'] = data.get('target_db')
                script['source_sql'] = data.get('source_sql')
                script['target_sql'] = data.get('target_sql')
                script.pop('database', None)
                script.pop('content', None)
        else:
            new_script = {
                'id': str(script_id_counter),
                'name': name,
                'mode': mode,
                'scheduled': data.get('scheduled', False),
                'daily': data.get('daily', False),
                'realtime': data.get('realtime', False),
                'variables': variables,
                'rules': rules,
                'created_at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            }

            if mode == 'single_db':
                new_script['database'] = data.get('database')
                new_script['content'] = data.get('content')
                if not new_script['content']:
                    return jsonify({'error': '脚本内容不能为空'}), 400
            else:
                new_script['source_db'] = data.get('source_db')
                new_script['target_db'] = data.get('target_db')
                new_script['source_sql'] = data.get('source_sql')
                new_script['target_sql'] = data.get('target_sql')
                if not new_script['source_sql'] or not new_script['target_sql']:
                    return jsonify({'error': '源数据库和目标数据库SQL不能为空'}), 400

            custom_scripts.append(new_script)
            script_id_counter += 1

        save_scripts()
        return jsonify({'message': '脚本保存成功'})


@custom_scripts_bp.route('/<script_id>', methods=['GET', 'DELETE', 'PUT'])
@login_required
def custom_script_api(script_id):
    """单个自定义脚本管理"""
    global custom_scripts

    script = next((s for s in custom_scripts if s['id'] == script_id), None)
    if not script:
        return jsonify({'error': '脚本不存在'}), 404

    if request.method == 'GET':
        return jsonify({'script': script})
    elif request.method == 'DELETE':
        custom_scripts = [s for s in custom_scripts if s['id'] != script_id]
        save_scripts()
        return jsonify({'message': '脚本删除成功'})
    elif request.method == 'PUT':
        data = request.json
        script['name'] = data.get('name', script['name'])
        script['database'] = data.get('database', script['database'])
        script['content'] = data.get('content', script['content'])
        script['variables'] = data.get('variables', script.get('variables', []))
        script['rules'] = data.get('rules', script.get('rules', []))
        script['scheduled'] = data.get('scheduled', script.get('scheduled', False))
        script['daily'] = data.get('daily', script.get('daily', False))
        script['realtime'] = data.get('realtime', script.get('realtime', False))
        script['updated_at'] = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        save_scripts()
        return jsonify({'message': '脚本更新成功'})


def get_variable_value(var, params):
    """根据变量配置和参数获取实际变量值。

    最近N天：从 N 天前到今天，起始日期 = 今天 - (N - 1) 天。
    兼容旧配置 date_range_type 取值（last_n_to_yesterday / last_n_to_today）
    统一按“最近N天（含今天）”语义计算。
    """
    var_name = var.get('name', '')
    date_range_type = var.get('date_range_type')
    last_n_days = var.get('last_n_days', 7)

    if date_range_type in ('last_n_days', 'last_n_to_yesterday', 'last_n_to_today'):
        today = datetime.datetime.now()
        start_date = today - datetime.timedelta(days=last_n_days - 1)
        return start_date.strftime('%Y-%m-%d')

    return params.get(var_name, var.get('default_value', ''))


@custom_scripts_bp.route('/<script_id>/execute', methods=['POST'])
@login_required
def execute_custom_script(script_id):
    """执行已保存的自定义脚本"""
    global custom_scripts
    from flask import session

    start_time = datetime.datetime.now()
    start_ts = time.time()
    operator = session.get('username')

    script = next((s for s in custom_scripts if s['id'] == script_id), None)
    if not script:
        return jsonify({'error': '脚本不存在'}), 404

    script_name = script.get('name', script_id)
    mode = script.get('mode', 'single_db')

    try:
        params = request.get_json() or {}
        DATABASE_CONFIG = get_config('databaseConfig')

        if mode == 'single_db':
            sql_content = script.get('content', '')
            variables = script.get('variables', [])

            for var in variables:
                var_name = var.get('name', '')
                var_type = var.get('type', 'text')
                var_value = get_variable_value(var, params)
                formatted_value = format_sql_value(var_type, var_value)
                sql_content = sql_content.replace(f'#{{{var_name}}}', formatted_value)

            database = script.get('database')
            db_config = DATABASE_CONFIG.get(database)
            if not db_config:
                _log_custom_script(start_time, start_ts, operator, script_name, mode, 0, None, '数据库配置不存在')
                return jsonify({'error': '数据库配置不存在'}), 400

            columns, rows = execute_sql(db_config['type'], db_config, sql_content)
            if columns is None:
                _log_custom_script(start_time, start_ts, operator, script_name, mode, 0, None, rows)
                return jsonify({'error': rows}), 500

            record_count = len(rows) if rows else 0
            _log_custom_script(start_time, start_ts, operator, script_name, mode, record_count,
                               {'columns': columns, 'rows': rows}, None)
            return jsonify({'columns': columns, 'rows': rows})
        else:
            source_db = script.get('source_db')
            target_db = script.get('target_db')
            source_sql = script.get('source_sql', '')
            target_sql = script.get('target_sql', '')
            variables = script.get('variables', [])

            for var in variables:
                var_name = var.get('name', '')
                var_type = var.get('type', 'text')
                var_value = get_variable_value(var, params)
                formatted_value = format_sql_value(var_type, var_value)
                source_sql = source_sql.replace(f'#{{{var_name}}}', formatted_value)
                target_sql = target_sql.replace(f'#{{{var_name}}}', formatted_value)

            source_db_config = DATABASE_CONFIG.get(source_db)
            target_db_config = DATABASE_CONFIG.get(target_db)

            if not source_db_config or not target_db_config:
                _log_custom_script(start_time, start_ts, operator, script_name, mode, 0, None, '数据库配置不存在')
                return jsonify({'error': '数据库配置不存在'}), 400

            source_columns, source_rows = execute_sql(source_db_config['type'], source_db_config, source_sql)
            if source_columns is None:
                _log_custom_script(start_time, start_ts, operator, script_name, mode, 0, None, f'源数据库查询失败: {source_rows}')
                return jsonify({'error': f'源数据库查询失败: {source_rows}'}), 500

            target_columns, target_rows = execute_sql(target_db_config['type'], target_db_config, target_sql)
            if target_columns is None:
                _log_custom_script(start_time, start_ts, operator, script_name, mode, 0, None, f'目标数据库查询失败: {target_rows}')
                return jsonify({'error': f'目标数据库查询失败: {target_rows}'}), 500

            result_columns = ['数据源'] + source_columns
            result_rows = []

            for row in source_rows:
                if isinstance(row, dict):
                    result_rows.append(['源数据库'] + [row.get(col, '') for col in source_columns])
                else:
                    result_rows.append(['源数据库'] + list(row))

            for row in target_rows:
                if isinstance(row, dict):
                    result_rows.append(['目标数据库'] + [row.get(col, '') for col in target_columns])
                else:
                    result_rows.append(['目标数据库'] + list(row))

            record_count = len(result_rows)
            _log_custom_script(start_time, start_ts, operator, script_name, mode, record_count,
                               {'columns': result_columns, 'rows': result_rows}, None)
            return jsonify({'columns': result_columns, 'rows': result_rows})
    except Exception as e:
        print(f"执行脚本失败: {e}")
        import traceback
        traceback.print_exc()
        _log_custom_script(start_time, start_ts, operator, script_name, mode, 0, None, str(e))
        return jsonify({'error': str(e)}), 500


def _log_custom_script(start_time, start_ts, operator, script_name, mode, record_count, result, error):
    """记录自定义脚本执行日志（成功/失败统一入口）。"""
    from modules.log_storage.helpers import record_inspection_log
    end_time = datetime.datetime.now()
    status = 'error' if error else 'success'
    mode_label = '跨库对比' if mode == 'cross_db' else '单库'
    if error:
        summary = f"自定义脚本失败[{mode_label}]: {script_name}"
    else:
        summary = f"自定义脚本完成[{mode_label}]: {script_name}，{record_count} 条记录"
    record_inspection_log(
        inspection_type='custom_script', trigger_source='manual',
        target=script_name, operator=operator, status=status,
        start_time=start_time, end_time=end_time,
        duration=f"{time.time() - start_ts:.3f}s",
        summary=summary, record_count=record_count,
        result=result, error=error,
    )


# Note: test_custom_script路由注册在app_new.py中，因为它需要在
# /api/test_custom_script路径下，而不是在Blueprint前缀/api/custom_scripts下