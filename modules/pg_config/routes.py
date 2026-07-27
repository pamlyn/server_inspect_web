"""
PostgreSQL 容器配置管理 - 路由定义
前缀 /api/pg
"""

from flask import Blueprint, jsonify, request

from modules.auth.helpers import login_required
from modules.pg_config.helpers import (
    get_pg_config, save_pg_config, list_pg_containers,
    read_pg_settings, alter_system_setting, reload_conf, apply_preset,
    PG_SETTINGS_WHITELIST, validate_value,
)

pg_config_bp = Blueprint('pg_config', __name__, url_prefix='/api/pg')


@pg_config_bp.route('/config', methods=['GET', 'POST'])
@login_required
def pg_config():
    """读取/保存 PG 容器配置（默认容器名、用户）"""
    if request.method == 'GET':
        return jsonify(get_pg_config())
    data = request.json or {}
    container = data.get('container')
    user = data.get('user')
    if container is not None and not str(container).strip():
        return jsonify({'error': '容器名不能为空'}), 400
    saved = save_pg_config(container=container, user=user)
    return jsonify({'message': '保存成功', 'config': saved})


@pg_config_bp.route('/containers', methods=['GET'])
@login_required
def containers():
    """列出宿主上疑似 PostgreSQL 的容器"""
    containers_list, err = list_pg_containers()
    if err:
        return jsonify({'error': err}), 500
    return jsonify({'containers': containers_list, 'default': get_pg_config()})


@pg_config_bp.route('/settings', methods=['GET'])
@login_required
def settings():
    """读取可管理参数当前值"""
    container = request.args.get('container')
    user = request.args.get('user')
    settings_list, err = read_pg_settings(container=container, user=user)
    if err:
        return jsonify({'error': err}), 500
    return jsonify({
        'settings': settings_list,
        'config': get_pg_config(),
        'whitelist': {k: {'label': v.get('label', k), 'help': v.get('help')}
                      for k, v in PG_SETTINGS_WHITELIST.items()},
    })


@pg_config_bp.route('/setting', methods=['POST'])
@login_required
def set_setting():
    """设置单个参数（ALTER SYSTEM SET）+ 可选 reload"""
    data = request.json or {}
    name = data.get('name')
    value = data.get('value')
    container = data.get('container')
    user = data.get('user')
    do_reload = data.get('reload', True)

    if name is None or value is None:
        return jsonify({'error': '缺少 name 或 value'}), 400

    # 先做白名单校验，给前端更友好的错误
    ok_v, normalized, err_v = validate_value(name, value)
    if not ok_v:
        return jsonify({'error': err_v}), 400

    ok, err = alter_system_setting(name, value, container, user)
    if not ok:
        return jsonify({'error': err}), 500

    reload_result = None
    if do_reload:
        ok_r, err_r = reload_conf(container, user)
        reload_result = {'success': ok_r, 'error': err_r if not ok_r else None}

    setting_meta = PG_SETTINGS_WHITELIST.get(name, {})
    return jsonify({
        'message': '设置成功',
        'name': name,
        'value': normalized,
        'reload': reload_result,
        'note': 'postmaster 级别参数（如 logging_collector）需重启 PG 容器才生效，reload 无效'
        if setting_meta.get('context') == 'postmaster' else None,
    })


@pg_config_bp.route('/reload', methods=['POST'])
@login_required
def reload():
    """单独重载 PG 配置（pg_reload_conf）"""
    data = request.json or {}
    container = data.get('container')
    user = data.get('user')
    ok, err = reload_conf(container, user)
    if not ok:
        return jsonify({'error': err}), 500
    return jsonify({'message': '配置已重载（仅 sighup 级参数即时生效）'})


@pg_config_bp.route('/apply_preset', methods=['POST'])
@login_required
def preset():
    """一键应用推荐配置（对应提供的 5 条命令）"""
    data = request.json or {}
    container = data.get('container')
    user = data.get('user')
    do_reload = data.get('reload', True)
    result, err = apply_preset(container, user, reload=do_reload)
    # 即使部分失败也返回 200，由前端展示每条结果
    return jsonify(result)
