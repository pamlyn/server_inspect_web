"""看板独立页面路由。

单独一个 Blueprint 而不是挂在 custom_dashboards_bp 上：后者前缀是 /api/custom_dashboards，
而这里要的是一个能直接分享、直接收藏的短地址 /dashboard/<id>。

未登录会跳到登录页（同一套 session），没有看板权限则返回 403 页面，
所以这个地址是"登录后可直接访问"，不是公开匿名地址。
"""

from flask import Blueprint, redirect, render_template, session, url_for

from modules.auth.helpers import can_access_custom_dashboard, get_public_user_identity
from modules.custom_dashboards.helpers import LIGHT_THEMES, find_dashboard

dashboard_pages_bp = Blueprint('dashboard_pages', __name__)


@dashboard_pages_bp.route('/dashboard/<dashboard_id>')
def dashboard_page(dashboard_id):
    """看板独立页：新窗口打开、可直接分享地址。

    这里不再统一拦未登录：勾了「免登录」的看板要能被没有账号的机器打开（挂大屏的
    电视没人守着去登录）。未登录访问没勾的看板，仍然跳登录页。
    """
    username = session.get('username', '')
    dashboard = find_dashboard(dashboard_id)
    is_public = bool(dashboard and dashboard.get('public') is True)

    # 未登录 + 不是免登录看板 -> 跳登录页，不返回 JSON。
    # 不能用 auth.helpers 里的 login_required——它返回 401 JSON，那是给 /api 用的。
    # 看板不存在时也走这条：否则未登录的人能靠状态码探出哪些 id 存在。
    if not username and not is_public:
        return redirect(url_for('auth.login'))

    # 免登录看板对匿名访客不查权限；登录用户照旧要有 custom_dashboard 权限。
    if not is_public and not can_access_custom_dashboard(username, dashboard_id, 'view'):
        return render_template('dashboard_standalone.html', denied='没有查看该自定义看板的权限',
                               dashboard=None, current_user=get_public_user_identity(username)), 403

    if not dashboard:
        return render_template('dashboard_standalone.html', denied='看板不存在或已被删除',
                               dashboard=None, current_user=get_public_user_identity(username)), 404

    from modules.config_mgmt.helpers import get_config
    return render_template(
        'dashboard_standalone.html',
        denied=None,
        dashboard=dashboard,
        can_manage=bool(username) and can_access_custom_dashboard(username, dashboard_id, 'manage'),
        # 匿名访客看到的页面要去掉「全部看板」「返回主界面」这些登录后才有意义的入口。
        is_anonymous=not username,
        project_name=get_config('projectName', '服务器巡检系统'),
        current_user=get_public_user_identity(username),
        # 浅色主题名单交给模板判断，省得在模板里硬编码一串主题名
        light_themes=LIGHT_THEMES,
        # 背景是视频还是图片：视频得渲染成 <video>，CSS 的 background-image 放不了视频。
        # 在这里判而不在模板里判：类型来自上传时按文件头存下的 ext，模板拿不到资源索引。
        bg_is_video=_bg_is_video(dashboard),
    )


def _bg_is_video(dashboard):
    """看板背景是不是视频。查不到资源就当图片处理（模板会退回背景图那条路）。"""
    from modules.custom_dashboards import assets as dashboard_assets
    asset_id = dashboard.get('bg_image') or ''
    if not asset_id:
        return False
    asset = dashboard_assets.find_asset(asset_id)
    return bool(asset and dashboard_assets.is_video(asset.get('ext')))


@dashboard_pages_bp.route('/dashboard/')
def dashboard_index():
    """没带 id 时回到主界面的看板列表。"""
    return redirect(url_for('auth.index'))
