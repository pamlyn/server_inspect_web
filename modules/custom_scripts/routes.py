"""
自定义脚本模块 - 路由定义
"""

from flask import Blueprint, jsonify, request
import datetime

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
        database = data.get('database')
        content = data.get('content')
        variables = data.get('variables', [])
        rules = data.get('rules', [])

        if not name or not content:
            return jsonify({'error': '脚本名称和内容不能为空'}), 400

        if script_id:
            script = next((s for s in custom_scripts if s['id'] == script_id), None)
            if not script:
                return jsonify({'error': '脚本不存在'}), 404

            script['name'] = name
            script['database'] = database
            script['content'] = content
            script['variables'] = variables
            script['rules'] = rules
            script['scheduled'] = data.get('scheduled', False)
            script['daily'] = data.get('daily', False)
            script['realtime'] = data.get('realtime', False)
            script['updated_at'] = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        else:
            new_script = {
                'id': str(script_id_counter),
                'name': name,
                'database': database,
                'content': content,
                'variables': variables,
                'rules': rules,
                'scheduled': data.get('scheduled', False),
                'daily': data.get('daily', False),
                'realtime': data.get('realtime', False),
                'created_at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            }
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


@custom_scripts_bp.route('/<script_id>/execute', methods=['POST'])
@login_required
def execute_custom_script(script_id):
    """执行已保存的自定义脚本"""
    global custom_scripts

    script = next((s for s in custom_scripts if s['id'] == script_id), None)
    if not script:
        return jsonify({'error': '脚本不存在'}), 404

    try:
        params = request.get_json() or {}
        sql_content = script.get('content', '')
        variables = script.get('variables', [])

        for var in variables:
            var_name = var.get('name', '')
            var_type = var.get('type', 'text')
            var_value = params.get(var_name, var.get('default_value', ''))
            formatted_value = format_sql_value(var_type, var_value)
            sql_content = sql_content.replace(f'#{{{var_name}}}', formatted_value)

        DATABASE_CONFIG = get_config('databaseConfig')
        database = script.get('database')
        if database == 'mes':
            db_config = DATABASE_CONFIG.get('mes')
        elif database == 'hanging':
            db_config = DATABASE_CONFIG.get('hanging')
        else:
            return jsonify({'error': '不支持的数据库类型'}), 400

        if not db_config:
            return jsonify({'error': '数据库配置不存在'}), 400

        columns, rows = execute_sql(db_config['type'], db_config, sql_content)
        if columns is None:
            return jsonify({'error': rows}), 500

        return jsonify({'columns': columns, 'rows': rows})
    except Exception as e:
        print(f"执行脚本失败: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# Note: test_custom_script路由注册在app_new.py中，因为它需要在
# /api/test_custom_script路径下，而不是在Blueprint前缀/api/custom_scripts下