"""
日志内容解析模块 - 把 inspection_logs.result JSON 解析成非开发人员可读的结构。

不同 inspection_type 有不同的 result 结构，本模块按类型分别解析：
- system:      巡检各子项的 info/warnings/criticals/normals
- sql:         数据库 + SQL + 结果行
- mes_hanging: MES vs 吊挂 的 count/sum 对比、是否一致、差异
- custom_script: 脚本名/模式/记录数；跨库时展示对比统计

返回结构：{ summary_text, sections: [{title, type, items: [...]}] }
前端按 section 渲染，避免直接堆原始 JSON。
"""

import json


def _safe_json_loads(result):
    """result 可能是字符串(JSON)或已是 dict/list。"""
    if result is None:
        return None
    if isinstance(result, (dict, list)):
        return result
    if isinstance(result, str):
        try:
            return json.loads(result)
        except (ValueError, TypeError):
            return None
    return None


def _db_label(db_key):
    return {'mes': 'MES数据库', 'hanging': '吊挂中间库'}.get(db_key, db_key or '未指定')


def _status_label(status):
    return {
        'success': '正常', 'warning': '告警', 'critical': '严重', 'error': '失败',
    }.get(status, status or '未知')


def _trigger_label(trigger):
    return {
        'manual': '手动', 'scheduled': '定时巡检', 'daily': '日常巡检',
        'real_time': '实时监控',
    }.get(trigger, trigger or '未知')


def _type_label(inspection_type):
    return {
        'system': '系统巡检', 'sql': 'SQL稽查', 'mes_hanging': 'MES吊挂稽核',
        'custom_script': '自定义稽核',
    }.get(inspection_type, inspection_type or '未知')


def _target_label(target):
    """巡检对象代号 -> 中文名。
    巡检项代号(full/memory/disk 等)转中文；库别名(mes/hanging)走 _db_label；
    其余(日期范围、自定义脚本名、自定义库 key 等)原样返回；空值返回 '-'。
    代号表与 dingtalk.py 的 category 中文名映射保持一致。"""
    if not target:
        return '-'
    labels = {
        'full': '完整巡检',
        # 自动触发的全量系统巡检：target 复用 trigger_source 代号，映射成中文，避免与手动「完整巡检」混淆
        'scheduled': '定时巡检',
        'daily': '日常巡检',
        'real_time': '实时监控',
        'system_info': '系统信息',
        'cpu': 'CPU使用率',
        'memory': '内存使用情况',
        'swap': '交换分区使用情况',
        'disk': '磁盘使用情况',
        'disk_io': '磁盘IO情况',
        'processes': '进程状态',
        'slow_sql': '慢SQL检查',
        'database': '数据库检查',
        'network': '网络状态',
        'worker_output_with_color_size': '工人产量与报工明细稽核（含颜色尺码）',
        'worker_output_without_color_size': '工人产量与报工明细稽核（不含颜色尺码）',
        'worker_output_sfd': '工人产量与报工明细数据稽核(sfd)',
        'mes_hanging': 'MES报工明细与吊挂报工明细稽核',
    }
    return labels.get(target) or _db_label(target)


def _rows_preview(rows, limit=50):
    """结果行预览：超过 limit 行时只展示前 limit 行并提示总数。"""
    if not rows:
        return [], 0
    total = len(rows)
    preview = rows[:limit]
    return preview, total


def parse_system_result(result):
    """解析系统巡检结果。"""
    sections = []
    data = result if isinstance(result, dict) else {}
    if not data:
        return sections

    # 系统巡检结果通常是 {item_name: {info/warnings/criticals/normals/slow_sqls}} 的字典
    label_map = {
        'system_info': '系统信息', 'cpu': 'CPU', 'memory': '内存', 'swap': '交换分区',
        'disk': '磁盘', 'disk_io': '磁盘IO', 'processes': '进程', 'slow_sql': '慢SQL',
        'database': '数据库', 'network': '网络',
        'worker_output_with_color_size': '工人产量稽核(含颜色尺码)',
        'worker_output_without_color_size': '工人产量稽核(不含颜色尺码)',
        'worker_output_sfd': '工人产量稽核(sfd)',
        'mes_hanging': 'MES吊挂稽核',
    }

    for key, val in data.items():
        if not isinstance(val, dict):
            continue
        title = label_map.get(key, key)
        # 去掉自定义脚本重复的 script_name
        items = []
        for level, label in [('criticals', '严重'), ('warnings', '告警'),
                             ('normals', '正常'), ('info', '信息'),
                             ('slow_sqls', '慢SQL')]:
            msgs = val.get(level) or []
            if not msgs:
                continue
            for m in msgs:
                items.append({'level': level, 'label': label, 'text': m})
        if items:
            sections.append({'title': title, 'type': 'messages', 'items': items})

    return sections


def parse_sql_result(result):
    """解析 SQL 稽查结果。"""
    sections = []
    data = result if isinstance(result, dict) else {}
    if not data:
        return sections

    meta = []
    meta.append({'label': '数据库', 'value': _db_label(data.get('database'))})
    if data.get('sql'):
        meta.append({'label': 'SQL语句', 'value': data.get('sql'), 'mono': True})
    sections.append({'title': '稽查信息', 'type': 'keyvalue', 'items': meta})

    columns = data.get('columns') or []
    rows = data.get('rows') or []
    preview, total = _rows_preview(rows)
    sections.append({
        'title': f'查询结果（共 {total} 条）',
        'type': 'table',
        'columns': columns,
        'rows': preview,
        'truncated': total > len(preview),
    })
    return sections


def parse_mes_hanging_result(result):
    """解析 MES 吊挂稽核结果。"""
    sections = []
    data = result if isinstance(result, dict) else {}
    if not data:
        return sections

    is_consistent = data.get('is_consistent')
    diff = data.get('diff') or {}
    hanging = data.get('hanging') or {}
    mes = data.get('mes') or {}

    conclusion = '一致 ✓' if is_consistent else '不一致 ✗'
    sections.append({
        'title': '稽核结论',
        'type': 'keyvalue',
        'items': [
            {'label': '日期范围', 'value': f"{data.get('start_date','')} ~ {data.get('end_date','')}"},
            {'label': '对比结果', 'value': conclusion, 'highlight': not is_consistent},
        ],
    })

    sections.append({
        'title': '数量与金额对比',
        'type': 'table',
        'columns': ['数据源', '记录数', '金额合计'],
        'rows': [
            ['吊挂中间库', hanging.get('count'), hanging.get('sum')],
            ['MES数据库', mes.get('count'), mes.get('sum')],
            ['差异', diff.get('count'), diff.get('sum')],
        ],
    })

    if mes.get('table'):
        sections.append({
            'title': '涉及MES分表',
            'type': 'keyvalue',
            'items': [{'label': '表名', 'value': mes.get('table'), 'mono': True}],
        })
    return sections


def parse_custom_script_result(result):
    """解析自定义稽核结果（含跨库对比）。"""
    sections = []
    data = result if isinstance(result, dict) else {}
    if not data:
        return sections

    mode = data.get('mode', 'single_db')
    script_name = data.get('script_name', '')
    is_cross_db = mode == 'cross_db'

    meta = [{'label': '脚本名称', 'value': script_name}]
    meta.append({'label': '执行模式', 'value': '跨库对比' if is_cross_db else '单库'})
    if is_cross_db:
        meta.append({'label': '源数据库', 'value': _db_label(data.get('source_db'))})
        meta.append({'label': '目标数据库', 'value': _db_label(data.get('target_db'))})
    sections.append({'title': '脚本信息', 'type': 'keyvalue', 'items': meta})

    # 跨库对比统计
    summary = data.get('summary')
    if summary:
        is_consistent = data.get('is_consistent')
        conclusion = '一致 ✓' if is_consistent else '存在差异 ✗'
        sections.append({
            'title': '对比结论',
            'type': 'keyvalue',
            'items': [{'label': '对比结果', 'value': conclusion, 'highlight': not is_consistent}],
        })
        sections.append({
            'title': '对比统计',
            'type': 'table',
            'columns': ['一致', '不一致', '仅源库', '仅目标库', '合计'],
            'rows': [[
                summary.get('consistent', 0),
                summary.get('inconsistent', 0),
                summary.get('only_source', 0),
                summary.get('only_target', 0),
                summary.get('total', 0),
            ]],
        })

    # 结果明细表
    columns = data.get('columns') or []
    rows = data.get('rows') or []
    if columns:
        preview, total = _rows_preview(rows, limit=100)
        sections.append({
            'title': f'结果明细（共 {total} 条）',
            'type': 'table',
            'columns': columns,
            'rows': preview,
            'truncated': total > len(preview),
        })
    return sections


_PARSERS = {
    'system': parse_system_result,
    'sql': parse_sql_result,
    'mes_hanging': parse_mes_hanging_result,
    'custom_script': parse_custom_script_result,
}


def parse_log_detail(log_row):
    """解析单条日志为前端友好的结构。

    :param log_row: dict，至少包含 inspection_type, summary, status, trigger_source,
                    target, operator, record_count, duration, result, error, start_time, end_time
    :return: dict {
        type_label, trigger_label, status_label, summary_text,
        meta: [{label, value, ...}],
        sections: [{title, type, items/columns/rows}],
        error: str
    }
    """
    inspection_type = log_row.get('inspection_type', '')
    result = _safe_json_loads(log_row.get('result'))
    error = log_row.get('error')

    # 基础元信息
    meta = [
        {'label': '巡检类型', 'value': _type_label(inspection_type)},
        {'label': '触发来源', 'value': _trigger_label(log_row.get('trigger_source'))},
        {'label': '状态', 'value': _status_label(log_row.get('status'))},
        {'label': '巡检对象', 'value': _target_label(log_row.get('target'))},
        {'label': '操作人', 'value': log_row.get('operator') or '系统'},
        {'label': '记录数', 'value': log_row.get('record_count') if log_row.get('record_count') is not None else '-'},
        {'label': '开始时间', 'value': str(log_row.get('start_time') or '')},
        {'label': '结束时间', 'value': str(log_row.get('end_time') or '')},
        {'label': '耗时', 'value': log_row.get('duration') or '-'},
    ]

    # 按类型解析 result
    sections = []
    parser = _PARSERS.get(inspection_type)
    if parser and result is not None:
        try:
            sections = parser(result)
        except Exception as e:
            sections = [{
                'title': '解析失败',
                'type': 'messages',
                'items': [{'level': 'warnings', 'label': '告警', 'text': f'日志内容解析失败: {e}'}],
            }]
    elif result is not None:
        # 未知类型：展示原始 JSON（截断）
        raw = json.dumps(result, ensure_ascii=False, default=str)
        sections = [{
            'title': '原始内容',
            'type': 'raw',
            'text': raw[:5000],
            'truncated': len(raw) > 5000,
        }]

    if error:
        sections.insert(0, {
            'title': '错误信息',
            'type': 'messages',
            'items': [{'level': 'criticals', 'label': '失败', 'text': error}],
        })

    return {
        'type_label': _type_label(inspection_type),
        'trigger_label': _trigger_label(log_row.get('trigger_source')),
        'status_label': _status_label(log_row.get('status')),
        'summary_text': log_row.get('summary') or '',
        'meta': meta,
        'sections': sections,
        'error': error,
    }
