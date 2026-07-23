"""
配置管理 - 全局配置状态管理中心
所有模块通过此模块访问和修改全局配置
"""

import json
import os
import datetime

# 配置文件路径
CONFIG_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'config', 'config.json')

# ===================== 默认配置（从config.py导入） =====================
from config import (
    SCHEDULER_CONFIG, PROJECT_NAME, INSPECTION_ITEMS, THRESHOLDS,
    DINGTALK_CONFIG, REAL_TIME_MONITORING, DATABASE_CONFIG, INSPECTION_DATE_CONFIG
)

# ===================== 全局配置状态 =====================
_config_state = {
    'projectName': PROJECT_NAME,
    'scheduler': SCHEDULER_CONFIG,
    'dailyInspection': {
        "enabled": False,
        "hour": 17,
        "minute": 0,
        "only_error_notification": False
    },
    'thresholds': THRESHOLDS,
    'inspectionItems': INSPECTION_ITEMS,
    'scheduledInspectionItems': {
        'system_info': True, 'cpu': True, 'memory': True, 'swap': True,
        'disk': True, 'disk_io': True, 'processes': True, 'slow_sql': True,
        'database': True, 'network': True,
        'worker_output_with_color_size': True,
        'worker_output_without_color_size': True,
        'mes_hanging': True
    },
    'dailyInspectionItems': {
        'system_info': True, 'cpu': True, 'memory': True, 'swap': True,
        'disk': True, 'disk_io': True, 'processes': True, 'slow_sql': True,
        'database': True, 'network': True,
        'worker_output_with_color_size': True,
        'worker_output_without_color_size': True,
        'mes_hanging': True
    },
    'fullInspectionItems': {
        'system_info': True, 'cpu': True, 'memory': True, 'swap': True,
        'disk': True, 'disk_io': True, 'processes': True, 'slow_sql': True,
        'database': True, 'network': True,
        'worker_output_with_color_size': True,
        'worker_output_without_color_size': True,
        'worker_output_sfd': True,
        'mes_hanging': True
    },
    'dingtalk': DINGTALK_CONFIG,
    'realTimeMonitoring': REAL_TIME_MONITORING,
    'inspectionDateConfig': INSPECTION_DATE_CONFIG,
    'databaseConfig': DATABASE_CONFIG,
    'arthasServers': [],
    'logDatabase': {
        'enabled': False,
        'type': 'postgresql',
        'host': '',
        'port': 5432,
        'user': '',
        'password': '',
        'database': ''
    }
}

# 通知冷却期记录
notification_cooldowns = {}


def load_config_from_file():
    """从文件加载配置"""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                file_config = json.load(f)
                # 合文件配置覆盖到全局状态
                for key in file_config:
                    if key in _config_state:
                        _config_state[key] = file_config[key]
                return file_config
        except Exception as e:
            print(f"加载配置文件失败: {e}")
    return None


def save_config_to_file(config=None):
    """保存配置到文件"""
    if config is None:
        config = _config_state
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"保存配置文件失败: {e}")
        return False


def get_config(key, default=None):
    """获取配置项"""
    return _config_state.get(key, default)


def set_config(key, value):
    """设置配置项"""
    _config_state[key] = value


def get_all_config():
    """获取所有配置"""
    return _config_state.copy()


def update_config(data):
    """批量更新配置"""
    for key, value in data.items():
        if key in _config_state:
            _config_state[key] = value