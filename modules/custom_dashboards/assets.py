"""看板背景图的存储层。

存放位置是 config/dashboard_assets/：config 目录已经整个挂载到宿主机
（见 deploy.sh 的挂载说明），放这里图片才能在容器重建后还在。

安全口径，三条都必须守住：
1. **按文件头判类型，不看扩展名也不看 Content-Type**——两者都由上传方说了算。
   只放行 PNG / JPEG / GIF / WEBP 的魔术字节。
2. **文件名由服务端生成**（uuid4().hex + 固定扩展名），不用上传方给的名字。
   用原名就得处理路径穿越、同名覆盖、超长名、控制字符一堆事。
3. **有大小上限**，先读一段判类型，再落盘时按块累计计数，超限就中止并删掉半个文件。
   不这么做的话，一个大文件就能把挂载盘写满。
"""

import datetime
import json
import os
import tempfile
import threading
import uuid

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
ASSETS_DIR = os.path.join(BASE_DIR, 'config', 'dashboard_assets')
INDEX_FILE = os.path.join(ASSETS_DIR, 'index.json')

MAX_ASSET_BYTES = 6 * 1024 * 1024      # 单张背景图上限 6MB
# 视频上限单独放宽到 30MB：同样时长的动态背景，GIF 只能糊成一两秒，
# MP4 能给到十几秒的清晰画面，用图片那个 6MB 卡视频等于视频不可用。
MAX_VIDEO_BYTES = 30 * 1024 * 1024
MAX_ASSETS = 40                        # 总张数上限，避免挂载盘被慢慢填满
_CHUNK = 64 * 1024

_LOCK = threading.RLock()

# 文件头 -> 扩展名。WEBP 要同时看 RIFF 和 WEBP 两段。
_SIGNATURES = (
    (b'\x89PNG\r\n\x1a\n', 'png'),
    (b'\xff\xd8\xff', 'jpg'),
    (b'GIF87a', 'gif'),
    (b'GIF89a', 'gif'),
    # WebM/MKV 都是 EBML 容器，同一个魔术字节；按 webm 存，浏览器按内容解，不看后缀。
    (b'\x1aE\xdf\xa3', 'webm'),
)

# 视频扩展名集合：上限、前端渲染方式（<video> 而不是 background-image）都按这个分流。
VIDEO_EXTS = ('mp4', 'webm')

_MIME_BY_EXT = {
    'png': 'image/png', 'jpg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
    'mp4': 'video/mp4', 'webm': 'video/webm',
}


def _now():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def detect_image_ext(head):
    """按文件头判断类型，返回扩展名；不认识的一律返回空串。

    MP4 的魔术字节不在开头：前 4 字节是 box 长度，第 5~8 字节才是 'ftyp'，
    所以它只能按偏移判，不能进 _SIGNATURES 那张前缀表。
    """
    for signature, ext in _SIGNATURES:
        if head.startswith(signature):
            return ext
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return 'webp'
    if head[4:8] == b'ftyp':
        return 'mp4'
    return ''


def is_video(ext):
    return str(ext or '') in VIDEO_EXTS


def max_bytes_for(ext):
    return MAX_VIDEO_BYTES if is_video(ext) else MAX_ASSET_BYTES


def mime_for(ext):
    return _MIME_BY_EXT.get(ext, 'application/octet-stream')


def _load_index():
    if not os.path.exists(INDEX_FILE):
        return []
    try:
        with open(INDEX_FILE, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
        items = data.get('assets', []) if isinstance(data, dict) else []
        return [item for item in items if isinstance(item, dict) and item.get('id')]
    except (OSError, ValueError, TypeError) as error:
        print(f"[{_now()}] 读取背景图索引失败: {error}")
        return []


def _save_index(items):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    payload = {'assets': items, 'updated_at': _now()}
    handle, temp_path = tempfile.mkstemp(dir=ASSETS_DIR, suffix='.tmp')
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)
        os.replace(temp_path, INDEX_FILE)
    except OSError as error:
        print(f"[{_now()}] 写入背景图索引失败: {error}")
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def list_assets():
    """返回背景图列表（不含文件内容），新的在前。"""
    with _LOCK:
        return sorted(_load_index(), key=lambda item: item.get('created_at', ''), reverse=True)


def find_asset(asset_id):
    with _LOCK:
        return next((item for item in _load_index() if item.get('id') == asset_id), None)


def asset_path(asset):
    """资源在磁盘上的绝对路径。文件名由 id + ext 拼成，两段都是服务端生成的。"""
    return os.path.join(ASSETS_DIR, f"{asset['id']}.{asset['ext']}")


def save_asset(stream, display_name, uploader):
    """把上传流落盘，返回 (asset, error)。

    先读 32 字节判类型再决定要不要继续写：类型不对就不该在磁盘上留任何东西。
    """
    with _LOCK:
        index = _load_index()
        if len(index) >= MAX_ASSETS:
            return None, f'背景图数量已达上限 {MAX_ASSETS} 张，请先删掉一些'

        head = stream.read(32)
        if not head:
            return None, '上传的文件是空的'
        ext = detect_image_ext(head)
        if not ext:
            return None, '只支持 PNG / JPG / GIF / WEBP 图片和 MP4 / WEBM 视频'
        limit = max_bytes_for(ext)

        asset_id = uuid.uuid4().hex
        os.makedirs(ASSETS_DIR, exist_ok=True)
        target = os.path.join(ASSETS_DIR, f'{asset_id}.{ext}')
        total = len(head)
        try:
            with open(target, 'wb') as file:
                file.write(head)
                while True:
                    chunk = stream.read(_CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limit:
                        # 超限就地中止：不能先收完再判，那样上限就形同虚设。
                        file.close()
                        os.unlink(target)
                        kind = '视频' if is_video(ext) else '图片'
                        return None, f'{kind}不能超过 {limit // (1024 * 1024)}MB'
                    file.write(chunk)
        except OSError as error:
            try:
                os.unlink(target)
            except OSError:
                pass
            return None, f'保存图片失败: {error}'

        asset = {
            'id': asset_id,
            'ext': ext,
            'name': (str(display_name or '').strip() or '背景图')[:60],
            'size': total,
            'uploader': str(uploader or '')[:40],
            'created_at': _now(),
        }
        index.append(asset)
        _save_index(index)
        return asset, None


def delete_asset(asset_id):
    """删除背景图。返回 (成功, 错误)。已被看板引用时拒绝删除。"""
    with _LOCK:
        index = _load_index()
        asset = next((item for item in index if item.get('id') == asset_id), None)
        if not asset:
            return False, '背景图不存在'

        # 延迟导入：assets 被 helpers 间接用到，模块级导入会成环。
        from modules.custom_dashboards.helpers import dashboards
        used_by = [d.get('name') for d in dashboards if d.get('bg_image') == asset_id]
        if used_by:
            return False, f"这张图正被看板使用中：{'、'.join(used_by[:3])}"

        try:
            os.unlink(asset_path(asset))
        except OSError:
            pass  # 文件已经没了也算删成功，索引照样要清掉
        _save_index([item for item in index if item.get('id') != asset_id])
        return True, None
