"""认证、用户、角色与权限管理。"""
import json
import os
import random
import re
import string
import threading
from functools import wraps
from io import BytesIO
from flask import jsonify, session
from PIL import Image, ImageDraw, ImageFont
from werkzeug.security import check_password_hash, generate_password_hash

AUTH_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'config', 'auth_users.json')
ADMIN_USERNAME = 'admin'
ADMIN_PASSWORD = 'Jack_59496'
CONFIG_TAB_PERMISSIONS = {
    'basic': 'config_basic_alert',
    'inspection': 'config_inspection_strategy',
    'data': 'config_data_notification',
    'custom-sql': 'config_custom_sql',
}
CONFIG_PERMISSION_IDS = set(CONFIG_TAB_PERMISSIONS.values())
ALL_PERMISSIONS = {
    # 保留旧权限以兼容现有角色；新角色请配置下面四项细分权限。
    'system_config': '系统配置（旧版全量）',
    'config_basic_alert': '系统配置：基础与告警',
    'config_inspection_strategy': '系统配置：巡检策略',
    'config_data_notification': '系统配置：数据与通知',
    'config_custom_sql': '系统配置：自定义SQL配置',
    'dashboard': '运行总览',
    'inspection': '巡检执行', 'sql_inspect': '数据稽查',
    'custom_sql': '自定义SQL', 'logs': '巡检日志', 'pg_config': 'PG配置', 'diagnostics': '诊断工具',
}
password_errors = {}
captcha_store = {}


def _default_data():
    return {'roles': [{'id': 'system_admin', 'name': '系统管理员', 'description': '拥有全部功能权限', 'permissions': sorted(ALL_PERMISSIONS)}], 'users': [{'username': ADMIN_USERNAME, 'display_name': '管理员', 'password_hash': generate_password_hash(ADMIN_PASSWORD), 'role_ids': ['system_admin'], 'enabled': True}]}


def load_auth_data():
    if not os.path.exists(AUTH_FILE):
        data = _default_data(); save_auth_data(data); return data
    try:
        with open(AUTH_FILE, 'r', encoding='utf-8') as f: data = json.load(f)
    except Exception:
        data = _default_data()
    data.setdefault('roles', []); data.setdefault('users', [])
    if not any(u.get('username') == ADMIN_USERNAME for u in data['users']):
        data['users'].append(_default_data()['users'][0]); save_auth_data(data)
    return data


def save_auth_data(data):
    os.makedirs(os.path.dirname(AUTH_FILE), exist_ok=True)
    with open(AUTH_FILE, 'w', encoding='utf-8') as f: json.dump(data, f, ensure_ascii=False, indent=2)


def find_user(username):
    return next((u for u in load_auth_data()['users'] if u.get('username') == username), None)


def get_public_user_identity(username):
    """返回仅可用于页面展示的当前登录人信息。"""
    user = find_user(username) or {}
    display_name = str(user.get('display_name') or username).strip() or username
    return {'username': username, 'display_name': display_name}


def get_user_permissions(username):
    if username == ADMIN_USERNAME:
        return set(ALL_PERMISSIONS)
    data = load_auth_data()
    user = next((u for u in data['users'] if u.get('username') == username and u.get('enabled')), None)
    if not user:
        return set()
    role_map = {r.get('id'): r for r in data['roles']}
    permissions = {
        permission
        for role_id in user.get('role_ids', [])
        for permission in role_map.get(role_id, {}).get('permissions', [])
        if permission in ALL_PERMISSIONS
    }
    # 旧角色仅存有 system_config 时，保持四个系统配置页签的原有全量访问。
    if 'system_config' in permissions:
        permissions.update(CONFIG_PERMISSION_IDS)
    return permissions


def has_config_permission(username):
    """用户是否至少拥有一个系统配置页签权限。"""
    return bool(get_user_permissions(username) & CONFIG_PERMISSION_IDS)


def can_access_config_scope(username, scope):
    """校验用户是否可访问指定系统配置页签。"""
    permission = CONFIG_TAB_PERMISSIONS.get(scope)
    return bool(permission and permission in get_user_permissions(username))


def get_user_roles(username):
    data = load_auth_data(); user = next((u for u in data['users'] if u.get('username') == username), {})
    role_map = {r.get('id'): r.get('name', r.get('id')) for r in data['roles']}
    return [role_map[r] for r in user.get('role_ids', []) if r in role_map]


def normalize_custom_sql_scope(scope):
    """规范化角色的自定义 SQL 授权范围；旧角色默认保留全量访问。"""
    if not isinstance(scope, dict):
        return {'mode': 'all', 'category_names': [], 'script_ids': []}
    mode = 'selected' if scope.get('mode') == 'selected' else 'all'
    categories = sorted({str(item).strip() for item in scope.get('category_names', []) if str(item).strip()})
    script_ids = sorted({str(item).strip() for item in scope.get('script_ids', []) if str(item).strip()})
    return {'mode': mode, 'category_names': categories, 'script_ids': script_ids}


def get_custom_sql_access(username):
    """返回用户合并后的自定义 SQL 资源范围。"""
    if username == ADMIN_USERNAME:
        return {'all': True, 'category_names': [], 'script_ids': []}
    data = load_auth_data()
    user = next((u for u in data['users'] if u.get('username') == username and u.get('enabled')), None)
    if not user:
        return {'all': False, 'category_names': [], 'script_ids': []}
    role_map = {role.get('id'): role for role in data['roles']}
    categories, script_ids = set(), set()
    for role_id in user.get('role_ids', []):
        role = role_map.get(role_id, {})
        if 'custom_sql' not in role.get('permissions', []):
            continue
        scope = normalize_custom_sql_scope(role.get('custom_sql_scope'))
        if scope['mode'] == 'all':
            return {'all': True, 'category_names': [], 'script_ids': []}
        categories.update(scope['category_names'])
        script_ids.update(scope['script_ids'])
    return {'all': False, 'category_names': sorted(categories), 'script_ids': sorted(script_ids)}


def can_access_custom_script(username, script):
    access = get_custom_sql_access(username)
    if access['all']:
        return True
    category = str(script.get('category') or '').strip() or '未分类'
    return category in access['category_names'] or str(script.get('id')) in access['script_ids']


def authenticate(username, password):
    user = find_user(username)
    if not user or not user.get('enabled'): return False
    stored = user.get('password_hash', '')
    return check_password_hash(stored, password) if stored else False


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'username' not in session: return jsonify({'error': '请先登录'}), 401
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if session.get('username') != ADMIN_USERNAME: return jsonify({'error': '仅管理员可执行此操作'}), 403
        return f(*args, **kwargs)
    return decorated


def permission_required(permission):
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if permission not in get_user_permissions(session.get('username', '')): return jsonify({'error': '没有该功能权限'}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator


def valid_username(username):
    return bool(re.fullmatch(r'[A-Za-z0-9_.-]{3,32}', str(username or '')))


def generate_captcha():
    captcha_text = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))
    image = Image.new('RGB', (120, 40), 'white')
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 24)
    except OSError:
        font = ImageFont.load_default()
    draw.text((24, 8), captcha_text, font=font, fill=(30, 30, 30))
    buffer = BytesIO(); image.save(buffer, format='PNG'); buffer.seek(0)
    captcha_id = ''.join(random.choices(string.ascii_letters + string.digits, k=20))
    captcha_store[captcha_id] = captcha_text
    threading.Timer(300, lambda: captcha_store.pop(captcha_id, None)).start()
    return captcha_id, buffer
