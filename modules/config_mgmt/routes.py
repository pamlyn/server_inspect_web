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
        return jsonify(config_data)
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