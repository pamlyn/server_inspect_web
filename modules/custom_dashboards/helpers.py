"""自定义看板 - JSON 存储、配置规范化与区块执行。

设计要点（为何这样做）：
1. **看板区块只引用已保存的自定义SQL脚本 id，绝不接收前端传来的 SQL / 数据库配置**。
   看板的目标用户是非开发人员，若允许提交 SQL，等于给了任意人一个越权查询入口；
   引用脚本可以直接复用 `custom_scripts` 已有的分类授权（can_access_custom_script）。
2. 变量解析统一走 `modules.custom_scripts.helpers.get_variable_value`，与页面执行 /
   测试 / 定时通知口径一致（见 CLAUDE.md 关键约定 1，曾因各处复制日期逻辑漏报）。
3. 区块执行相互隔离：单个区块失败只影响自己，返回 error 文本，其余区块照常渲染。
"""

import datetime
import errno
import json
import os
import re
import tempfile
import threading
import uuid

from modules.auth.helpers import can_access_custom_script
from modules.config_mgmt.helpers import get_config
from modules.custom_scripts.cross_db import compare_cross_db
# 用模块引用而不是 `from ... import custom_scripts`：脚本列表在别处可能被就地更新，
# 直接导入名字容易在重载后指向旧列表对象，导致新增脚本在看板里选不到。
from modules.custom_scripts import helpers as custom_scripts_helpers
from modules.custom_scripts.helpers import format_sql_value, get_variable_value
from modules.inspection.helpers import execute_sql

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
DASHBOARDS_FILE = os.path.join(BASE_DIR, 'config', 'custom_dashboards.json')

# 区块类型：指标卡 / 表格 / 柱状图 / 折线图 / 饼图 / 进度条 / 文本说明
ALLOWED_BLOCK_TYPES = ('metric', 'table', 'bar', 'line', 'pie', 'progress', 'text')
ALLOWED_SORT_DIRECTIONS = ('asc', 'desc')
ALLOWED_AGGREGATES = ('first', 'sum', 'avg', 'max', 'min', 'count')
ALLOWED_TRENDS = ('none', 'up_good', 'up_bad')
# 看板背景主题（独立页 + 画廊小块封面共用），只允许这几种，避免自由输入背景样式。
ALLOWED_THEMES = (
    # 深色系（挂大屏用得最多）
    'aurora', 'midnight', 'ocean', 'ember', 'forest', 'plum', 'slate',
    'indigo', 'teal', 'navy', 'olive', 'maroon', 'cocoa', 'denim', 'jade', 'rust',
    'iron', 'violet', 'pine', 'onyx', 'cobalt', 'amethyst', 'brick', 'lagoon', 'moor', 'bronze',
    # 深色渐变系（三段色差拉得更大，层次更明显）
    'nebula', 'abyss', 'aurora_borealis', 'sunset', 'cyber', 'moss', 'graphite', 'wine',
    'tropic', 'magma', 'galaxy', 'peacock', 'dusk', 'reef', 'orchid', 'copper', 'glacier',
    'twilight', 'lava', 'jungle', 'neonight', 'harbor', 'blaze', 'iris', 'canyon', 'spruce',
    'nightfall', 'punch', 'tide', 'nebula2', 'verdant',
    # 浅色系（白天办公室看着不刺眼）
    'daylight', 'linen', 'mint', 'sakura', 'sand', 'seafoam', 'pearl', 'blossom', 'celadon',
    'ivory', 'porcelain', 'peach', 'lilac', 'sky', 'oat', 'lemonade', 'rosewater', 'aqua',
    'cloud', 'honey', 'fresco', 'basil', 'parchment', 'glaze', 'coral', 'frost',
)
# 区块底色预设。custom 时用 block.bg_color 里的自定义色值。
ALLOWED_BLOCK_BACKGROUNDS = ('theme', 'glass', 'solid', 'frost', 'outline', 'shadow', 'custom')
# 表头底色没有配置项：那条横带跟着这一块的底色走（见 styles.css 里 .dash-table th 的注释）。
# 之前试过给它单独一套档位/取色器，配置项多了反而每次都要额外琢磨一次，效果还不如直接跟随。
ALLOWED_ALIGNS = ('left', 'center', 'right')
# 字号用档位而不是让用户填 px：填错（比如 200）会把看板撑坏，档位天然有上下界。
ALLOWED_TITLE_SIZES = ('xs', 'sm', 'md', 'lg', 'xl')
ALLOWED_VALUE_SIZES = ('sm', 'md', 'lg', 'xl', 'xxl', 'huge')
ALLOWED_TABLE_SIZES = ('xs', 'sm', 'md', 'lg', 'xl', 'xxl')
# 表格显示方式：
#   paged  - 只显示前 page_size 行（老行为，默认）
#   scroll - 区块内滚动条，能翻到全部已取回的行
#   lazy   - 滚到底自动追加下一批，不出现长滚动条
#   marquee- 自动匀速滚动，挂大屏时不用人操作
ALLOWED_TABLE_MODES = ('paged', 'scroll', 'lazy', 'marquee')
# 背景图铺法
ALLOWED_BG_FITS = ('cover', 'contain', 'tile')
# 看板名称（舞台大标题）的字号档。比区块标题那套大一截——它是挂大屏时几米外要看清的那行字。
ALLOWED_NAME_SIZES = ('xs', 'sm', 'md', 'lg', 'xl', 'xxl')
# 浅色主题：舞台上的文字要反成深色（模板据此加 is-light 类）。
# 单独列一份而不是靠算颜色亮度：主题色值是手挑的，深浅是设计意图，不该由代码猜。
LIGHT_THEMES = (
    'daylight', 'linen', 'mint', 'sakura', 'sand', 'seafoam', 'pearl', 'blossom', 'celadon',
    'ivory', 'porcelain', 'peach', 'lilac', 'sky', 'oat', 'lemonade', 'rosewater', 'aqua',
    'cloud', 'honey', 'fresco', 'basil', 'parchment', 'glaze', 'coral', 'frost',
)

GRID_COLUMNS = 12
MAX_BLOCKS = 30
MAX_BLOCK_WIDTH = 12
MAX_BLOCK_HEIGHT = 8
MAX_PAGE_SIZE = 200
# 单区块最多返回的行数：看板是概览场景，超出部分截断并回传 truncated 标记，
# 避免某个脚本返回十万行把浏览器和内存打满。
MAX_BLOCK_ROWS = 1000
MIN_REFRESH_SECONDS = 30
MAX_REFRESH_SECONDS = 86400

_LOCK = threading.RLock()
dashboards = []


# ---------- 基础工具 ----------

def _now():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


# 区块配色只允许十六进制色值，直接拼进内联 style 前必须过这道白名单。
_COLOR_PATTERN = re.compile(r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$')
# 背景图资源 id：上传时用 uuid4().hex 生成，固定 32 位十六进制。
_ASSET_ID_PATTERN = re.compile(r'^[0-9a-f]{32}$')


def _text(value, default='', limit=200):
    text = str(value if value is not None else '').strip()
    return (text[:limit] if text else default)


def _int(value, default, minimum, maximum):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def _choice(value, allowed, default):
    text = str(value or '').strip().lower()
    return text if text in allowed else default


def _safe_id(value):
    text = str(value or '').strip()
    return text[:40] if text else uuid.uuid4().hex[:12]


def _asset_id(value):
    """背景图资源 id：只放行 32 位十六进制（上传时生成的名字）。

    这个值会被拼进文件路径，所以必须严格校验：
    放过任意字符串就等于把 ../../etc/passwd 这类路径穿越交给了配置者。
    """
    text = str(value or '').strip().lower()
    return text if _ASSET_ID_PATTERN.match(text) else ''


def _color(value):
    """只接受 #rgb / #rrggbb 十六进制色值，其余一律返回空串（表示"跟随主题"）。

    颜色最终会拼进内联 style，所以必须严格白名单校验：
    放过任意字符串就等于让配置者往样式里注入内容。
    """
    text = str(value or '').strip()
    if _COLOR_PATTERN.match(text):
        return text.lower()
    return ''


def row_value(row, columns, column_name):
    """从一行数据里按列名取值，兼容 PG(list) 与 MySQL(dict) 两种行格式。

    CLAUDE.md 关键约定 4：按列名定位而非硬编码索引。
    """
    if column_name is None or column_name == '':
        return None
    if isinstance(row, dict):
        return row.get(column_name)
    try:
        return row[columns.index(column_name)]
    except (ValueError, IndexError, TypeError):
        return None


def to_number(value):
    """把 execute_sql 返回的字符串数值（Decimal/int 被转成 str）还原为 float。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(',', '').replace('%', '')
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


# ---------- 存储 ----------

def load_dashboards():
    """从文件加载看板配置；文件缺失或损坏时退化为空列表，不阻塞应用启动。

    始终就地替换列表内容（`dashboards[:] = ...`）而不是重新赋值：
    routes 层用 `from helpers import dashboards` 持有同一个列表对象，
    重新赋值会让调用方拿到重载前的旧列表。
    """
    with _LOCK:
        if not os.path.exists(DASHBOARDS_FILE):
            dashboards[:] = []
            return dashboards
        try:
            with open(DASHBOARDS_FILE, 'r', encoding='utf-8') as file:
                data = json.load(file)
            raw_list = data.get('dashboards', []) if isinstance(data, dict) else []
            dashboards[:] = [normalize_dashboard(item) for item in raw_list if isinstance(item, dict)]
        except (OSError, ValueError, TypeError) as error:
            print(f"[{_now()}] 加载自定义看板失败: {error}")
            dashboards[:] = []
        return dashboards


def save_dashboards():
    """原子写入看板配置：先写临时文件再 replace，避免写一半被读到半个 JSON。

    如果目标是被单文件 bind mount 挂进来的（docker run -v host.json:/app/config/x.json），
    os.replace 会报 EBUSY（Device or resource busy）——挂载点不能被改名覆盖。
    这时退回就地写入：牺牲原子性，但至少存得下来，
    否则用户改的看板会静默丢失（只在容器日志里留一行错误）。
    推荐的部署方式是挂整个 config 目录，那条路径上 os.replace 正常工作。
    """
    with _LOCK:
        payload = {'dashboards': dashboards, 'updated_at': _now()}
        os.makedirs(os.path.dirname(DASHBOARDS_FILE), exist_ok=True)
        handle, temp_path = tempfile.mkstemp(dir=os.path.dirname(DASHBOARDS_FILE), suffix='.tmp')
        try:
            with os.fdopen(handle, 'w', encoding='utf-8') as file:
                json.dump(payload, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            try:
                os.replace(temp_path, DASHBOARDS_FILE)
            except OSError as error:
                if error.errno != errno.EBUSY:
                    raise
                with open(DASHBOARDS_FILE, 'w', encoding='utf-8') as file:
                    json.dump(payload, file, ensure_ascii=False, indent=2)
                    file.flush()
                    os.fsync(file.fileno())
                os.unlink(temp_path)
        except OSError as error:
            print(f"[{_now()}] 保存自定义看板失败: {error}")
            try:
                os.unlink(temp_path)
            except OSError:
                pass


# ---------- 规范化 ----------

def _normalize_columns(value):
    """表格区块的展示列：只保留字符串列名，去重且保序。"""
    seen, columns = set(), []
    for item in (value or []) if isinstance(value, list) else []:
        name = _text(item, limit=120)
        if name and name not in seen:
            seen.add(name)
            columns.append(name)
    return columns[:40]


def _normalize_sort(value):
    if not isinstance(value, dict):
        return {'column': '', 'direction': 'asc'}
    return {
        'column': _text(value.get('column'), limit=120),
        'direction': _choice(value.get('direction'), ALLOWED_SORT_DIRECTIONS, 'asc'),
    }


def _normalize_params(value):
    """区块级变量覆盖值：仅保留标量，键为变量名。

    留空即表示按脚本自身的动态规则（today / last_n_days / period）在运行时解析。
    """
    params = {}
    if not isinstance(value, dict):
        return params
    for key, item in list(value.items())[:30]:
        name = _text(key, limit=60)
        if not name or isinstance(item, (dict, list)):
            continue
        value = _text(item, limit=200)
        # 空串不落库：get_variable_value 里"有值就覆盖"，留一个空串会把
        # default_value 也一起吃掉，等于把变量悄悄改成空值。
        if not value:
            continue
        params[name] = value
    return params


def _normalize_layout(value):
    layout = value if isinstance(value, dict) else {}
    return {
        'x': _int(layout.get('x'), 0, 0, GRID_COLUMNS - 1),
        'y': _int(layout.get('y'), 0, 0, 999),
        'w': _int(layout.get('w'), 6, 2, MAX_BLOCK_WIDTH),
        'h': _int(layout.get('h'), 2, 1, MAX_BLOCK_HEIGHT),
    }


def normalize_block(raw, index=0):
    """规范化单个区块：丢弃未知字段，只留白名单内的可执行配置。

    显式不接收 content / database / source_sql 等字段——看板永远只引用脚本 id。
    """
    raw = raw if isinstance(raw, dict) else {}
    block_type = _choice(raw.get('type'), ALLOWED_BLOCK_TYPES, 'table')
    layout = _normalize_layout(raw.get('layout'))
    layout['y'] = _int(raw.get('layout', {}).get('y') if isinstance(raw.get('layout'), dict) else index, layout['y'], 0, 999)

    block = {
        'id': _safe_id(raw.get('id')),
        'type': block_type,
        'title': _text(raw.get('title'), '未命名区块', limit=60),
        'description': _text(raw.get('description'), limit=160),
        'script_id': _text(raw.get('script_id'), limit=40),
        'layout': layout,
        'params': _normalize_params(raw.get('params')),
        # 配色：空串表示跟随主题色，不写死颜色。
        'title_color': _color(raw.get('title_color')),
        'value_color': _color(raw.get('value_color')),
        'accent_color': _color(raw.get('accent_color')),
        'header_color': _color(raw.get('header_color')),
        # 没有 header_bg / header_bg_preset：表头底色跟着这一块的底色走，不单独配。
        # 旧配置里可能还留着这两个键，normalize 时直接丢掉即可（多余的键不会落库）。
        # 表格数据文字色：表格块拿不到 value_color（那是给大号数字的），
        # 所以单独给一个，不然表格的行文字颜色没有任何调法。
        'cell_color': _color(raw.get('cell_color')),
        # 底色：预设 + custom 时的自定义色。bg_opacity 让底色能压在背景图上半透。
        'bg_preset': _choice(raw.get('bg_preset'), ALLOWED_BLOCK_BACKGROUNDS, 'theme'),
        'bg_color': _color(raw.get('bg_color')),
        'bg_opacity': _int(raw.get('bg_opacity'), 100, 10, 100),
        # 文字位置：标题和数值分开设，好让「数字居中、标题靠左」这类排版能做出来。
        'title_align': _choice(raw.get('title_align'), ALLOWED_ALIGNS, 'left'),
        'value_align': _choice(raw.get('value_align'), ALLOWED_ALIGNS, 'left'),
        # 字号档位。默认给大一档：看板多数挂在大屏/电视上看，原来的 sm 站远了看不清。
        'title_size': _choice(raw.get('title_size'), ALLOWED_TITLE_SIZES, 'md'),
        'value_size': _choice(raw.get('value_size'), ALLOWED_VALUE_SIZES, 'xl'),
        # 手输字号（px）。0 表示"用上面的档位"，不是"0 像素"——
        # 前端只在非 0 时才内联 --block-*-px，档位规则才有机会生效。
        'title_px': _int(raw.get('title_px'), 0, 0, 200),
        'value_px': _int(raw.get('value_px'), 0, 0, 400),
    }

    if block_type == 'text':
        block['script_id'] = ''
        block['body'] = _text(raw.get('body'), limit=1000)
        return block

    if block_type == 'table':
        block['columns'] = _normalize_columns(raw.get('columns'))
        block['page_size'] = _int(raw.get('page_size'), 10, 1, MAX_PAGE_SIZE)
        block['sort'] = _normalize_sort(raw.get('sort'))
        block['table_mode'] = _choice(raw.get('table_mode'), ALLOWED_TABLE_MODES, 'paged')
        block['header_size'] = _choice(raw.get('header_size'), ALLOWED_TABLE_SIZES, 'md')
        block['cell_size'] = _choice(raw.get('cell_size'), ALLOWED_TABLE_SIZES, 'md')
        block['header_px'] = _int(raw.get('header_px'), 0, 0, 200)
        block['cell_px'] = _int(raw.get('cell_px'), 0, 0, 200)
        # 匀速滚动的速度：像素/秒（原来是行/分钟——行高会随字号变，
        # 同一个速度换个字号就快慢不一，按像素算才稳定）。
        block['marquee_speed'] = _int(raw.get('marquee_speed'), 30, 4, 400)
        return block

    if block_type == 'metric':
        block['value_column'] = _text(raw.get('value_column'), limit=120)
        block['aggregate'] = _choice(raw.get('aggregate'), ALLOWED_AGGREGATES, 'first')
        block['unit'] = _text(raw.get('unit'), limit=12)
        block['decimals'] = _int(raw.get('decimals'), 0, 0, 4)
        block['trend'] = _choice(raw.get('trend'), ALLOWED_TRENDS, 'none')
        block['warn_value'] = _text(raw.get('warn_value'), limit=32)
        block['critical_value'] = _text(raw.get('critical_value'), limit=32)
        return block

    if block_type == 'progress':
        block['value_column'] = _text(raw.get('value_column'), limit=120)
        block['aggregate'] = _choice(raw.get('aggregate'), ALLOWED_AGGREGATES, 'first')
        block['target_value'] = _text(raw.get('target_value'), '100', limit=32)
        block['unit'] = _text(raw.get('unit'), limit=12)
        block['decimals'] = _int(raw.get('decimals'), 1, 0, 4)
        return block

    # bar / line / pie 共用：标签列 + 一至多个数值列
    block['label_column'] = _text(raw.get('label_column'), limit=120)
    block['value_columns'] = _normalize_columns(raw.get('value_columns'))[:4]
    block['max_items'] = _int(raw.get('max_items'), 12, 1, 60)
    block['sort'] = _normalize_sort(raw.get('sort'))
    block['unit'] = _text(raw.get('unit'), limit=12)
    block['decimals'] = _int(raw.get('decimals'), 0, 0, 4)
    return block


def normalize_dashboard(raw):
    raw = raw if isinstance(raw, dict) else {}
    blocks = raw.get('blocks') if isinstance(raw.get('blocks'), list) else []
    return {
        'id': _safe_id(raw.get('id')),
        'name': _text(raw.get('name'), '未命名看板', limit=60),
        'description': _text(raw.get('description'), limit=200),
        'refresh_seconds': _int(raw.get('refresh_seconds'), 0, 0, MAX_REFRESH_SECONDS) or 0,
        # 背景主题：从预设里选，独立页与画廊小块都按它上色。
        'theme': _choice(raw.get('theme'), ALLOWED_THEMES, 'aurora'),
        # 背景图：只存资源 id，不存 URL。存 URL 等于让配置者指定任意外链，
        # 既会把看板打开时的请求发给第三方，也能拿来探内网地址。
        'bg_image': _asset_id(raw.get('bg_image')),
        'bg_fit': _choice(raw.get('bg_fit'), ALLOWED_BG_FITS, 'cover'),
        # 背景图压暗程度：图太亮时文字看不清，压一层黑纱。
        'bg_dim': _int(raw.get('bg_dim'), 35, 0, 85),
        # 背景图模糊：让图当底纹用，不抢内容。
        'bg_blur': _int(raw.get('bg_blur'), 0, 0, 20),
        # 看板名称的样式。字段名不叫 title_*：区块里已经有一套 title_size/title_color，
        # 同名会让「改的是哪个标题」分不清，读代码和排查都容易搭错。
        'name_size': _choice(raw.get('name_size'), ALLOWED_NAME_SIZES, 'md'),
        # 手填像素优先于档位，0 表示不手填、走档位。挂大屏的分辨率千奇百怪，档位不一定够。
        'name_px': _int(raw.get('name_px'), 0, 0, 200),
        # 颜色必须过 _color 的十六进制白名单：它会被拼进 style 属性。
        'name_color': _color(raw.get('name_color')),
        'name_align': _choice(raw.get('name_align'), ALLOWED_ALIGNS, 'left'),
        # 免登录开放：勾了之后 /dashboard/<id> 不用登录就能打开，给挂大屏的电视用
        # （那些机器没人守着去登录）。默认关——开着等于把里面的业务数据对全网放开。
        # 只认真正的 True：JSON 里传字符串 'false' 也不该算开。
        'public': raw.get('public') is True,
        # 免登录访问时按谁的权限跑脚本。存的是配置这个看板的账号，由路由从 session 写入，
        # 不取 payload——否则改个字段就能借别人的权限跑自己看不到的脚本。
        'owner': _text(raw.get('owner'), limit=40),
        'blocks': [normalize_block(block, index) for index, block in enumerate(blocks[:MAX_BLOCKS])],
        'created_at': _text(raw.get('created_at'), _now(), limit=32),
        'updated_at': _text(raw.get('updated_at'), _now(), limit=32),
    }


def validate_refresh_seconds(value):
    """0 表示不自动刷新；其余值必须落在 [30s, 24h] 内，避免高频轮询打库。"""
    seconds = _int(value, 0, 0, MAX_REFRESH_SECONDS)
    if seconds == 0:
        return 0, None
    if seconds < MIN_REFRESH_SECONDS:
        return 0, f'自动刷新间隔不能小于 {MIN_REFRESH_SECONDS} 秒'
    return seconds, None


def find_dashboard(dashboard_id):
    return next((item for item in dashboards if item.get('id') == str(dashboard_id)), None)


def find_script(script_id):
    return next((item for item in custom_scripts_helpers.custom_scripts
                 if str(item.get('id')) == str(script_id)), None)


# ---------- 执行 ----------

def _render_sql(sql, variables, params):
    """把 #{name} 占位符替换为解析后的值；变量解析口径与页面执行一致。"""
    if not sql:
        return sql
    for variable in variables or []:
        name = variable.get('name', '')
        if not name:
            continue
        value = get_variable_value(variable, params or {})
        sql = sql.replace(f'#{{{name}}}', format_sql_value(variable, value))
    return sql


def _sorted_rows(columns, rows, sort):
    """按配置列排序：数值优先按数值比，否则按字符串比。列名不存在时原样返回。"""
    column = (sort or {}).get('column')
    if not column or column not in (columns or []):
        return rows
    reverse = (sort or {}).get('direction') == 'desc'

    def sort_key(row):
        value = row_value(row, columns, column)
        number = to_number(value)
        return (0, number, '') if number is not None else (1, 0.0, str(value if value is not None else ''))

    try:
        return sorted(rows, key=sort_key, reverse=reverse)
    except TypeError:
        return rows


def _dict_rows_to_lists(columns, rows):
    """统一行格式为 list，前端只需处理一种结构（MySQL 走 DictCursor 返回 dict）。"""
    normalized = []
    for row in rows or []:
        if isinstance(row, dict):
            normalized.append([row.get(column) for column in columns])
        else:
            normalized.append(list(row))
    return normalized


def execute_block(block, username):
    """执行单个区块引用的脚本，返回 {columns, rows, truncated, script_name}。

    异常与错误统一抛 RuntimeError，由调用方捕获实现区块级隔离。
    """
    block_type = block.get('type')
    if block_type == 'text':
        return {'columns': [], 'rows': [], 'truncated': False, 'script_name': ''}

    script = find_script(block.get('script_id'))
    if not script:
        raise RuntimeError('看板引用的自定义SQL脚本不存在或已删除')
    if not can_access_custom_script(username, script):
        raise RuntimeError('没有权限执行该区块引用的自定义SQL脚本')

    database_config = get_config('databaseConfig') or {}
    variables = script.get('variables', [])
    params = block.get('params') or {}
    mode = script.get('mode', 'single_db')

    if mode == 'cross_db':
        source_config = database_config.get(script.get('source_db'))
        target_config = database_config.get(script.get('target_db'))
        if not source_config or not target_config:
            raise RuntimeError('看板跨库脚本的数据库配置不存在')
        source_sql = _render_sql(script.get('source_sql', ''), variables, params)
        target_sql = _render_sql(script.get('target_sql', ''), variables, params)

        source_columns, source_rows = execute_sql(source_config['type'], source_config, source_sql)
        if source_columns is None:
            raise RuntimeError(f'源数据库查询失败: {source_rows}')
        target_columns, target_rows = execute_sql(target_config['type'], target_config, target_sql)
        if target_columns is None:
            raise RuntimeError(f'目标数据库查询失败: {target_rows}')

        compared = compare_cross_db(source_columns, source_rows, target_columns, target_rows,
                                    script.get('cross_db_config', {}) or {})
        columns = compared.get('columns') or []
        rows = compared.get('rows') or []
    else:
        db_config = database_config.get(script.get('database'))
        content = script.get('content')
        if not db_config or not content:
            raise RuntimeError('看板脚本的数据库或SQL配置无效')
        columns, rows = execute_sql(db_config['type'], db_config, _render_sql(content, variables, params))
        if columns is None:
            raise RuntimeError(str(rows))

    columns = list(columns or [])
    rows = _dict_rows_to_lists(columns, rows)
    if block_type in ('table', 'bar', 'line', 'pie'):
        rows = _sorted_rows(columns, rows, block.get('sort'))

    truncated = len(rows) > MAX_BLOCK_ROWS
    return {
        'columns': columns,
        'rows': rows[:MAX_BLOCK_ROWS],
        'truncated': truncated,
        'total': len(rows),
        'script_name': script.get('name', ''),
    }


def script_metadata(username):
    """返回当前用户可执行脚本的元数据（不含 SQL 正文），供看板编辑器选择数据源。"""
    items = []
    for script in custom_scripts_helpers.custom_scripts:
        if not can_access_custom_script(username, script):
            continue
        items.append({
            'id': str(script.get('id')),
            'name': str(script.get('name') or script.get('id')),
            'category': str(script.get('category') or '').strip() or '未分类',
            'mode': script.get('mode', 'single_db'),
            'variables': [
                {
                    'name': variable.get('name', ''),
                    'type': variable.get('type', 'text'),
                    'date_range_type': variable.get('date_range_type', ''),
                    'period_type': variable.get('period_type', ''),
                    'last_n_days': variable.get('last_n_days', 7),
                    'default_value': variable.get('default_value', ''),
                }
                for variable in (script.get('variables') or [])
            ],
        })
    items.sort(key=lambda item: (item['category'], item['name']))
    return items


load_dashboards()
