"""
配置管理模块 - 路由定义
"""

from flask import Blueprint, jsonify, request
import datetime

from modules.auth.helpers import login_required
from modules.config_mgmt.helpers import get_config, set_config, get_all_config, update_config, save_config_to_file, load_config_from_file

config_mgmt_bp = Blueprint('config_mgmt', __name__, url_prefix='/api/config')


@config_mgmt_bp.route('', methods=['GET', 'POST'])
@login_required
def config():
    """配置管理"""
    if request.method == 'GET':
        # 从文件重新加载配置
        load_config_from_file()
        config_data = get_all_config()
        print(f"返回配置: {config_data}")
        # no-store：避免浏览器缓存配置 JSON，确保部署/重启后页面始终读取最新配置
        response = jsonify(config_data)
        response.headers['Cache-Control'] = 'no-store'
        return response
    elif request.method == 'POST':
        data = request.json
        print(f"收到配置数据: {data}")
        if not data:
            return jsonify({'error': '配置数据不能为空'}), 400

        # 更新全局配置
        update_config(data)

        # 保存配置到文件
        save_result = save_config_to_file(data)
        print(f"保存配置结果: {save_result}")

        # 重启定时任务
        from modules.scheduler.routes import scheduler, start_scheduler, stop_real_time_monitor
        if scheduler:
            try:
                scheduler.shutdown(wait=True)
            except Exception as e:
                print(f"停止定时任务时出错: {e}")

        stop_real_time_monitor()
        start_scheduler()

        print('保存配置完成')
        return jsonify({'message': '配置保存成功'})


@config_mgmt_bp.route('/test_database', methods=['POST'])
@login_required
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
        
        from modules.log_storage.helpers import ensure_table_exists
        success, message = ensure_table_exists(db_type, config)
        
        if success:
            return jsonify({'success': True, 'message': '日志数据库连接测试成功，表已创建'})
        else:
            return jsonify({'success': False, 'error': message}), 500
    except Exception as e:
        print(f"测试日志数据库连接失败: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@config_mgmt_bp.route('/database/<db_id>', methods=['DELETE'])
@login_required
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