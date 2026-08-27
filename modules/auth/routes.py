"""认证与人员权限管理路由。"""
import uuid
from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, send_file
from werkzeug.security import generate_password_hash
from modules.auth.helpers import (ADMIN_USERNAME, ALL_PERMISSIONS, admin_required, authenticate, captcha_store, get_custom_dashboard_access, get_custom_sql_access, get_public_user_identity, get_user_permissions, get_user_roles, load_auth_data, login_required, normalize_custom_dashboard_scope, normalize_custom_sql_scope, password_errors, save_auth_data, valid_username)
from modules.auth.helpers import generate_captcha

auth_bp = Blueprint('auth', __name__)


def _public_user(user):
    return {key: user.get(key) for key in ('username', 'display_name', 'role_ids', 'enabled')}


@auth_bp.route('/')
def index():
    if 'username' not in session:
        return redirect(url_for('auth.login'))
    from modules.config_mgmt.helpers import get_config
    return render_template(
        'index.html',
        current_user=get_public_user_identity(session['username']),
        project_name=get_config('projectName', '服务器巡检系统'),
    )


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'GET': return render_template('login.html')
    username = (request.form.get('username') or '').strip()
    password = request.form.get('password') or ''
    captcha_id, captcha = request.form.get('captcha_id'), request.form.get('captcha')
    error_count = password_errors.get(username, 0)
    if error_count >= 5:
        if not captcha_id or not captcha: return jsonify({'success': False, 'message': '请输入验证码'})
        if captcha_id not in captcha_store: return jsonify({'success': False, 'message': '验证码已过期'})
        if captcha.upper() != captcha_store[captcha_id]: return jsonify({'success': False, 'message': '验证码错误'})
    if authenticate(username, password):
        password_errors.pop(username, None); session['username'] = username
        return jsonify({'success': True, 'message': '登录成功'})
    password_errors[username] = error_count + 1
    return jsonify({'success': False, 'message': '用户名或密码错误', 'need_captcha': error_count + 1 >= 5, 'error_count': error_count + 1})


@auth_bp.route('/logout')
def logout():
    session.pop('username', None); return redirect(url_for('auth.login'))


@auth_bp.route('/api/captcha')
def get_captcha():
    captcha_id, buffer = generate_captcha(); response = send_file(buffer, mimetype='image/png'); response.set_cookie('captcha_id', captcha_id); return response


@auth_bp.route('/api/auth/access')
@login_required
def access():
    username = session['username']
    return jsonify({'username': username, 'roles': get_user_roles(username), 'permissions': sorted(get_user_permissions(username)), 'is_admin': username == ADMIN_USERNAME, 'permission_labels': ALL_PERMISSIONS, 'custom_sql_access': get_custom_sql_access(username), 'custom_dashboard_access': get_custom_dashboard_access(username)})


@auth_bp.route('/api/auth/custom-sql-options')
@admin_required
def custom_sql_options():
    """返回角色授权用的脚本分类与基本信息，不返回 SQL 正文。"""
    from modules.custom_scripts.helpers import custom_scripts
    scripts = []
    for script in custom_scripts:
        scripts.append({
            'id': str(script.get('id')),
            'name': str(script.get('name') or script.get('id')),
            'category': str(script.get('category') or '').strip() or '未分类',
        })
    scripts.sort(key=lambda item: (item['category'], item['name']))
    return jsonify({
        'categories': sorted({item['category'] for item in scripts}),
        'scripts': scripts,
    })


@auth_bp.route('/api/auth/dashboard-options')
@admin_required
def dashboard_options():
    """返回角色授权所需的看板基本信息，不返回区块配置。"""
    from modules.custom_dashboards.helpers import dashboards
    return jsonify({'dashboards': [
        {'id': str(item.get('id')), 'name': str(item.get('name') or item.get('id'))}
        for item in dashboards
    ]})


@auth_bp.route('/api/auth/roles', methods=['GET', 'POST'])
@admin_required
def roles():
    data = load_auth_data()
    if request.method == 'GET': return jsonify({'roles': data['roles'], 'permissions': ALL_PERMISSIONS})
    payload = request.get_json() or {}; name = str(payload.get('name') or '').strip()
    if not name: return jsonify({'error': '角色名称不能为空'}), 400
    if any(r.get('name') == name for r in data['roles']): return jsonify({'error': '角色名称已存在'}), 400
    permissions = [p for p in payload.get('permissions', []) if p in ALL_PERMISSIONS]
    custom_sql_scope = normalize_custom_sql_scope(payload.get('custom_sql_scope'))
    custom_dashboard_scope = normalize_custom_dashboard_scope(payload.get('custom_dashboard_scope'))
    if custom_dashboard_scope is None:
        custom_dashboard_scope = normalize_custom_dashboard_scope({})
    if 'custom_sql' in permissions and custom_sql_scope['mode'] == 'selected' and not (custom_sql_scope['category_names'] or custom_sql_scope['script_ids']):
        return jsonify({'error': '指定自定义SQL范围时，至少选择一个分类或脚本'}), 400
    data['roles'].append({
        'id': uuid.uuid4().hex[:12], 'name': name,
        'description': str(payload.get('description') or '').strip(),
        'permissions': permissions, 'custom_sql_scope': custom_sql_scope,
        'custom_dashboard_scope': custom_dashboard_scope,
    })
    save_auth_data(data); return jsonify({'message': '角色创建成功'})


@auth_bp.route('/api/auth/roles/<role_id>', methods=['PUT', 'DELETE'])
@admin_required
def role_detail(role_id):
    data = load_auth_data(); role = next((r for r in data['roles'] if r.get('id') == role_id), None)
    if not role: return jsonify({'error': '角色不存在'}), 404
    if role_id == 'system_admin': return jsonify({'error': '系统管理员角色不能修改或删除'}), 400
    if request.method == 'DELETE':
        if any(role_id in u.get('role_ids', []) for u in data['users']): return jsonify({'error': '该角色仍被人员使用，无法删除'}), 400
        data['roles'].remove(role); save_auth_data(data); return jsonify({'message': '角色删除成功'})
    payload = request.get_json() or {}; name = str(payload.get('name') or '').strip()
    if not name: return jsonify({'error': '角色名称不能为空'}), 400
    if any(r.get('name') == name and r.get('id') != role_id for r in data['roles']): return jsonify({'error': '角色名称已存在'}), 400
    permissions = [p for p in payload.get('permissions', []) if p in ALL_PERMISSIONS]
    custom_sql_scope = normalize_custom_sql_scope(payload.get('custom_sql_scope'))
    custom_dashboard_scope = normalize_custom_dashboard_scope(payload.get('custom_dashboard_scope'))
    if custom_dashboard_scope is None:
        custom_dashboard_scope = normalize_custom_dashboard_scope({})
    if 'custom_sql' in permissions and custom_sql_scope['mode'] == 'selected' and not (custom_sql_scope['category_names'] or custom_sql_scope['script_ids']):
        return jsonify({'error': '指定自定义SQL范围时，至少选择一个分类或脚本'}), 400
    role.update({
        'name': name, 'description': str(payload.get('description') or '').strip(),
        'permissions': permissions, 'custom_sql_scope': custom_sql_scope,
        'custom_dashboard_scope': custom_dashboard_scope,
    })
    save_auth_data(data); return jsonify({'message': '角色更新成功'})


@auth_bp.route('/api/auth/users', methods=['GET', 'POST'])
@admin_required
def users():
    data = load_auth_data()
    if request.method == 'GET': return jsonify({'users': [_public_user(u) for u in data['users']]})
    payload = request.get_json() or {}; username = str(payload.get('username') or '').strip()
    password = str(payload.get('password') or '')
    if not valid_username(username): return jsonify({'error': '用户名应为3-32位字母、数字、点、下划线或连字符'}), 400
    if len(password) < 8: return jsonify({'error': '密码至少8位'}), 400
    if any(u.get('username') == username for u in data['users']): return jsonify({'error': '用户名已存在'}), 400
    role_ids = [r for r in payload.get('role_ids', []) if any(x.get('id') == r for x in data['roles'])]
    data['users'].append({'username': username, 'display_name': str(payload.get('display_name') or username).strip(), 'password_hash': generate_password_hash(password), 'role_ids': role_ids, 'enabled': bool(payload.get('enabled', True))})
    save_auth_data(data); return jsonify({'message': '人员创建成功'})


@auth_bp.route('/api/auth/users/<username>', methods=['PUT'])
@admin_required
def user_detail(username):
    data = load_auth_data(); user = next((u for u in data['users'] if u.get('username') == username), None)
    if not user: return jsonify({'error': '人员不存在'}), 404
    if username == ADMIN_USERNAME: return jsonify({'error': '管理员账号不能修改、停用或降权'}), 400
    payload = request.get_json() or {}; password = str(payload.get('password') or '')
    if password and len(password) < 8: return jsonify({'error': '密码至少8位'}), 400
    user['display_name'] = str(payload.get('display_name') or username).strip(); user['enabled'] = bool(payload.get('enabled', True))
    user['role_ids'] = [r for r in payload.get('role_ids', []) if any(x.get('id') == r for x in data['roles'])]
    if password: user['password_hash'] = generate_password_hash(password)
    save_auth_data(data); return jsonify({'message': '人员更新成功'})
