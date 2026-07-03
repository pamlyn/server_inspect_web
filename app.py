"""
服务器巡检系统 - 应用入口
Flask app工厂 + Blueprint注册 + 配置加载 + scheduler启动
"""

from flask import Flask, request, jsonify
import datetime

from modules.config_mgmt.helpers import load_config_from_file

# 创建Flask应用
app = Flask(__name__)
app.secret_key = 'your-secret-key-here'

# 启动时从文件加载配置
load_config_from_file()

# 注册所有Blueprint
from modules.auth.routes import auth_bp
app.register_blueprint(auth_bp)

from modules.inspection.routes import inspection_bp
app.register_blueprint(inspection_bp)

from modules.config_mgmt.routes import config_mgmt_bp
app.register_blueprint(config_mgmt_bp)

from modules.scheduler.routes import scheduler_bp
app.register_blueprint(scheduler_bp)

from modules.custom_scripts.routes import custom_scripts_bp
app.register_blueprint(custom_scripts_bp)

from modules.arthas.routes import arthas_bp
app.register_blueprint(arthas_bp)

# 注册test_custom_script路由（需要独立路径 /api/test_custom_script）
from modules.auth.helpers import login_required
from modules.custom_scripts.helpers import format_sql_value
from modules.inspection.helpers import execute_sql
from modules.config_mgmt.helpers import get_config


@app.route('/api/test_custom_script', methods=['POST'])
@login_required
def test_custom_script():
    """测试自定义脚本"""
    try:
        data = request.json
        mode = data.get('mode', 'single_db')
        params = data.get('params', {})
        variables = data.get('variables', [])
        DATABASE_CONFIG = get_config('databaseConfig')

        if mode == 'single_db':
            database = data.get('database')
            content = data.get('content')

            if not content:
                return jsonify({'success': False, 'error': '脚本内容不能为空'}), 400

            sql_content = content
            for var in variables:
                var_name = var.get('name', '')
                var_type = var.get('type', 'text')
                var_value = params.get(var_name, var.get('default_value', ''))
                formatted_value = format_sql_value(var_type, var_value)
                sql_content = sql_content.replace(f'#{{{var_name}}}', formatted_value)

            db_config = DATABASE_CONFIG.get(database)
            if not db_config:
                return jsonify({'success': False, 'error': '数据库配置不存在'}), 400

            columns, rows = execute_sql(db_config['type'], db_config, sql_content)
            if columns is None:
                return jsonify({'success': False, 'error': rows}), 500

            return jsonify({'success': True, 'result': {'columns': columns, 'rows': rows}})
        else:
            source_db = data.get('source_db')
            target_db = data.get('target_db')
            source_sql = data.get('source_sql', '')
            target_sql = data.get('target_sql', '')

            if not source_sql or not target_sql:
                return jsonify({'success': False, 'error': '源数据库和目标数据库SQL不能为空'}), 400

            for var in variables:
                var_name = var.get('name', '')
                var_type = var.get('type', 'text')
                var_value = params.get(var_name, var.get('default_value', ''))
                formatted_value = format_sql_value(var_type, var_value)
                source_sql = source_sql.replace(f'#{{{var_name}}}', formatted_value)
                target_sql = target_sql.replace(f'#{{{var_name}}}', formatted_value)

            source_db_config = DATABASE_CONFIG.get(source_db)
            target_db_config = DATABASE_CONFIG.get(target_db)

            if not source_db_config or not target_db_config:
                return jsonify({'success': False, 'error': '数据库配置不存在'}), 400

            source_columns, source_rows = execute_sql(source_db_config['type'], source_db_config, source_sql)
            if source_columns is None:
                return jsonify({'success': False, 'error': f'源数据库查询失败: {source_rows}'}), 500

            target_columns, target_rows = execute_sql(target_db_config['type'], target_db_config, target_sql)
            if target_columns is None:
                return jsonify({'success': False, 'error': f'目标数据库查询失败: {target_rows}'}), 500

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

            return jsonify({'success': True, 'result': {'columns': result_columns, 'rows': result_rows}})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    try:
        # 启动定时任务
        from modules.scheduler.routes import start_scheduler
        start_scheduler()

        # 使用端口59496
        port = 59496
        print(f"服务器将运行在端口: {port}")
        app.run(debug=True, host='0.0.0.0', port=port)
    except Exception as e:
        print(f"服务器启动失败: {e}")
        import traceback
        traceback.print_exc()