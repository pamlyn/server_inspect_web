"""
服务器巡检系统 - 应用入口
Flask app工厂 + Blueprint注册 + 配置加载 + scheduler启动
"""

from flask import Flask, request, jsonify, session
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

from modules.log_storage.routes import log_bp
app.register_blueprint(log_bp)

from modules.pg_config.routes import pg_config_bp
app.register_blueprint(pg_config_bp)

from modules.custom_dashboards.routes import custom_dashboards_bp
app.register_blueprint(custom_dashboards_bp)
# 看板独立页（/dashboard/<id>）单独注册：它是页面路由，不能带 /api 前缀。
from modules.custom_dashboards.pages import dashboard_pages_bp
app.register_blueprint(dashboard_pages_bp)

# 注册test_custom_script路由（需要独立路径 /api/test_custom_script）
from modules.auth.helpers import login_required, permission_required, get_user_permissions
from modules.custom_scripts.helpers import format_sql_value, resolve_period_value, get_variable_value
from modules.inspection.helpers import execute_sql
from modules.config_mgmt.helpers import get_config


@app.before_request
def enforce_api_permissions():
    """根据已登录人员的角色权限保护业务接口。"""
    permission_prefixes = (
        ('/api/logs/dashboard', 'dashboard'),
        ('/api/pg', 'pg_config'), ('/api/custom_scripts', 'custom_sql'),
        ('/api/custom_dashboards', 'custom_dashboard'),
        ('/api/logs', 'logs'), ('/api/arthas', 'diagnostics'),
        ('/api/inspect', 'inspection'), ('/api/clear_slow_sql_logs', 'inspection'),
        ('/api/test_custom_script', 'custom_sql'),
    )
    required_permission = next((permission for prefix, permission in permission_prefixes
                                if request.path.startswith(prefix)), None)
    if required_permission and session.get('username') and required_permission not in get_user_permissions(session.get('username', '')):
        return jsonify({'error': '没有该功能权限'}), 403


@app.route('/api/test_custom_script', methods=['POST'])
@login_required
@permission_required('custom_sql')
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
                # 与执行/通知路径共用变量解析口径，统一支持动态 today/yesterday/last_n_days
                var_value = get_variable_value(var, params)
                formatted_value = format_sql_value(var, var_value)
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
            cross_db_config = data.get('cross_db_config', {}) or {}

            if not source_sql or not target_sql:
                return jsonify({'success': False, 'error': '源数据库和目标数据库SQL不能为空'}), 400

            for var in variables:
                var_name = var.get('name', '')
                var_type = var.get('type', 'text')
                var_value = get_variable_value(var, params)
                formatted_value = format_sql_value(var, var_value)
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

            # 跨库对比：按维度列对齐，对比指定列
            from modules.custom_scripts.cross_db import compare_cross_db
            compare_result = compare_cross_db(source_columns, source_rows, target_columns, target_rows, cross_db_config)

            return jsonify({'success': True, 'result': {
                'columns': compare_result.get('columns'),
                'rows': compare_result.get('rows'),
                'summary': compare_result.get('summary'),
                'is_consistent': compare_result.get('is_consistent'),
            }})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    import os
    try:
        # 是否开启 werkzeug reloader（开发热重载）。
        # 开启时 reloader 父进程会 fork 子进程（WERKZEUG_RUN_MAIN=true）重新执行本脚本，
        # 父子进程都会执行本块。定时/实时监控必须只在唯一的服务进程启动，否则双进程会各起一个
        # real_time_monitor 线程，两个线程按 interval 周期独立巡检、起始错开约1s，导致每个监控
        # 周期出现两条相差约1s的巡检日志（如 15:43:11 / 15:43:12）。生产/容器无需热重载，可置 False。
        USE_RELOADER = True
        port = 59496
        print(f"服务器将运行在端口: {port}")
        # reloader 开启→仅子进程(WERKZEUG_RUN_MAIN=true)启动；reloader 关闭→本进程即唯一服务进程，启动
        is_reloader_child = os.environ.get('WERKZEUG_RUN_MAIN') == 'true'
        if (not USE_RELOADER) or is_reloader_child:
            print(f"[{datetime.datetime.now()}] 启动定时/实时监控（PID={os.getpid()}, reloader子进程={is_reloader_child}）")
            from modules.scheduler.routes import start_scheduler
            start_scheduler()
        app.run(debug=True, host='0.0.0.0', port=port, use_reloader=USE_RELOADER)
    except Exception as e:
        print(f"服务器启动失败: {e}")
        import traceback
        traceback.print_exc()