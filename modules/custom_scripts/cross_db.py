"""
自定义脚本模块 - 跨库对比核心逻辑

跨库对比场景：两个数据库各自执行 SQL，按用户配置的「联合维度列」对齐，
比较「对比列」的值是否一致，并找出仅存在于一方的数据。

纯函数实现，不依赖数据库连接，便于测试与复用。
"""

import json


def _normalize_value(value):
    """统一数值比较：尽量转 float；无法转换则按字符串比较（去首尾空格）。"""
    if value is None:
        return None
    if isinstance(value, str):
        s = value.strip()
        if s == '':
            return None
        try:
            return float(s)
        except (ValueError, TypeError):
            return s
    if isinstance(value, (int, float)):
        return float(value)
    return value


def _values_equal(source_val, target_val, tolerance):
    """比较两个值是否在容差内一致。

    - 两者都为 None 视为一致
    - 一方为 None 视为不一致（缺失值）
    - 数值比较：差值绝对值 <= tolerance 视为一致
    - 非数值：按字符串严格相等比较
    """
    s = _normalize_value(source_val)
    t = _normalize_value(target_val)

    if s is None and t is None:
        return True
    if s is None or t is None:
        return False

    if isinstance(s, (int, float)) and isinstance(t, (int, float)):
        return abs(s - t) <= tolerance
    return str(s) == str(t)


def _row_to_dict(columns, row):
    """把一行（数组或字典）转成 {列名: 值} 字典。"""
    d = {}
    if isinstance(row, dict):
        for col in columns:
            d[col] = row.get(col, '')
        # 兼容 dict 中存在但 columns 未声明的列
        for k, v in row.items():
            if k not in d:
                d[k] = v
    else:
        for i, col in enumerate(columns):
            d[col] = row[i] if i < len(row) else ''
    return d


def _dim_key(row_dict, dimension_columns):
    """根据维度列构造可哈希的联合维度键。"""
    return tuple(str(row_dict.get(col, '')) for col in dimension_columns)


def _diff_desc(compare_columns, source_dict, target_dict):
    """生成差异说明文本，列出所有不一致的对比列及其值。"""
    descs = []
    for comp in compare_columns:
        col = comp.get('name')
        tol = comp.get('tolerance', 0) or 0
        s = source_dict.get(col) if source_dict else None
        t = target_dict.get(col) if target_dict else None
        if not _values_equal(s, t, tol):
            descs.append(f"{col} 差异: {s}↔{t}(容差{tol})")
    return '；'.join(descs)


def _scalar_compare(source_rows, target_rows, tolerance):
    """标量对比：取两库结果各自第一行第一列的值（聚合值，如 COUNT/SUM）直接比对。

    适用于「A 库某天总记录数 vs B 库」这类单值比对场景，无需维度对齐。
    SQL 应保证只返回一行一个数值（COUNT/SUM/MAX 等聚合天然满足）。
    """
    def _first_cell(rows):
        if not rows:
            return None
        row = rows[0]
        if isinstance(row, dict):
            return next(iter(row.values()), None)
        if isinstance(row, (list, tuple)):
            return row[0] if len(row) > 0 else None
        return row

    s = _first_cell(source_rows)
    t = _first_cell(target_rows)
    equal = _values_equal(s, t, tolerance)

    # 数值时计算差值，便于直观看出相差多少
    sn = _normalize_value(s)
    tn = _normalize_value(t)
    if isinstance(sn, (int, float)) and isinstance(tn, (int, float)):
        diff = round(sn - tn, 6)
    else:
        diff = ''

    status = '一致' if equal else '不一致'
    diff_desc = '' if equal else f"差异: {s}↔{t}(容差{tolerance})"
    return {
        'columns': ['源库值', '目标库值', '差值', '状态', '差异说明'],
        'rows': [['' if s is None else s, '' if t is None else t, diff, status, diff_desc]],
        'summary': {
            'consistent': 1 if equal else 0,
            'inconsistent': 0 if equal else 1,
            'only_source': 0,
            'only_target': 0,
            'total': 1,
        },
        'is_consistent': equal,
    }


def compare_cross_db(source_columns, source_rows, target_columns, target_rows, cross_db_config):
    """跨库对比主函数。

    :param source_columns: 源库结果列名列表
    :param source_rows:    源库结果行（list[dict|list]）
    :param target_columns: 目标库结果列名列表
    :param target_rows:     目标库结果行
    :param cross_db_config: {
        "compare_type": "full_outer" | "diff_only" | "missing_only",
        "dimension_columns": [..],          # 联合维度列
        "compare_columns": [{"name":..,"tolerance":..}, ..]  # 需对比的数值列
    }
    :return: {
        "columns": [...],   # 统一结果表列
        "rows": [[..]],    # 统一结果表行
        "summary": {"consistent","inconsistent","only_source","only_target","total"},
        "is_consistent": bool
    }
    """
    config = cross_db_config or {}
    compare_type = config.get('compare_type', 'full_outer')
    dimension_columns = config.get('dimension_columns', []) or []
    compare_columns = config.get('compare_columns', []) or []

    # 标量对比：两库各取一个数值（如总记录数）直接比对，无需维度对齐
    if compare_type == 'scalar':
        tol = config.get('scalar_tolerance')
        if (tol is None or tol == '') and compare_columns:
            tol = compare_columns[0].get('tolerance', 0)
        try:
            tol = float(tol) if tol not in (None, '') else 0.0
        except (ValueError, TypeError):
            tol = 0.0
        return _scalar_compare(source_rows, target_rows, tol)

    # 维度列为空时退化：无法对齐，退回原拼接行为（按数据源堆叠）
    if not dimension_columns:
        return _fallback_concat(source_columns, source_rows, target_columns, target_rows)

    # 构建维度 -> 行字典 索引
    source_map = {}
    for row in (source_rows or []):
        d = _row_to_dict(source_columns, row)
        key = _dim_key(d, dimension_columns)
        # 同维度多行时保留第一条（以首次出现为准），避免重复键
        if key not in source_map:
            source_map[key] = d

    target_map = {}
    for row in (target_rows or []):
        d = _row_to_dict(target_columns, row)
        key = _dim_key(d, dimension_columns)
        if key not in target_map:
            target_map[key] = d

    # 非维度、非对比列：仅展示用，从两库列名合并去重（保持来源顺序）
    compare_col_names = [c.get('name') for c in compare_columns if c.get('name')]
    display_extra_cols = []
    for col in (source_columns or []) + (target_columns or []):
        if col not in dimension_columns and col not in compare_col_names and col not in display_extra_cols:
            display_extra_cols.append(col)

    result_columns = list(dimension_columns) + list(compare_col_names) + display_extra_cols + ['数据源', '状态', '差异说明']
    result_rows = []

    summary = {'consistent': 0, 'inconsistent': 0, 'only_source': 0, 'only_target': 0, 'total': 0}

    all_keys = list(source_map.keys()) + [k for k in target_map.keys() if k not in source_map]

    for key in all_keys:
        s_dict = source_map.get(key)
        t_dict = target_map.get(key)

        if s_dict and t_dict:
            # 两库都有：按对比列比较
            diffs = _diff_desc(compare_columns, s_dict, t_dict)
            is_consistent = not diffs
            if is_consistent:
                status, data_source = '一致', '源库+目标库'
                summary['consistent'] += 1
                include = compare_type in ('full_outer',)
            else:
                status, data_source = '不一致', '源库+目标库'
                summary['inconsistent'] += 1
                include = compare_type in ('full_outer', 'diff_only')
            diff_desc = diffs
        elif s_dict and not t_dict:
            status, data_source, diff_desc = '仅源库存在', '源库', ''
            summary['only_source'] += 1
            include = compare_type in ('full_outer', 'missing_only')
        else:
            status, data_source, diff_desc = '仅目标库存在', '目标库', ''
            summary['only_target'] += 1
            include = compare_type in ('full_outer', 'missing_only')

        if not include:
            continue

        summary['total'] += 1
        row = []
        for col in dimension_columns:
            row.append((s_dict or t_dict).get(col, ''))
        for comp in compare_columns:
            col = comp.get('name')
            sv = s_dict.get(col) if s_dict else ''
            tv = t_dict.get(col) if t_dict else ''
            # 展示源库值（若仅目标库则展示目标库值）
            row.append(sv if sv != '' else tv)
        for col in display_extra_cols:
            sv = s_dict.get(col) if s_dict else ''
            tv = t_dict.get(col) if t_dict else ''
            row.append(sv if sv != '' else tv)
        row.append(data_source)
        row.append(status)
        row.append(diff_desc)
        result_rows.append(row)

    is_consistent = summary['inconsistent'] == 0 and summary['only_source'] == 0 and summary['only_target'] == 0
    return {
        'columns': result_columns,
        'rows': result_rows,
        'summary': summary,
        'is_consistent': is_consistent,
    }


def _fallback_concat(source_columns, source_rows, target_columns, target_rows):
    """维度列未配置时的兜底：保持旧行为（两库结果按数据源堆叠）。"""
    result_columns = ['数据源'] + (source_columns or [])
    result_rows = []
    for row in (source_rows or []):
        if isinstance(row, dict):
            result_rows.append(['源数据库'] + [row.get(col, '') for col in (source_columns or [])])
        else:
            result_rows.append(['源数据库'] + list(row))
    for row in (target_rows or []):
        if isinstance(row, dict):
            result_rows.append(['目标数据库'] + [row.get(col, '') for col in (target_columns or [])])
        else:
            result_rows.append(['目标数据库'] + list(row))
    total = len(result_rows)
    return {
        'columns': result_columns,
        'rows': result_rows,
        'summary': {'consistent': 0, 'inconsistent': 0, 'only_source': 0, 'only_target': 0, 'total': total},
        'is_consistent': True,
    }


def cross_db_summary_text(summary):
    """生成跨库对比结果的中文摘要文本（用于日志 summary 与钉钉告警）。"""
    if not summary:
        return ''
    consistent = summary.get('consistent', 0)
    inconsistent = summary.get('inconsistent', 0)
    only_source = summary.get('only_source', 0)
    only_target = summary.get('only_target', 0)
    total = summary.get('total', 0)
    parts = [f"共{total}条"]
    if consistent:
        parts.append(f"一致{consistent}条")
    if inconsistent:
        parts.append(f"不一致{inconsistent}条")
    if only_source:
        parts.append(f"仅源库{only_source}条")
    if only_target:
        parts.append(f"仅目标库{only_target}条")
    return '，'.join(parts)


def cross_db_config_to_text(cross_db_config):
    """把跨库配置转成人类可读文本（用于日志/展示）。"""
    if not cross_db_config:
        return ''
    dims = cross_db_config.get('dimension_columns', [])
    comps = cross_db_config.get('compare_columns', [])
    ct = cross_db_config.get('compare_type', 'full_outer')
    ct_text = {
        'full_outer': '全外连接(不一致+缺失)',
        'diff_only': '仅不一致',
        'missing_only': '仅单库缺失',
        'scalar': '标量对比(单值比对)',
    }.get(ct, ct)
    parts = [f"对比类型: {ct_text}"]
    if ct == 'scalar':
        tol = cross_db_config.get('scalar_tolerance', 0)
        parts.append(f"容差: {tol}")
        return '；'.join(parts)
    if dims:
        parts.append(f"维度列: {', '.join(dims)}")
    if comps:
        comp_text = ', '.join(f"{c.get('name')}(容差{c.get('tolerance', 0)})" for c in comps)
        parts.append(f"对比列: {comp_text}")
    return '；'.join(parts)


# 防止 json 导入被静态检查标记未使用（保留供未来序列化扩展）
_ = json
