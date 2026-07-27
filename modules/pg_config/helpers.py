"""
PostgreSQL 容器配置管理 - 核心辅助函数

设计：
- 容器内不直连 5432，而是通过宿主 docker.sock 在应用容器里跑
  `docker exec <pg容器> psql -U <user> ...`（docker.sock 已挂载，见 deploy.sh start_container）。
  复用 check_slow_sql.py 既有「容器内执行 docker」模式，无需额外凭据。
- 安全：ALTER SYSTEM 只允许白名单参数 + 白名单取值，杜绝 SQL 注入；读用 SHOW/查询视图，
  不拼接用户输入。任意 SQL 交互不在本模块范围（防注入）。
- 配置：默认容器名/用户存 config.json 的 pgConfig（走 get_config/set_config），与全局配置体系统一。
"""

import re
import shlex
import subprocess

from modules.config_mgmt.helpers import get_config, set_config, save_config_to_file

# ===================== 可管理的 PG 日志参数白名单 =====================
# name -> 校验规则：dict 中的 fn 接收待设值字符串，返回 (ok: bool, normalized_value: str|None, error: str|None)
#   - 枚举型：仅允许列出的取值
#   - 整数型：必须可转 int 并在范围内（单位 ms）
#   - 布尔型：on/off
#   - 体积型：如 512MB / 1GB，匹配格式
#   - 路径型：log_directory，限定字符集
PG_SETTINGS_WHITELIST = {
    'log_statement': {
        'label': '普通SQL执行日志',
        'enum': ['none', 'ddl', 'mod', 'all'],
        'context': 'superuser',
        'unit': None,
    },
    'log_min_duration_statement': {
        'label': '慢查询阈值',
        'type': 'int',
        'min': -1,
        'max': 2147483647,
        'context': 'superuser',
        'unit': 'ms',
        'help': '0=记录全部，-1=关闭，>0=记录执行超过该毫秒数的语句',
    },
    'logging_collector': {
        'label': '日志收集器',
        'enum_bool': True,
        'context': 'postmaster',
        'unit': None,
        'help': 'postmaster 级别：reload 不生效，需重启 PG 容器',
    },
    'log_rotation_size': {
        'label': '单条日志文件最大',
        'type': 'size',
        'context': 'sighup',
        'unit': None,
        'help': '如 512MB / 1GB；0=不按大小轮转',
    },
    'log_rotation_age': {
        'label': '按时间轮转',
        'type': 'duration',
        'context': 'sighup',
        'unit': None,
        'help': '如 1d（每天）/ 60min / 0（关闭）',
    },
    'log_directory': {
        'label': '日志目录',
        'type': 'path',
        'context': 'sighup',
        'unit': None,
    },
    'log_filename': {
        'label': '日志文件名',
        'type': 'path',
        'context': 'sighup',
        'unit': None,
    },
    'log_truncate_on_rotation': {
        'label': '轮转时截断',
        'enum_bool': True,
        'context': 'sighup',
        'unit': None,
    },
    'log_connections': {
        'label': '记录连接',
        'enum_bool': True,
        'context': 'superuser',
        'unit': None,
    },
    'log_disconnections': {
        'label': '记录断开',
        'enum_bool': True,
        'context': 'superuser',
        'unit': None,
    },
}

# 数值/路径白名单辅助正则
_SIZE_RE = re.compile(r'^\d+(KB|MB|GB|TB|B)?$', re.IGNORECASE)
_DURATION_RE = re.compile(r'^\d+(us|ms|s|min|h|d)?$', re.IGNORECASE)
_PATH_RE = re.compile(r'^[A-Za-z0-9_./-]+$')


def get_pg_config():
    """获取 pgConfig（默认容器名/用户等），缺失时给默认值但不持久化。"""
    pg_config = get_config('pgConfig')
    if not isinstance(pg_config, dict):
        pg_config = {}
    return {
        'container': pg_config.get('container', 'mes_postgresql'),
        'user': pg_config.get('user', 'postgres'),
    }


def save_pg_config(container=None, user=None):
    """保存 pgConfig 到 config.json。"""
    current = get_pg_config()
    if container is not None:
        current['container'] = container.strip()
    if user is not None:
        current['user'] = user.strip()
    set_config('pgConfig', current)
    save_config_to_file()
    return current


def _run_cmd(cmd, timeout=30):
    """执行 shell 命令，返回 (ok, stdout, stderr)。"""
    try:
        result = subprocess.run(
            cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=timeout
        )
        return result.returncode == 0, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, '', '命令执行超时'
    except Exception as e:
        return False, '', str(e)


def list_pg_containers():
    """列出宿主上疑似 PostgreSQL 的容器（名称+镜像+状态）。

    过滤口径：镜像名含 postgres / pgsql，或容器名含 postgres / pgsql。
    """
    # docker ps 已在容器内可用（docker.sock 挂载 + Dockerfile 装 docker CLI）
    fmt = "{{.Names}}\t{{.Image}}\t{{.Status}}"
    ok, out, err = _run_cmd(f"docker ps --format {shlex.quote(fmt)} 2>&1", timeout=15)
    if not ok:
        return [], err or '无法执行 docker ps（确认已挂载 /var/run/docker.sock）'

    containers = []
    for line in out.splitlines():
        parts = line.split('\t')
        if len(parts) < 3:
            continue
        name, image, status = parts[0], parts[1], parts[2]
        hay = (name + ' ' + image).lower()
        if 'postgres' in hay or 'pgsql' in hay:
            containers.append({'name': name, 'image': image, 'status': status})
    return containers, None


def exec_psql(container, user, sql, timeout=30):
    """在指定 PG 容器内执行 psql，返回 (ok, stdout, stderr)。

    安全：sql 仅来自本模块内部构造的白名单语句，不直接拼接外部输入。
    使用 -t -A 便于解析；-v ON_ERROR_STOP=1 让语法错误即时失败。
    """
    cmd = (
        f"docker exec {shlex.quote(container)} "
        f"psql -U {shlex.quote(user)} -t -A -v ON_ERROR_STOP=1 -c {shlex.quote(sql)}"
    )
    return _run_cmd(cmd, timeout=timeout)


def read_pg_settings(container=None, user=None):
    """读取可管理参数的当前值（含来源/单位/上下文）。

    走 pg_settings 视图查询，不拼用户输入。返回 (settings, error)。
    """
    pg = get_pg_config()
    container = container or pg['container']
    user = user or pg['user']

    settings = []
    # 用 | 作列分隔符解析：name|setting|unit|context|source|short_desc
    # pg_settings 这些字段不含管道，可安全 split；COALESCE 防 NULL。
    names = "','".join(PG_SETTINGS_WHITELIST.keys())
    sql = (
        f"SELECT name||'|'||COALESCE(setting,'')||'|'||COALESCE(unit,'')||'|'||"
        f"COALESCE(context,'')||'|'||COALESCE(source,'')||'|'||COALESCE(short_desc,'') "
        f"FROM pg_settings WHERE name IN ('{names}') ORDER BY name;"
    )
    ok, out, err = exec_psql(container, user, sql, timeout=20)
    if not ok:
        return None, f"读取配置失败：{err or out or '未知错误'}"

    for line in out.splitlines():
        if not line.strip():
            continue
        cols = line.split('|')
        # 补齐到 6 列
        while len(cols) < 6:
            cols.append('')
        name, setting, unit, context, source, short_desc = cols[:6]
        meta = PG_SETTINGS_WHITELIST.get(name, {})
        # pg_settings 布尔型已返回 on/off 字符串，无需转换
        settings.append({
            'name': name,
            'label': meta.get('label', name),
            'setting': setting,
            'unit': unit or meta.get('unit'),
            'context': context,
            'source': source,
            'help': meta.get('help'),
            'editable': name in PG_SETTINGS_WHITELIST,
        })
    return settings, None


def validate_value(name, value):
    """校验单个参数取值是否符合白名单规则，返回 (ok, normalized, error)。"""
    meta = PG_SETTINGS_WHITELIST.get(name)
    if not meta:
        return False, None, f'参数 {name} 不在可管理白名单内'

    value = (value or '').strip()

    # 布尔型：允许 on/off 或 true/false/1/0
    if meta.get('enum_bool'):
        mapping = {
            'on': 'on', 'off': 'off',
            'true': 'on', 'false': 'off',
            '1': 'on', '0': 'off',
        }
        norm = mapping.get(value.lower())
        if norm:
            return True, norm, None
        return False, None, f'{name} 取值需为 on/off'

    if 'enum' in meta:
        allowed = meta['enum']
        if value.lower() in allowed:
            return True, value.lower(), None
        return False, None, f'{name} 取值需为 {"/".join(allowed)} 之一'

    if meta.get('type') == 'int':
        try:
            n = int(value)
        except (ValueError, TypeError):
            return False, None, f'{name} 需为整数'
        if n < meta['min'] or n > meta['max']:
            return False, None, f'{name} 取值范围 {meta["min"]}~{meta["max"]}'
        return True, str(n), None

    if meta.get('type') == 'size':
        if not _SIZE_RE.match(value):
            return False, None, f'{name} 需形如 512MB / 1GB / 0'
        return True, value, None

    if meta.get('type') == 'duration':
        if not _DURATION_RE.match(value):
            return False, None, f'{name} 需形如 1d / 60min / 0'
        return True, value, None

    if meta.get('type') == 'path':
        if not _PATH_RE.match(value):
            return False, None, f'{name} 含非法字符（仅允许字母数字 _ . / -）'
        return True, value, None

    return False, None, f'{name} 未知校验类型'


def alter_system_setting(name, value, container=None, user=None):
    """执行 ALTER SYSTEM SET <name> = '<value>'，含白名单校验。返回 (ok, error)。"""
    ok, normalized, err = validate_value(name, value)
    if not ok:
        return False, err

    pg = get_pg_config()
    container = container or pg['container']
    user = user or pg['user']

    # 值已校验，仍用 shlex.quote 防御性转义
    sql = f"ALTER SYSTEM SET {name} = {shlex.quote(normalized)};"
    ok_exec, out, err_exec = exec_psql(container, user, sql, timeout=20)
    if not ok_exec:
        return False, f'ALTER SYSTEM 失败：{err_exec or out or "未知错误"}'
    return True, None


def reload_conf(container=None, user=None):
    """重载 PG 配置（SELECT pg_reload_conf()）。仅对 sighup 级参数即时生效。"""
    pg = get_pg_config()
    container = container or pg['container']
    user = user or pg['user']
    ok, out, err = exec_psql(container, user, "SELECT pg_reload_conf();", timeout=20)
    if not ok:
        return False, f'重载失败：{err or out or "未知错误"}'
    return True, None


# 一键推荐配置：完全对应用户提供的 5 条命令
PG_PRESET = [
    {'name': 'log_statement', 'value': 'none', 'desc': '关闭普通SQL执行日志'},
    {'name': 'log_min_duration_statement', 'value': '10000', 'desc': '慢查询阈值 10s'},
    {'name': 'logging_collector', 'value': 'off', 'desc': '关闭日志收集器（需重启PG生效）'},
    {'name': 'log_rotation_size', 'value': '512MB', 'desc': '单条日志最大 512MB'},
]


def apply_preset(container=None, user=None, reload=True):
    """应用推荐配置（逐条 ALTER SYSTEM），并按需 reload。返回 (results, error)。"""
    pg = get_pg_config()
    container = container or pg['container']
    user = user or pg['user']

    results = []
    failed = []
    for item in PG_PRESET:
        ok, err = alter_system_setting(item['name'], item['value'], container, user)
        results.append({
            'name': item['name'],
            'value': item['value'],
            'desc': item['desc'],
            'success': ok,
            'error': err if not ok else None,
        })
        if not ok:
            failed.append(item['name'])

    reload_result = None
    if reload:
        ok_r, err_r = reload_conf(container, user)
        reload_result = {'success': ok_r, 'error': err_r if not ok_r else None}

    return {
        'settings': results,
        'reload': reload_result,
        'note': 'logging_collector 为 postmaster 级别，reload 不会使其生效，需重启 PG 容器。',
    }, (None if not failed else f'部分设置失败：{", ".join(failed)}')
