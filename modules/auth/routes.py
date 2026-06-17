"""
认证模块 - 路由定义
"""

from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, send_file
from modules.auth.helpers import LOGIN_CREDENTIALS, password_errors, captcha_store, login_required, generate_captcha

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/')
def index():
    if 'username' in session:
        return render_template('index.html')
    else:
        return redirect(url_for('auth.login'))


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        captcha_id = request.form.get('captcha_id')
        captcha = request.form.get('captcha')

        # 检查是否需要验证码
        error_count = password_errors.get(username, 0)
        if error_count >= 5:
            # 验证验证码
            if not captcha_id or not captcha:
                return jsonify({'success': False, 'message': '请输入验证码'})

            if captcha_id not in captcha_store:
                return jsonify({'success': False, 'message': '验证码已过期'})

            if captcha.upper() != captcha_store[captcha_id]:
                return jsonify({'success': False, 'message': '验证码错误'})

        # 验证用户名和密码
        if username in LOGIN_CREDENTIALS and LOGIN_CREDENTIALS[username] == password:
            # 登录成功，重置错误计数
            password_errors.pop(username, None)
            # 设置会话
            session['username'] = username
            return jsonify({'success': True, 'message': '登录成功'})
        else:
            # 登录失败，增加错误计数
            password_errors[username] = password_errors.get(username, 0) + 1
            error_count = password_errors[username]
            need_captcha = error_count >= 5
            return jsonify({'success': False, 'message': '用户名或密码错误', 'need_captcha': need_captcha, 'error_count': error_count})
    else:
        return render_template('login.html')


@auth_bp.route('/logout')
def logout():
    session.pop('username', None)
    return redirect(url_for('auth.login'))


@auth_bp.route('/api/captcha')
def get_captcha():
    captcha_id, buffer = generate_captcha()
    response = send_file(buffer, mimetype='image/png')
    response.set_cookie('captcha_id', captcha_id)
    return response