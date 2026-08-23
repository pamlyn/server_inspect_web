"""
配置管理模块 - 路由定义
"""

from flask import Blueprint, jsonify, request, session
import datetime

from modules.auth.helpers import (can_access_config_scope, login_required,
                                  permission_required)
from modules.config_mgmt.helpers import get_config, set_config, get_all_config, update_config, save_config_to_file, load_config_from_file

config_mgmt_bp = Blueprint('config_mgmt', __name__, url_prefix='/api/config')

CONFIG_SCOPE_KEYS = {
    'basic': {'projectName', 'thresholds'},
    'inspection': {
        'scheduler', 'dailyInspection', 'realTimeMonitoring', 'resourceHistoryMonitoring', 'inspectionItems',
        'scheduledInspectionItems', 'dailyInspectionItems', 'fullInspectionItems',
        'inspectionDateConfig',
    },
    'data': {'dingtalk', 'databaseConfig', 'logDatabase'},
    'custom-sql': set(),
}


def _config_scope():
    scope = (request.args.get('scope') or '').strip()
    if scope not in CONFIG_SCOPE_KEYS:
        return None, (jsonify({'error': '系统配置页签无效'}), 400)
    if not can_access_config_scope(session.get('username', ''), scope):
        return None, (jsonify({'error': '没有该系统配置页签权限'}), 403)
    return scope, None


def _scoped_config(scope):
    config = get_all_config()
    return {key: config.get(key) for key in CONFIG_SCOPE_KEYS[scope]}


@config_mgmt_bp.route('', methods=['GET', 'POST'])
@login_required
def config():
    """按已授权页签读取或保存系统配置，避免跨页签读取敏感字段。"""
    scope, error = _config_scope()
    if error:
        return error
    if request.method == 'GET':
        load_config_from_file()
        response = jsonify(_scoped_config(scope))
        response.headers['Cache-Control'] = 'no-store'
        return response

    data = request.get_json() or {}
    if not data:
        return jsonify({'error': '配置数据不能为空'}), 400
    allowed_keys = CONFIG_SCOPE_KEYS[scope]
    data = {key: value for key, value in data.items() if key in allowed_keys}
    if not data:
        return jsonify({'error': '当前页签没有可保存的系统配置'}), 400

    # 已从页面移除钉钉 Secret 配置；保存通知配置时保留已有签名配置。
    if scope == 'data' and 'dingtalk' in data and 'secret' not in data['dingtalk']:
        existing_dingtalk = get_config('dingtalk', {}) or {}
        if existing_dingtalk.get('secret'):
            data['dingtalk']['secret'] = existing_dingtalk['secret']

    if scope == 'inspection':
        monitoring = data.get('resourceHistoryMonitoring')
        if monitoring is not None:
            monitoring['interval_seconds'] = max(30, int(monitoring.get('interval_seconds', 60)))
            monitoring['retention_days'] = max(1, int(monitoring.get('retention_days', 90)))
            monitoring['enabled'] = bool(monitoring.get('enabled', True))

    update_config(data)
    save_result = save_config_to_file(get_all_config())
    if not save_result:
        return jsonify({'error': '配置保存失败'}), 500

    # 仅巡检策略变更才需要重启调度任务。
    if scope == 'inspection':
        from modules.scheduler.routes import scheduler, start_scheduler
        if scheduler:
            try:
                scheduler.shutdown(wait=True)
            except Exception as error:
                print(f"停止定时任务时出错: {error}")
        start_scheduler()
    return jsonify({'message': '配置保存成功'})


@config_mgmt_bp.route('/database-options', methods=['GET'])
@login_required
@permission_required('custom_sql')
def database_options():
    """自定义 SQL 仅获取可选数据库名称，不返回连接参数或密码。"""
    return jsonify({'databases': sorted(get_all_config().get('databaseConfig', {}))})


@config_mgmt_bp.route('/test_database', methods=['POST'])
@login_required
@permission_required('config_data_notification')
def test_database():
    """测试数据库连接"""
    try:
        data = request.json
        db_type = data.get('type')
        host = data.get('host')
        port = data.get('port')
        user = data.get('user')
        password = data.get('password')
        database = data.get('database')
        
        from modules.inspection.helpers import execute_sql
        
        config = {
            'type': db_type,
            'host': host,
            'port': port,
            'user': user,
            'password': password,
            'database': database
        }
        
        columns, rows = execute_sql(db_type, config, 'SELECT 1')
        if columns is None:
            return jsonify({'success': False, 'error': rows}), 500
        
        return jsonify({'success': True, 'message': '数据库连接测试成功'})
    except Exception as e:
        print(f"测试数据库连接失败: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@config_mgmt_bp.route('/test_log_database', methods=['POST'])
@login_required
@permission_required('config_data_notification')
def test_log_database():
    """测试日志数据库连接并创建表"""
    try:
        data = request.json
        db_type = data.get('type')
        host = data.get('host')
        port = data.get('port')
        user = data.get('user')
        password = data.get('password')
        database = data.get('database')
        
        config = {
            'host': host,
            'port': port,
            'user': user,
            'password': password,
            'database': database
        }
        
        from modules.log_storage.helpers import ensure_resource_metrics_table, ensure_table_exists
        success, message = ensure_table_exists(db_type, config)
        if success:
            success, message = ensure_resource_metrics_table(db_type, config)

        if success:
            return jsonify({'success': True, 'message': '日志数据库连接测试成功，日志与资源指标表已创建'})
        else:
            return jsonify({'success': False, 'error': message}), 500
    except Exception as e:
        print(f"测试日志数据库连接失败: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@config_mgmt_bp.route('/database/<db_id>', methods=['DELETE'])
@login_required
@permission_required('config_data_notification')
def delete_database_config(db_id):
    """删除数据库配置"""
    if db_id in ['mes', 'hanging']:
        return jsonify({'error': '系统预设数据库（mes, hanging）不能删除'}), 400

    try:
        config_data = get_all_config()
        if db_id not in config_data.get('databaseConfig', {}):
            return jsonify({'error': '数据库配置不存在'}), 404

        del config_data['databaseConfig'][db_id]
        update_config(config_data)
        save_config_to_file(config_data)

        return jsonify({'message': '数据库配置删除成功'})
    except Exception as e:
        print(f"删除数据库配置失败: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@config_mgmt_bp.route('/reload', methods=['POST'])
@login_required
@permission_required('config_inspection_strategy')
def reload_config():
    """重新加载配置"""
    try:
        file_config = load_config_from_file()

        # 重启定时任务
        from modules.scheduler.routes import scheduler, start_scheduler
        if scheduler:
            try:
                scheduler.shutdown(wait=True)
            except Exception as e:
                print(f"停止定时任务时出错: {e}")

        start_scheduler()

        print('配置重新加载成功')
        return jsonify({'message': '配置重新加载成功'})
    except Exception as e:
        print(f"重新加载配置失败: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500