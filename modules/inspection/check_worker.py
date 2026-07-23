"""Worker稽核函数模块 - check_worker_output系列"""

import datetime
from modules.inspection.models import InspectionResult
from modules.inspection.helpers import execute_sql
from modules.config_mgmt.helpers import get_config

def get_date_ranges(date_config):
    """根据日期配置计算日期范围列表"""
    date_options = date_config.get('options', {})
    custom_range = date_config.get('custom_date_range', {})
    # 最近N天上限28天：保证跨月时最多查询两个分表（同维度去重）
    last_n_days = min(int(date_config.get('last_n_days', 7) or 7), 28)
    
    today = datetime.datetime.now()
    yesterday = today - datetime.timedelta(days=1)
    current_month_start = today.replace(day=1)
    
    date_ranges = []
    
    if date_options.get('yesterday', False):
        start_date = yesterday.strftime('%Y-%m-%d')
        end_date = yesterday.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "昨日"))
    
    if date_options.get('today', False):
        start_date = today.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "今日"))
    
    if date_options.get('last_n_to_yesterday', False):
        start_date = (yesterday - datetime.timedelta(days=last_n_days - 1)).strftime('%Y-%m-%d')
        end_date = yesterday.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, f"最近{last_n_days}天到昨日"))
    
    if date_options.get('last_n_to_today', False):
        start_date = (today - datetime.timedelta(days=last_n_days - 1)).strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, f"最近{last_n_days}天到今日"))
    
    if date_options.get('current_month_to_yesterday', False):
        start_date = current_month_start.strftime('%Y-%m-%d')
        end_date = yesterday.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "当前月到昨天"))
    
    if date_options.get('current_month_to_today', False):
        start_date = current_month_start.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "当前月到今天"))
    
    if date_options.get('custom', False):
        start_date = custom_range.get('start_date', '')
        end_date = custom_range.get('end_date', '')
        if start_date and end_date:
            start_month = start_date[:7]
            end_month = end_date[:7]
            if start_month == end_month:
                date_ranges.append((start_date, end_date, "自定义日期范围"))
            else:
                return date_ranges, "自定义日期范围的开始日期和结束日期不在同一个月，跳过"
    
    return date_ranges, None


def get_cache_table_months(start_date, end_date):
    """枚举 [start_date, end_date] 覆盖的所有 (year, month)。

    缓存表按月分表（produce_mes_reporting_work_cache_{year}_{month}），
    日期范围可能跨月/跨年，需逐张表查询后按维度去重。
    结合最近N天上限28天，最多返回2个月份。
    """
    start = datetime.datetime.strptime(start_date, '%Y-%m-%d')
    end = datetime.datetime.strptime(end_date, '%Y-%m-%d')

    months = []
    current = start.replace(day=1)
    while current <= end:
        months.append((str(current.year), int(current.month)))
        if current.month == 12:
            current = current.replace(year=current.year + 1, month=1)
        else:
            current = current.replace(month=current.month + 1)
    return months


def build_cache_union_subquery(schema, months, select_columns, where_clause):
    """构建多月缓存表的 UNION ALL 子查询。

    select_columns: 子查询中各表 SELECT 的列片段（不含 FROM/WHERE）。
    where_clause: 各子表统一附加的 WHERE 条件（从原 detail_summary 下沉）。
    返回可直接用作 CTE/子查询的 SQL 片段：(... UNION ALL ...) AS cache_union
    """
    parts = []
    for year, month in months:
        table = f"{schema}.produce_mes_reporting_work_cache_{year}_{month}"
        parts.append(f"SELECT {select_columns} FROM {table} {where_clause}")
    union_sql = "\n        UNION ALL\n        ".join(parts)
    return f"({union_sql}) AS cache_union"


def _count_check_status(columns, rows):
    """统计差异记录中各 check_status 的数量。

    按列名定位 check_status 列（兼容 PG 返回 list、MySQL 返回 dict），
    避免列顺序变化导致硬编码索引错位。返回 (报表多余, 明细多余, 数量不一致)。
    """
    status_idx = columns.index('check_status') if columns and 'check_status' in columns else -1

    def _status_of(row):
        if isinstance(row, dict):
            return row.get('check_status')
        if status_idx >= 0 and status_idx < len(row):
            return row[status_idx]
        return None

    report_extra = sum(1 for row in rows if _status_of(row) == '报表多余记录')
    detail_extra = sum(1 for row in rows if _status_of(row) == '明细多余记录')
    quantity_mismatch = sum(1 for row in rows if _status_of(row) == '数量不一致')
    return report_extra, detail_extra, quantity_mismatch

def check_worker_output():
    """工人产量与报工明细稽核

    对比维度不含工序名称(produce_process_name)：同一订单/工人/工序版本/工位/日期
    下合并不同工序名称的记录后再比对。
    """
    result = InspectionResult()
    result.add_info("========== 开始工人产量与报工明细稽核 ==========")

    date_config = get_config('inspectionDateConfig')
    date_ranges, warning_msg = get_date_ranges(date_config)

    if warning_msg:
        result.add_warning(warning_msg)

    if not date_ranges:
        today = datetime.datetime.now()
        start_date = today.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "今日"))

    # 从MES数据库查询
    mes_config = get_config('databaseConfig').get('mes')
    if not mes_config:
        result.add_warning("MES数据库配置不存在")
        result.set_end_time()
        return result

    # 构建带schema的表名
    schema = 'jack_mes'

    # 对每个日期范围执行稽核
    for start_date, end_date, range_name in date_ranges:
        result.add_info(f"\n稽核日期范围: {range_name} ({start_date} 至 {end_date})")

        # 计算时间范围
        start_datetime = f"{start_date} 00:00:00"
        end_datetime = f"{end_date} 23:59:59"

        # 枚举日期范围覆盖的所有月份（跨月时最多2张表），构建 UNION ALL 子查询
        cache_months = get_cache_table_months(start_date, end_date)
        cache_union = build_cache_union_subquery(
            schema, cache_months,
            select_columns='''"total",
                "produce_order_code",
                "work_shop_id",
                "process_version_id",
                "section_id",
                "line_id",
                "user_line_id",
                "staff_id",
                "station_no",
                "reporting_date",
                "craft_seq",
                "tenant_code",
                "product_code",
                "color_name",
                "size_name"''',
            where_clause=f"WHERE \"reporting_work_date\" BETWEEN '{start_datetime}' AND '{end_datetime}'"
        )

        # 稽核脚本：比较明细汇总与报表数据是否一致（包含颜色尺码，对比维度不含工序名称）
        sql = f"""
        WITH
        -- 明细汇总结果（来自缓存表，跨月时UNION多张分表后按维度去重）
        detail_summary AS (
            SELECT
                SUM("total") AS total_qty,
                "produce_order_code"   AS produce_order_code,
                "work_shop_id"         AS work_shop_id,
                "process_version_id"   AS process_version_id,
                "section_id"           AS section_id,
                "line_id"              AS line_id,
                "user_line_id"         AS user_line_id,
                "staff_id"             AS staff_id,
                "station_no"           AS station_no,
                "reporting_date"       AS reporting_date,
                "craft_seq"            AS craft_seq,
                "tenant_code"          AS tenant_code,
                "product_code"         AS product_code,
                "color_name"            AS color_name,
                "size_name"            AS size_name
            FROM {cache_union}
            GROUP BY
                "tenant_code",
                "produce_order_code",
                "work_shop_id",
                "line_id",
                "user_line_id",
                "section_id",
                "process_version_id",
                "staff_id",
                "product_code",
                "station_no",
                "reporting_date",
                "craft_seq",
                "color_name",
                "size_name"
        ),
        -- 报表数据（来自目标报表表）
        report_data AS (
            SELECT
                number,
                produce_order_code,
                work_shop_id,
                process_version_id,
                produce_section_id,
                line_id,
                user_line_id,
                staff_id,
                station_no,
                report_date,
                craft_seq,
                tenant_code,
                product_code,
                "color_name"            AS color_name,
                "size_name"            AS size_name
            FROM {schema}.report_mes_user_process_output_cache
            WHERE report_date BETWEEN '{start_date}' AND '{end_date}' and is_deleted = 0
        )
        -- 完全外连接比对
        SELECT
            COALESCE(d.produce_order_code, r.produce_order_code) AS produce_order_code,
            COALESCE(d.work_shop_id, r.work_shop_id) AS work_shop_id,
            COALESCE(d.process_version_id, r.process_version_id) AS process_version_id,
            COALESCE(d.section_id, r.produce_section_id) AS section_id,
            COALESCE(d.line_id, r.line_id) AS line_id,
            COALESCE(d.user_line_id, r.user_line_id) AS user_line_id,
            COALESCE(d.staff_id, r.staff_id) AS staff_id,
            COALESCE(d.station_no, r.station_no) AS station_no,
            COALESCE(d.reporting_date, r.report_date) AS reporting_date,
            COALESCE(d.craft_seq, r.craft_seq) AS craft_seq,
            COALESCE(d.tenant_code, r.tenant_code) AS tenant_code,
            COALESCE(d.product_code, r.product_code) AS product_code,
            COALESCE(d.color_name, r.color_name) AS color_name,
            COALESCE(d.size_name, r.size_name) AS size_name,
            d.total_qty AS detail_total_qty,
            r.number AS report_output_qty,
            CASE
                WHEN d.produce_order_code IS NULL THEN '报表多余记录'
                WHEN r.produce_order_code IS NULL THEN '明细多余记录'
                WHEN d.total_qty <> r.number THEN '数量不一致'
                ELSE '一致'
            END AS check_status
        FROM detail_summary d
        FULL OUTER JOIN report_data r
            ON COALESCE(d.produce_order_code, '__NULL_STR__') = COALESCE(r.produce_order_code, '__NULL_STR__')
            AND COALESCE(d.work_shop_id, -9999) = COALESCE(r.work_shop_id, -9999)
            AND COALESCE(d.process_version_id, -9999) = COALESCE(r.process_version_id, -9999)
            AND COALESCE(d.section_id, -9999) = COALESCE(r.produce_section_id, -9999)
            AND COALESCE(d.line_id, -9999) = COALESCE(r.line_id, -9999)
            AND COALESCE(d.user_line_id, -9999) = COALESCE(r.user_line_id, -9999)
            AND COALESCE(d.staff_id, '__NULL_STR__') = COALESCE(r.staff_id, '__NULL_STR__')
            AND COALESCE(d.station_no, '__NULL_STR__') = COALESCE(r.station_no, '__NULL_STR__')
            AND COALESCE(d.reporting_date, '1970-01-01'::date) = COALESCE(r.report_date, '1970-01-01'::date)
            AND COALESCE(d.craft_seq, '-99999') = COALESCE(r.craft_seq, '-99999')
            AND COALESCE(d.tenant_code, '__NULL_STR__') = COALESCE(r.tenant_code, '__NULL_STR__')
            AND COALESCE(d.product_code, '__NULL_STR__') = COALESCE(r.product_code, '__NULL_STR__')
            AND COALESCE(d.color_name, '__NULL_STR__') = COALESCE(r.color_name, '__NULL_STR__')
            AND COALESCE(d.size_name, '__NULL_STR__') = COALESCE(r.size_name, '__NULL_STR__')
        WHERE d.total_qty IS DISTINCT FROM r.number
        ORDER BY check_status, produce_order_code
        """

        columns, rows = execute_sql(mes_config['type'], mes_config, sql)
        if columns is None:
            result.add_warning(f"MES数据库查询失败: {rows}")
            # 即使查询失败，也添加统计信息
            result.add_info("报表多余记录: 0 条")
            result.add_info("明细多余记录: 0 条")
            result.add_info("数量不一致: 0 条")
            continue

        if not rows:
            result.add_normal("明细汇总与报表数据完全一致，无差异记录")
            # 即使没有差异记录，也添加统计信息
            result.add_info("报表多余记录: 0 条")
            result.add_info("明细多余记录: 0 条")
            result.add_info("数量不一致: 0 条")
        else:
            result.add_critical(f"共查询到 {len(rows)} 条差异记录")
            # 统计不同类型的差异（按列名定位 check_status，避免列顺序变化导致索引错位）
            report_extra, detail_extra, quantity_mismatch = _count_check_status(columns, rows)
            result.add_info(f"报表多余记录: {report_extra} 条")
            result.add_info(f"明细多余记录: {detail_extra} 条")
            result.add_info(f"数量不一致: {quantity_mismatch} 条")

    result.set_end_time()
    return result

def check_worker_output_sfd():
    """工人产量与报工明细数据稽核(sfd)"""
    result = InspectionResult()
    result.add_info("========== 开始工人产量与报工明细数据稽核(sfd) ==========")
    
    date_config = get_config('inspectionDateConfig')
    date_ranges, warning_msg = get_date_ranges(date_config)
    
    if warning_msg:
        result.add_warning(warning_msg)
    
    if not date_ranges:
        today = datetime.datetime.now()
        start_date = today.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "今日"))
    
    # 从MES数据库查询
    mes_config = get_config('databaseConfig').get('mes')
    if not mes_config:
        result.add_warning("MES数据库配置不存在")
        result.set_end_time()
        return result
    
    # 构建带schema的表名
    schema = 'jack_mes'
    
    # 对每个日期范围执行稽核
    for start_date, end_date, range_name in date_ranges:
        result.add_info(f"\n稽核日期范围: {range_name} ({start_date} 至 {end_date})")

        # 计算时间范围
        start_datetime = f"{start_date} 00:00:00"
        end_datetime = f"{end_date} 23:59:59"

        # 枚举日期范围覆盖的所有月份（跨月时最多2张表），构建 UNION ALL 子查询
        cache_months = get_cache_table_months(start_date, end_date)
        cache_union = build_cache_union_subquery(
            schema, cache_months,
            select_columns='''"total",
        "produce_order_code",
        "work_shop_id",
        "process_version_id",
        "section_id",
        "line_id",
        "user_line_id",
        "produce_process_name",
        "staff_id",
        "station_no",
        "reporting_date",
        "craft_seq",
        "tenant_code",
        "product_code",
        "color_name",
        "size_name"''',
            where_clause=f"WHERE \"reporting_work_date\" BETWEEN '{start_datetime}' AND '{end_datetime}'"
        )

        # 稽核脚本：比较明细汇总与报表数据是否一致（包含颜色尺码）
        sql = f"""
-- 稽核脚本：比较明细汇总与工人产量报表数据是否一致
WITH
detail_summary AS (
    SELECT
        SUM("total") AS total_qty,
        "produce_order_code"   AS produce_order_code,
        "work_shop_id"         AS work_shop_id,
        "process_version_id"   AS process_version_id,
        "section_id"           AS section_id,
        "line_id"              AS line_id,
        "user_line_id"         AS user_line_id,
        "produce_process_name" AS produce_process_name,
        "staff_id"             AS staff_id,
        "station_no"           AS station_no,
        "reporting_date"       AS reporting_date,
        "craft_seq"            AS craft_seq,
        "tenant_code"          AS tenant_code,
        "product_code"         AS product_code,
        "color_name"           AS color_name,
        "size_name"            AS size_name
     FROM {cache_union}
    GROUP BY
        "tenant_code", 
        "produce_order_code",
        "produce_process_name",
        "work_shop_id",
        "line_id",
        "user_line_id",
        "section_id",
        "process_version_id",
        "staff_id",
        "product_code",
        "station_no",
        "reporting_date",
        "craft_seq",
        "color_name",
        "size_name"
),
-- 报表数据（来自目标报表表）
report_data AS (
    SELECT 
        COALESCE(sum(number), 0) AS number,  
        produce_order_code,
        work_shop_id,
        process_version_id,
        produce_section_id,
        line_id,
        user_line_id,
        produce_process_name,
        staff_id,
        station_no,
        report_date,
        craft_seq,
        tenant_code,
        product_code,
        color_name,
        size_name
    FROM {schema}.sfd_repo_mes_sfd_user_process_output_report
    WHERE report_date between '{start_date}' and '{end_date}' and is_deleted = 0
    GROUP BY 
        produce_order_code,
        work_shop_id,
        process_version_id,
        produce_section_id,
        line_id,
        user_line_id,
        produce_process_name,
        staff_id,
        station_no,
        report_date,
        craft_seq,
        tenant_code,
        product_code,
        color_name,
        size_name               
)
-- 完全外连接比对
SELECT 
    COALESCE(d.produce_order_code, r.produce_order_code) AS produce_order_code,
    COALESCE(d.work_shop_id, r.work_shop_id) AS work_shop_id,
    COALESCE(d.process_version_id, r.process_version_id) AS process_version_id,
    COALESCE(d.section_id, r.produce_section_id) AS section_id,
    COALESCE(d.line_id, r.line_id) AS line_id,
    COALESCE(d.user_line_id, r.user_line_id) AS user_line_id,
    COALESCE(d.produce_process_name, r.produce_process_name) AS produce_process_name,
    COALESCE(d.staff_id, r.staff_id) AS staff_id,
    COALESCE(d.station_no, r.station_no) AS station_no,
    COALESCE(d.reporting_date, r.report_date) AS reporting_date,
    COALESCE(d.craft_seq, r.craft_seq) AS craft_seq,
    COALESCE(d.tenant_code, r.tenant_code) AS tenant_code,
    COALESCE(d.product_code, r.product_code) AS product_code,
    COALESCE(d.color_name, r.color_name) AS color_name,
    COALESCE(d.size_name, r.size_name) AS size_name,
    d.total_qty AS detail_total_qty,
    r.number AS report_output_qty,
    CASE 
        WHEN d.produce_order_code IS NULL THEN '报表多余记录'
        WHEN r.produce_order_code IS NULL THEN '明细多余记录'
        WHEN d.total_qty <> r.number THEN '数量不一致'
        ELSE '一致'
    END AS check_status
FROM detail_summary d
FULL OUTER JOIN report_data r
    ON COALESCE(d.produce_order_code, '__NULL_STR__') = COALESCE(r.produce_order_code, '__NULL_STR__')
    AND COALESCE(d.work_shop_id, -9999) = COALESCE(r.work_shop_id, -9999)
    AND COALESCE(d.process_version_id, -9999) = COALESCE(r.process_version_id, -9999)
    AND COALESCE(d.section_id, -9999) = COALESCE(r.produce_section_id, -9999)
    AND COALESCE(d.line_id, -9999) = COALESCE(r.line_id, -9999)
    AND COALESCE(d.user_line_id, -9999) = COALESCE(r.user_line_id, -9999)
    AND COALESCE(d.produce_process_name, '__NULL_STR__') = COALESCE(r.produce_process_name, '__NULL_STR__')
    AND COALESCE(d.staff_id, '__NULL_STR__') = COALESCE(r.staff_id, '__NULL_STR__')
    AND COALESCE(d.station_no, '__NULL_STR__') = COALESCE(r.station_no, '__NULL_STR__')
    AND COALESCE(d.reporting_date, '1970-01-01'::date) = COALESCE(r.report_date, '1970-01-01'::date)
    AND COALESCE(d.craft_seq, '-99999') = COALESCE(r.craft_seq, '-99999')
    AND COALESCE(d.tenant_code, '__NULL_STR__') = COALESCE(r.tenant_code, '__NULL_STR__')
    AND COALESCE(d.product_code, '__NULL_STR__') = COALESCE(r.product_code, '__NULL_STR__')
    AND COALESCE(d.color_name, '__NULL_STR__') = COALESCE(r.color_name, '__NULL_STR__')
    AND COALESCE(d.size_name, '__NULL_STR__') = COALESCE(r.size_name, '__NULL_STR__')
WHERE d.total_qty IS DISTINCT FROM r.number   -- 只过滤有差异的记录（包括某一方缺失）
ORDER BY check_status, produce_order_code;
        """
        
        columns, rows = execute_sql(mes_config['type'], mes_config, sql)
        if columns is None:
            result.add_warning(f"MES数据库查询失败: {rows}")
            # 即使查询失败，也添加统计信息
            result.add_info("报表多余记录: 0 条")
            result.add_info("明细多余记录: 0 条")
            result.add_info("数量不一致: 0 条")
            continue
        
        if not rows:
            result.add_normal("明细汇总与报表数据完全一致，无差异记录")
            # 即使没有差异记录，也添加统计信息
            result.add_info("报表多余记录: 0 条")
            result.add_info("明细多余记录: 0 条")
            result.add_info("数量不一致: 0 条")
        else:
            result.add_critical(f"共查询到 {len(rows)} 条差异记录")
            # 统计不同类型的差异
            report_extra = sum(1 for row in rows if (isinstance(row, dict) and row.get('check_status') == '报表多余记录') or (not isinstance(row, dict) and len(row) > 17 and row[17] == '报表多余记录'))
            detail_extra = sum(1 for row in rows if (isinstance(row, dict) and row.get('check_status') == '明细多余记录') or (not isinstance(row, dict) and len(row) > 17 and row[17] == '明细多余记录'))
            quantity_mismatch = sum(1 for row in rows if (isinstance(row, dict) and row.get('check_status') == '数量不一致') or (not isinstance(row, dict) and len(row) > 17 and row[17] == '数量不一致'))
            
            result.add_info(f"报表多余记录: {report_extra} 条")
            result.add_info(f"明细多余记录: {detail_extra} 条")
            result.add_info(f"数量不一致: {quantity_mismatch} 条")
    
    result.set_end_time()
    return result

def check_worker_output_without_color_size():
    """工人产量与报工明细稽核（不包含颜色尺码）

    对比维度不含工序名称(produce_process_name)。
    """
    result = InspectionResult()
    result.add_info("========== 开始工人产量与报工明细稽核（不包含颜色尺码） ==========")

    date_config = get_config('inspectionDateConfig')
    date_ranges, warning_msg = get_date_ranges(date_config)

    if warning_msg:
        result.add_warning(warning_msg)

    if not date_ranges:
        today = datetime.datetime.now()
        start_date = today.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "今日"))

    # 从MES数据库查询
    mes_config = get_config('databaseConfig').get('mes')
    if not mes_config:
        result.add_warning("MES数据库配置不存在")
        result.set_end_time()
        return result

    # 构建带schema的表名
    schema = 'jack_mes'

    # 对每个日期范围执行稽核
    for start_date, end_date, range_name in date_ranges:
        result.add_info(f"\n稽核日期范围: {range_name} ({start_date} 至 {end_date})")

        # 计算时间范围
        start_datetime = f"{start_date} 00:00:00"
        end_datetime = f"{end_date} 23:59:59"

        # 枚举日期范围覆盖的所有月份（跨月时最多2张表），构建 UNION ALL 子查询
        cache_months = get_cache_table_months(start_date, end_date)
        cache_union = build_cache_union_subquery(
            schema, cache_months,
            select_columns='''"total",
                "produce_order_code",
                "work_shop_id",
                "process_version_id",
                "section_id",
                "line_id",
                "user_line_id",
                "staff_id",
                "station_no",
                "reporting_date",
                "craft_seq",
                "tenant_code",
                "product_code"''',
            where_clause=f"WHERE \"reporting_work_date\" BETWEEN '{start_datetime}' AND '{end_datetime}'"
        )

        # 稽核脚本：比较明细汇总与报表数据是否一致（不包含颜色尺码，对比维度不含工序名称）
        sql = f"""
        WITH
        -- 明细汇总结果（来自缓存表，跨月时UNION多张分表后按维度去重）
        detail_summary AS (
            SELECT
                SUM("total") AS total_qty,
                "produce_order_code"   AS produce_order_code,
                "work_shop_id"         AS work_shop_id,
                "process_version_id"   AS process_version_id,
                "section_id"           AS section_id,
                "line_id"              AS line_id,
                "user_line_id"         AS user_line_id,
                "staff_id"             AS staff_id,
                "station_no"           AS station_no,
                "reporting_date"       AS reporting_date,
                "craft_seq"            AS craft_seq,
                "tenant_code"          AS tenant_code,
                "product_code"         AS product_code
            FROM {cache_union}
            GROUP BY
                "tenant_code",
                "produce_order_code",
                "work_shop_id",
                "line_id",
                "user_line_id",
                "section_id",
                "process_version_id",
                "staff_id",
                "product_code",
                "station_no",
                "reporting_date",
                "craft_seq"
        ),
        -- 报表数据（来自目标报表表）
        report_data AS (
            SELECT
                COALESCE(sum(number), 0) AS number,
                produce_order_code,
                work_shop_id,
                process_version_id,
                produce_section_id,
                line_id,
                user_line_id,
                staff_id,
                station_no,
                report_date,
                craft_seq,
                tenant_code,
                product_code
            FROM {schema}.report_mes_user_process_output_cache
            WHERE report_date BETWEEN '{start_date}' AND '{end_date}' and is_deleted = 0
            GROUP BY
                produce_order_code,
                work_shop_id,
                process_version_id,
                produce_section_id,
                line_id,
                user_line_id,
                staff_id,
                station_no,
                report_date,
                craft_seq,
                tenant_code,
                product_code
        )
        -- 完全外连接比对
        SELECT
            COALESCE(d.produce_order_code, r.produce_order_code) AS produce_order_code,
            COALESCE(d.work_shop_id, r.work_shop_id) AS work_shop_id,
            COALESCE(d.process_version_id, r.process_version_id) AS process_version_id,
            COALESCE(d.section_id, r.produce_section_id) AS section_id,
            COALESCE(d.line_id, r.line_id) AS line_id,
            COALESCE(d.user_line_id, r.user_line_id) AS user_line_id,
            COALESCE(d.staff_id, r.staff_id) AS staff_id,
            COALESCE(d.station_no, r.station_no) AS station_no,
            COALESCE(d.reporting_date, r.report_date) AS reporting_date,
            COALESCE(d.craft_seq, r.craft_seq) AS craft_seq,
            COALESCE(d.tenant_code, r.tenant_code) AS tenant_code,
            COALESCE(d.product_code, r.product_code) AS product_code,
            d.total_qty AS detail_total_qty,
            r.number AS report_output_qty,
            CASE
                WHEN d.produce_order_code IS NULL THEN '报表多余记录'
                WHEN r.produce_order_code IS NULL THEN '明细多余记录'
                WHEN d.total_qty <> r.number THEN '数量不一致'
                ELSE '一致'
            END AS check_status
        FROM detail_summary d
        FULL OUTER JOIN report_data r
            ON COALESCE(d.produce_order_code, '__NULL_STR__') = COALESCE(r.produce_order_code, '__NULL_STR__')
            AND COALESCE(d.work_shop_id, -9999) = COALESCE(r.work_shop_id, -9999)
            AND COALESCE(d.process_version_id, -9999) = COALESCE(r.process_version_id, -9999)
            AND COALESCE(d.section_id, -9999) = COALESCE(r.produce_section_id, -9999)
            AND COALESCE(d.line_id, -9999) = COALESCE(r.line_id, -9999)
            AND COALESCE(d.user_line_id, -9999) = COALESCE(r.user_line_id, -9999)
            AND COALESCE(d.staff_id, '__NULL_STR__') = COALESCE(r.staff_id, '__NULL_STR__')
            AND COALESCE(d.station_no, '__NULL_STR__') = COALESCE(r.station_no, '__NULL_STR__')
            AND COALESCE(d.reporting_date, '1970-01-01'::date) = COALESCE(r.report_date, '1970-01-01'::date)
            AND COALESCE(d.craft_seq, '-99999') = COALESCE(r.craft_seq, '-99999')
            AND COALESCE(d.tenant_code, '__NULL_STR__') = COALESCE(r.tenant_code, '__NULL_STR__')
            AND COALESCE(d.product_code, '__NULL_STR__') = COALESCE(r.product_code, '__NULL_STR__')
        WHERE d.total_qty IS DISTINCT FROM r.number
        ORDER BY check_status, produce_order_code
        """

        columns, rows = execute_sql(mes_config['type'], mes_config, sql)
        if columns is None:
            result.add_warning(f"MES数据库查询失败: {rows}")
            # 即使查询失败，也添加统计信息
            result.add_info("报表多余记录: 0 条")
            result.add_info("明细多余记录: 0 条")
            result.add_info("数量不一致: 0 条")
            continue

        if not rows:
            result.add_normal("明细汇总与报表数据完全一致，无差异记录")
            # 即使没有差异记录，也添加统计信息
            result.add_info("报表多余记录: 0 条")
            result.add_info("明细多余记录: 0 条")
            result.add_info("数量不一致: 0 条")
        else:
            result.add_critical(f"共查询到 {len(rows)} 条差异记录")
            # 统计不同类型的差异（按列名定位 check_status，避免列顺序变化导致索引错位）
            report_extra, detail_extra, quantity_mismatch = _count_check_status(columns, rows)
            result.add_info(f"报表多余记录: {report_extra} 条")
            result.add_info(f"明细多余记录: {detail_extra} 条")
            result.add_info(f"数量不一致: {quantity_mismatch} 条")

    result.set_end_time()
    return result

def check_mes_hanging():
    """MES报工明细与吊挂报工明细稽核"""
    result = InspectionResult()
    result.add_info("========== 开始MES报工明细与吊挂报工明细稽核 ==========")
    
    date_config = get_config('inspectionDateConfig')
    date_ranges, warning_msg = get_date_ranges(date_config)
    
    if warning_msg:
        result.add_warning(warning_msg)
    
    if not date_ranges:
        today = datetime.datetime.now()
        start_date = today.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "今日"))
    
    # 从MySQL（吊挂）数据库查询
    hanging_config = get_config('databaseConfig').get('hanging')
    if not hanging_config:
        result.add_warning("吊挂数据库配置不存在")
        result.set_end_time()
        return result
    
    # 从PostgreSQL（MES）数据库查询
    mes_config = get_config('databaseConfig').get('mes')
    if not mes_config:
        result.add_warning("MES数据库配置不存在")
        result.set_end_time()
        return result
    
    # 构建带schema的表名
    schema = 'jack_mes'
    
    # 对每个日期范围执行稽核
    for start_date, end_date, range_name in date_ranges:
        result.add_info(f"\n稽核日期范围: {range_name} ({start_date} 至 {end_date})")
        
        # 计算时间范围
        start_datetime = f"{start_date} 00:00:00"
        end_datetime = f"{end_date} 23:59:59"

        # 枚举日期范围覆盖的所有月份（跨月时最多2张表），构建 UNION ALL 子查询
        cache_months = get_cache_table_months(start_date, end_date)
        cache_union = build_cache_union_subquery(
            schema, cache_months,
            select_columns='"total"',
            where_clause=f"WHERE reporting_work_date BETWEEN '{start_datetime}' AND '{end_datetime}' AND type = 1"
        )

        # 从吊挂数据库查询
        sql1 = f"""
        SELECT COUNT(*), COALESCE(SUM(garments), 0)
        FROM dg_route_record
        WHERE complete_time >= '{start_datetime}'
        AND complete_time <= '{end_datetime}'
        """
        
        columns1, rows1 = execute_sql(hanging_config['type'], hanging_config, sql1)
        if columns1 is None:
            result.add_warning(f"吊挂数据库查询失败: {rows1}")
            continue
        
        if not rows1:
            count1, sum1 = 0, 0
        else:
            row1 = rows1[0]
            if isinstance(row1, dict):
                count1 = float(row1.get(columns1[0], 0))
                sum1 = float(row1.get(columns1[1], 0))
            else:
                count1 = float(row1[0]) if row1 else 0
                sum1 = float(row1[1]) if row1 else 0
        
        # 从MES数据库查询（跨月时对多张分表UNION后再聚合）
        sql2 = f"""
        SELECT COUNT(*), COALESCE(SUM(total), 0)
        FROM {cache_union}
        """
        
        columns2, rows2 = execute_sql(mes_config['type'], mes_config, sql2)
        if columns2 is None:
            result.add_warning(f"MES数据库查询失败: {rows2}")
            continue
        
        if not rows2:
            count2, sum2 = 0, 0
        else:
            row2 = rows2[0]
            if isinstance(row2, dict):
                count2 = float(row2.get(columns2[0], 0))
                sum2 = float(row2.get(columns2[1], 0))
            else:
                count2 = float(row2[0]) if row2 else 0
                sum2 = float(row2[1]) if row2 else 0
        
        # 数据比较
        is_consistent = count1 == count2 and sum1 == sum2
        
        # 添加结果信息
        result.add_info(f"吊挂系统: 记录数={count1}, 数量总和={sum1}")
        result.add_info(f"MES系统: 记录数={count2}, 数量总和={sum2}")
        
        if is_consistent:
            result.add_normal("MES报工明细与吊挂报工明细数据一致")
        else:
            result.add_critical("MES报工明细与吊挂报工明细数据不一致")
            result.add_info(f"差异: 记录数={count1 - count2}, 数量总和={sum1 - sum2}")
    
    result.set_end_time()
    return result

