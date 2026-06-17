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
        name = data.get('name')
        database = data.get('database')
        content = data.get('content')
        params = data.get('params', {})
        variables = data.get('variables', [])

        if not content:
            return jsonify({'error': '脚本内容不能为空'}), 400

        sql_content = content
        for var in variables:
            var_name = var.get('name', '')
            var_type = var.get('type', 'text')
            var_value = params.get(var_name, var.get('default_value', ''))
            formatted_value = format_sql_value(var_type, var_value)
            sql_content = sql_content.replace(f'#{{{var_name}}}', formatted_value)

        DATABASE_CONFIG = get_config('databaseConfig')
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
            return jsonify({'success': False, 'error': rows}), 500

        return jsonify({'success': True, 'result': {'columns': columns, 'rows': rows}})
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