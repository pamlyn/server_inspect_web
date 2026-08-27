"""自定义看板 API。

权限模型：
- `custom_dashboard`        查看并执行看板（业务人员）
- `custom_dashboard_manage` 新增/编辑/删除看板（配置看板的人，可授予非开发人员）
区块执行时仍按 `can_access_custom_script` 逐脚本校验，看板不会放大脚本授权范围。
"""

import os

from flask import Blueprint, jsonify, request, send_file, session

from modules.auth.helpers import (
    can_access_custom_dashboard, get_custom_dashboard_access, login_required,
    permission_required,
)
from modules.custom_dashboards import assets as dashboard_assets
from modules.custom_dashboards.helpers import (
    MAX_BLOCKS, dashboards, execute_block, find_dashboard, find_script, load_dashboards,
    normalize_dashboard, save_dashboards, script_metadata, validate_refresh_seconds,
)
from modules.custom_dashboards.helpers import _asset_id as normalize_asset_id

custom_dashboards_bp = Blueprint('custom_dashboards', __name__, url_prefix='/api/custom_dashboards')

# 区块只允许引用脚本 id；出现这些字段说明前端试图直接投递 SQL 或库配置，直接拒绝。
FORBIDDEN_BLOCK_FIELDS = {'content', 'database', 'source_sql', 'target_sql', 'source_db', 'target_db', 'sql'}


def _can_manage(dashboard_id=None):
    username = session.get('username', '')
    if not username or 'custom_dashboard_manage' not in _permissions():
        return False
    return dashboard_id is None or can_access_custom_dashboard(username, dashboard_id, 'manage')


def _permissions():
    from modules.auth.helpers import get_user_permissions
    return get_user_permissions(session.get('username', ''))


def _has_dashboard_feature():
    """有「看板」或「看板配置」任一功能权限。

    原先 app.py 按 /api/custom_dashboards 前缀统一要求 custom_dashboard，
    改成逐看板鉴权后前缀检查已去掉，这里给不针对单个看板的口子（素材库）兜底。
    """
    return bool(_permissions() & {'custom_dashboard', 'custom_dashboard_manage'})


def _can_create():
    username = session.get('username', '')
    access = get_custom_dashboard_access(username)
    return bool(username and 'custom_dashboard_manage' in _permissions()
                and access['manage']['all'])


def _dashboard_summary(dashboard, video_ids=None):
    """列表用的精简信息，避免把全部区块配置塞进列表接口。

    video_ids 是「哪些资源是视频」的集合，由调用方查一次索引后传进来：
    画廊小块要按类型决定渲染 <video> 还是背景图，而前端在列表阶段还没拉资源清单。
    """
    bg_image = dashboard.get('bg_image') or ''
    return {
        'id': dashboard.get('id'),
        'name': dashboard.get('name'),
        'description': dashboard.get('description'),
        'refresh_seconds': dashboard.get('refresh_seconds', 0),
        'theme': dashboard.get('theme') or 'aurora',
        # 画廊小块也拿背景图当封面，这样列表里就能认出是哪个看板
        'bg_image': bg_image,
        'bg_is_video': bool(bg_image and video_ids and bg_image in video_ids),
        # 画廊上要挂个「免登录」角标：开着口子的看板得一眼能认出来
        'public': dashboard.get('public') is True,
        'block_count': len(dashboard.get('blocks') or []),
        'created_at': dashboard.get('created_at'),
        'updated_at': dashboard.get('updated_at'),
    }


def _viewer_may_read(dashboard):
    """看板能不能被当前请求读到，返回 (可以吗, 按谁的权限跑脚本)。

    两条路：
    1. 看板勾了 public——谁都能读，不看 session。脚本按 owner（配置者）的权限跑，
       不是按访客——访客根本没账号，也不能让免登录访问越过脚本授权范围。
    2. 没勾 public——回到原来的规则：必须登录且有 custom_dashboard 权限，按本人权限跑。

    只有这一个判定入口：页面、整板执行、单块执行、背景素材四个口子都走它，
    分散判会漏（漏一个就是页面能开但图裂/数据空，或者反过来把不该开的开了）。
    """
    username = session.get('username', '')
    if dashboard.get('public') is True:
        return True, (dashboard.get('owner') or '')
    if not username or not can_access_custom_dashboard(username, dashboard.get('id'), 'view'):
        return False, ''
    return True, username


def _public_asset_ids():
    """被免登录看板用作背景的素材 id。

    免登录看板的背景图/视频也必须免登录取得，否则页面能开但背景是裂的。
    只放行真的被 public 看板引用的那几个 id，不是整个素材库。
    """
    return {d.get('bg_image') for d in dashboards
            if d.get('public') is True and d.get('bg_image')}


def _reject_raw_sql(payload):
    """校验提交的区块没有夹带 SQL / 数据库配置。"""
    for block in payload.get('blocks') or []:
        if isinstance(block, dict) and FORBIDDEN_BLOCK_FIELDS.intersection(block.keys()):
            return '看板区块只能引用已授权的自定义SQL脚本，不能提交SQL或数据库配置'
    if len(payload.get('blocks') or []) > MAX_BLOCKS:
        return f'单个看板最多 {MAX_BLOCKS} 个区块'
    return None


@custom_dashboards_bp.route('/scripts', methods=['GET'])
@login_required
def dashboard_scripts():
    """仅暴露当前用户可执行脚本的元数据，不暴露 SQL 内容。"""
    dashboard_id = str(request.args.get('dashboard_id') or '').strip()
    if dashboard_id:
        if not _can_manage(dashboard_id):
            return jsonify({'success': False, 'error': '没有该看板的管理权限'}), 403
    elif not _can_create():
        return jsonify({'success': False, 'error': '没有新建看板权限'}), 403
    return jsonify({'success': True, 'scripts': script_metadata(session.get('username', ''))})


@custom_dashboards_bp.route('/preview', methods=['POST'])
@login_required
def preview_script():
    """试跑一次脚本，返回列名和少量样例行，供编辑器把列填进下拉框。

    非开发人员不知道 SQL 会返回什么列，这个接口让他们"先看一眼再选列"。
    """
    data = request.get_json() or {}
    dashboard_id = str(data.get('dashboard_id') or '').strip()
    if dashboard_id:
        if not _can_manage(dashboard_id):
            return jsonify({'success': False, 'error': '没有该看板的管理权限'}), 403
    elif not _can_create():
        return jsonify({'success': False, 'error': '没有新建看板权限'}), 403
    script_id = str(data.get('script_id') or '').strip()
    if not script_id:
        return jsonify({'success': False, 'error': '请选择 SQL 脚本'}), 400

    block = {'type': 'table', 'script_id': script_id, 'params': data.get('params') or {}, 'sort': {}}
    try:
        result = execute_block(block, session.get('username', ''))
    except RuntimeError as error:
        # execute_block 的措辞面向"看板区块"，预览场景下换成配置器能直接展示的说法。
        message = str(error).replace('看板引用的自定义SQL脚本', '所选的SQL脚本').replace('该区块引用的', '')
        return jsonify({'success': False, 'error': message}), 400
    except Exception as error:
        return jsonify({'success': False, 'error': f'脚本预览失败: {error}'}), 500

    return jsonify({
        'success': True,
        'columns': result.get('columns') or [],
        # 20 行而不是 5 行：这批数据同时喂给编辑器的效果预览，行数太少表格预览
        # 看不出真实样子（分页/滚动/跑马灯的差别都体现在行数上）。
        'rows': (result.get('rows') or [])[:20],
        'total': result.get('total', 0),
        'script_name': result.get('script_name', ''),
    })


@custom_dashboards_bp.route('', methods=['GET', 'POST'])
@login_required
def dashboards_api():
    if not _has_dashboard_feature():
        return jsonify({'success': False, 'error': '没有该功能权限'}), 403
    if request.method == 'GET':
        # 资源索引只读一次：每个看板各查一次会把索引文件读 N 遍。
        video_ids = {item.get('id') for item in dashboard_assets.list_assets()
                     if dashboard_assets.is_video(item.get('ext'))}
        visible = [item for item in dashboards
                   if can_access_custom_dashboard(session.get('username', ''), item.get('id'), 'view')]
        return jsonify({
            'success': True,
            'can_create': _can_create(),
            'dashboards': [dict(_dashboard_summary(item, video_ids),
                                can_manage=_can_manage(item.get('id'))) for item in visible],
        })

    if not _can_create():
        return jsonify({'success': False, 'error': '没有看板配置权限，无法新增看板'}), 403

    payload = request.get_json() or {}
    error = _reject_raw_sql(payload)
    if error:
        return jsonify({'success': False, 'error': error}), 400
    if not str(payload.get('name') or '').strip():
        return jsonify({'success': False, 'error': '看板名称不能为空'}), 400
    refresh_seconds, refresh_error = validate_refresh_seconds(payload.get('refresh_seconds'))
    if refresh_error:
        return jsonify({'success': False, 'error': refresh_error}), 400

    # owner 取 session，不取 payload：它决定免登录访问时按谁的权限跑脚本，
    # 让提交方自己填等于可以借任意账号的权限。
    dashboard = normalize_dashboard({**payload, 'id': None, 'refresh_seconds': refresh_seconds,
                                     'owner': session.get('username', '')},
                                    default_theme='command_center')
    dashboards.append(dashboard)
    save_dashboards()
    return jsonify({'success': True, 'dashboard': dashboard, 'message': '看板创建成功'})


def _dashboard_export_payload(dashboard):
    """生成可跨项目复制的看板 JSON；只带脚本名称，不带 SQL 或数据库配置。"""
    payload = {key: value for key, value in dashboard.items()
               if key not in {'id', 'owner', 'created_at', 'updated_at', 'bg_image'}}
    payload['format'] = 'server_inspect_dashboard'
    payload['format_version'] = 1
    blocks = []
    for raw in dashboard.get('blocks') or []:
        block = dict(raw)
        script = find_script(block.get('script_id'))
        block['script_name'] = str(script.get('name') or '') if script else ''
        block.pop('script_id', None)
        blocks.append(block)
    payload['blocks'] = blocks
    return payload


def _dashboard_import_payload(raw):
    """按脚本名称匹配本项目脚本；匹配不到时保留区块并清空脚本引用。"""
    if not isinstance(raw, dict) or raw.get('format') != 'server_inspect_dashboard':
        return None, [], '不是有效的自定义看板 JSON'
    payload = dict(raw)
    payload.pop('format', None)
    payload.pop('format_version', None)
    available = {item['name']: item['id'] for item in script_metadata(session.get('username', ''))}
    unmatched = []
    blocks = []
    for raw_block in payload.get('blocks') or []:
        block = dict(raw_block) if isinstance(raw_block, dict) else {}
        script_name = str(block.pop('script_name', '') or '').strip()
        block['script_id'] = available.get(script_name, '')
        if script_name and not block['script_id']:
            unmatched.append(script_name)
        blocks.append(block)
    payload['blocks'] = blocks
    return payload, sorted(set(unmatched)), None


@custom_dashboards_bp.route('/<dashboard_id>/export', methods=['GET'])
@login_required
def export_dashboard(dashboard_id):
    dashboard = find_dashboard(dashboard_id)
    if not dashboard:
        return jsonify({'success': False, 'error': '看板不存在'}), 404
    # 导出等于把看板配置整份带走，按管理权限而不是查看权限放行。
    if not _can_manage(dashboard_id):
        return jsonify({'success': False, 'error': '没有该看板的管理权限，无法复制JSON'}), 403
    return jsonify({'success': True, 'dashboard_json': _dashboard_export_payload(dashboard)})


@custom_dashboards_bp.route('/import', methods=['POST'])
@login_required
def import_dashboard():
    if not _can_create():
        return jsonify({'success': False, 'error': '没有导入看板权限'}), 403
    body = request.get_json() or {}
    # 兼容两种粘贴方式：包一层 {"dashboard_json": {...}}，或直接把导出的 JSON 整份贴进来。
    raw = body.get('dashboard_json') if isinstance(body.get('dashboard_json'), dict) else body
    payload, unmatched, error = _dashboard_import_payload(raw)
    if error:
        return jsonify({'success': False, 'error': error}), 400
    reject_error = _reject_raw_sql(payload)
    if reject_error:
        return jsonify({'success': False, 'error': reject_error}), 400
    imported = normalize_dashboard({**payload, 'id': None, 'public': False,
                                    'owner': session.get('username', '')},
                                   default_theme='command_center')
    imported['name'] = f"{imported['name']}（导入）"
    dashboards.append(imported)
    save_dashboards()
    return jsonify({'success': True, 'dashboard': imported, 'unmatched_scripts': unmatched,
                    'message': '看板导入成功'})


@custom_dashboards_bp.route('/<dashboard_id>', methods=['GET', 'PUT', 'DELETE'])
def dashboard_api(dashboard_id):
    """读单个看板 / 改 / 删。

    这里没有 @login_required：免登录看板的独立页要靠 GET 拿区块配置才能渲染。
    GET 走 _viewer_may_read 判定，PUT / DELETE 仍旧必须登录 + 有配置权限（下面 _can_manage）。
    """
    dashboard = find_dashboard(dashboard_id)
    if not dashboard:
        return jsonify({'success': False, 'error': '看板不存在'}), 404

    if request.method == 'GET':
        allowed, _ = _viewer_may_read(dashboard)
        if not allowed:
            if 'username' not in session:
                return jsonify({'success': False, 'error': '请先登录'}), 401
            return jsonify({'success': False, 'error': '没有查看自定义看板的权限'}), 403
        # owner 是账号名，免登录访问时不该回给匿名访客。
        payload = {key: value for key, value in dashboard.items() if key != 'owner'}
        return jsonify({'success': True, 'dashboard': payload,
                        'can_manage': _can_manage(dashboard_id)})

    if not _can_manage(dashboard_id):
        return jsonify({'success': False, 'error': '没有该看板的管理权限，无法修改看板'}), 403

    if request.method == 'DELETE':
        dashboards.remove(dashboard)
        save_dashboards()
        return jsonify({'success': True, 'message': '看板删除成功'})

    payload = request.get_json() or {}
    error = _reject_raw_sql(payload)
    if error:
        return jsonify({'success': False, 'error': error}), 400
    if not str(payload.get('name') or '').strip():
        return jsonify({'success': False, 'error': '看板名称不能为空'}), 400
    refresh_seconds, refresh_error = validate_refresh_seconds(payload.get('refresh_seconds'))
    if refresh_error:
        return jsonify({'success': False, 'error': refresh_error}), 400

    updated = normalize_dashboard({
        **payload,
        'id': dashboard['id'],
        'refresh_seconds': refresh_seconds,
        'created_at': dashboard.get('created_at'),
        'updated_at': None,
        # owner 跟着最后一次保存的人走（都是有配置权限的账号），同样不看 payload。
        'owner': session.get('username', ''),
    })
    dashboards[dashboards.index(dashboard)] = updated
    save_dashboards()
    return jsonify({'success': True, 'dashboard': updated, 'message': '看板保存成功'})


@custom_dashboards_bp.route('/<dashboard_id>/execute', methods=['POST'])
def execute_dashboard(dashboard_id):
    """执行整块看板：逐区块执行并隔离异常，单个区块失败不影响其他区块渲染。

    免登录看板走这里时 username 是它的 owner，不是访客——脚本授权范围照旧生效。
    """
    dashboard = find_dashboard(dashboard_id)
    if not dashboard:
        return jsonify({'success': False, 'error': '看板不存在'}), 404

    allowed, username = _viewer_may_read(dashboard)
    if not allowed:
        if 'username' not in session:
            return jsonify({'success': False, 'error': '请先登录'}), 401
        return jsonify({'success': False, 'error': '没有查看自定义看板的权限'}), 403

    results = []
    for block in dashboard.get('blocks') or []:
        try:
            result = execute_block(block, username)
            results.append({'block_id': block.get('id'), 'success': True, 'result': result})
        except RuntimeError as error:
            results.append({'block_id': block.get('id'), 'success': False, 'error': str(error)})
        except Exception as error:
            results.append({'block_id': block.get('id'), 'success': False, 'error': f'区块执行失败: {error}'})

    return jsonify({'success': True, 'dashboard_id': dashboard['id'], 'results': results})


@custom_dashboards_bp.route('/<dashboard_id>/blocks/<block_id>/execute', methods=['POST'])
def execute_single_block(dashboard_id, block_id):
    """单区块刷新，避免为了一个区块重跑整个看板。"""
    dashboard = find_dashboard(dashboard_id)
    if not dashboard:
        return jsonify({'success': False, 'error': '看板不存在'}), 404
    allowed, username = _viewer_may_read(dashboard)
    if not allowed:
        if 'username' not in session:
            return jsonify({'success': False, 'error': '请先登录'}), 401
        return jsonify({'success': False, 'error': '没有查看自定义看板的权限'}), 403
    block = next((item for item in dashboard.get('blocks') or [] if item.get('id') == block_id), None)
    if not block:
        return jsonify({'success': False, 'error': '区块不存在'}), 404

    try:
        result = execute_block(block, username)
    except RuntimeError as error:
        return jsonify({'success': False, 'block_id': block_id, 'error': str(error)}), 400
    except Exception as error:
        return jsonify({'success': False, 'block_id': block_id, 'error': f'区块执行失败: {error}'}), 500

    return jsonify({'success': True, 'block_id': block_id, 'result': result})


@custom_dashboards_bp.route('/assets', methods=['GET', 'POST'])
@login_required
def dashboard_assets_api():
    """背景图列表 / 上传。

    只有配置权限能上传：能往服务器写文件的口子不该对所有看板查看者开放。
    列表放开到「有看板查看或管理任一权限」：只被授权管理某几个看板的人也要能挑背景。
    """
    if not _has_dashboard_feature():
        return jsonify({'success': False, 'error': '没有该功能权限'}), 403
    if request.method == 'GET':
        return jsonify({'success': True, 'assets': dashboard_assets.list_assets()})

    if not _can_manage():
        return jsonify({'success': False, 'error': '没有看板配置权限，无法上传背景图'}), 403

    upload = request.files.get('file')
    if not upload:
        return jsonify({'success': False, 'error': '请选择要上传的图片'}), 400

    # 名字只当展示用，不参与路径拼接，所以这里不做转义只截长度（save_asset 里做）。
    asset, error = dashboard_assets.save_asset(
        upload.stream, request.form.get('name') or upload.filename, session.get('username', '')
    )
    if error:
        return jsonify({'success': False, 'error': error}), 400
    return jsonify({'success': True, 'asset': asset, 'message': '背景图上传成功'})


@custom_dashboards_bp.route('/assets/<asset_id>', methods=['DELETE'])
@login_required
@permission_required('custom_dashboard_manage')
def delete_dashboard_asset(asset_id):
    ok, error = dashboard_assets.delete_asset(normalize_asset_id(asset_id))
    if not ok:
        return jsonify({'success': False, 'error': error}), 400
    return jsonify({'success': True, 'message': '背景图已删除'})


@custom_dashboards_bp.route('/assets/<asset_id>/raw', methods=['GET'])
def serve_dashboard_asset(asset_id):
    """输出背景素材本体。

    id 先过 _asset_id 收敛成 32 位十六进制再查索引，扩展名取自落盘时判定的结果，
    两段都不来自请求，所以拼出来的路径不可能跑出 ASSETS_DIR。

    免登录只对「真的被 public 看板当背景用」的那几个 id 放开：免登录看板的背景
    也得取得到，不然页面能开但背景是裂的。其余素材照旧要登录 + custom_dashboard 权限，
    素材库不会因为开了一个看板就整个对外。
    """
    normalized = normalize_asset_id(asset_id)
    if normalized not in _public_asset_ids():
        if not session.get('username', ''):
            return jsonify({'success': False, 'error': '请先登录'}), 401
        if not _has_dashboard_feature():
            return jsonify({'success': False, 'error': '没有该功能权限'}), 403
    asset = dashboard_assets.find_asset(normalized)
    if not asset:
        return jsonify({'success': False, 'error': '背景图不存在'}), 404
    path = dashboard_assets.asset_path(asset)
    if not os.path.exists(path):
        return jsonify({'success': False, 'error': '背景图文件已丢失'}), 404
    # 背景图内容不会变（改图就是换 id），可以让浏览器长时间缓存。
    # conditional=True 是给视频背景用的：浏览器放 <video> 会发 Range 请求，
    # 不支持 Range 的话 Safari 直接不播（Chrome 能凑合，但要整段下完才开始）。
    return send_file(path, mimetype=dashboard_assets.mime_for(asset['ext']),
                     max_age=86400, conditional=True)


@custom_dashboards_bp.route('/reload', methods=['POST'])
@login_required
@permission_required('custom_dashboard_manage')
def reload_dashboards():
    """从磁盘重载看板配置（容器内手工改过 JSON 后使用）。"""
    load_dashboards()
    return jsonify({'success': True, 'count': len(dashboards), 'message': '看板配置已重载'})
