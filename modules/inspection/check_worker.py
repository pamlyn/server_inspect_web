"""Worker稽核函数模块 - check_worker_output系列"""

import datetime
from modules.inspection.models import InspectionResult
from modules.inspection.helpers import execute_sql
from modules.config_mgmt.helpers import get_config

def check_worker_output():
    """工人产量与报工明细稽核"""
    result = InspectionResult()
    result.add_info("========== 开始工人产量与报工明细稽核 ==========")
    
    # 获取日期配置
    date_config = get_config('inspectionDateConfig')
    date_options = date_config.get('options', {})
    custom_range = date_config.get('custom_date_range', {})
    
    # 计算不同日期范围
    today = datetime.datetime.now()
    yesterday = today - datetime.timedelta(days=1)
    current_month_start = today.replace(day=1)
    
    # 定义日期范围列表
    date_ranges = []
    
    # 根据配置添加日期范围
    if date_options.get('yesterday', False):
        start_date = yesterday.strftime('%Y-%m-%d')
        end_date = yesterday.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "昨日"))
    
    if date_options.get('today', False):
        start_date = today.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "今日"))
    
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
            # 验证开始日期和结束日期是否在同一个月
            start_month = start_date[:7]  # YYYY-MM
            end_month = end_date[:7]  # YYYY-MM
            if start_month == end_month:
                date_ranges.append((start_date, end_date, "自定义日期范围"))
            else:
                result.add_warning("自定义日期范围的开始日期和结束日期不在同一个月，跳过")
    
    # 如果没有配置日期范围，默认使用今日
    if not date_ranges:
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
        
        # 构建缓存表名（使用开始日期的年份和月份）
        year = start_date.split('-')[0]
        month = int(start_date.split('-')[1])
        cache_table = f"produce_mes_reporting_work_cache_{year}_{month}"
        
        # 稽核脚本：比较明细汇总与报表数据是否一致（包含颜色尺码）
        sql = f"""
        WITH 
        -- 明细汇总结果（来自缓存表）
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
                "color_name"            AS color_name,
                "size_name"            AS size_name
            FROM {schema}.{cache_table}
            WHERE "reporting_work_date" BETWEEN '{start_datetime}' AND '{end_datetime}'
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
                number,
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
                "color_name"            AS color_name,
                "size_name"            AS size_name
            FROM {schema}.report_mes_user_process_output_cache
            WHERE report_date BETWEEN '{start_date}' AND '{end_date}'
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
            ON d.produce_order_code = r.produce_order_code
            AND d.work_shop_id = r.work_shop_id
            AND d.process_version_id = r.process_version_id
            AND d.section_id = r.produce_section_id
            AND d.line_id = r.line_id
            AND d.user_line_id = r.user_line_id
            AND d.produce_process_name = r.produce_process_name
            AND d.staff_id = r.staff_id
            AND d.station_no = r.station_no
            AND d.reporting_date = r.report_date
            AND d.craft_seq = r.craft_seq
            AND d.tenant_code = r.tenant_code
            AND d.product_code = r.product_code
            AND d.color_name = r.color_name
            AND d.size_name = r.size_name
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
            # 统计不同类型的差异
            report_extra = sum(1 for row in rows if (isinstance(row, dict) and row.get('check_status') == '报表多余记录') or (not isinstance(row, dict) and len(row) > 17 and row[17] == '报表多余记录'))
            detail_extra = sum(1 for row in rows if (isinstance(row, dict) and row.get('check_status') == '明细多余记录') or (not isinstance(row, dict) and len(row) > 17 and row[17] == '明细多余记录'))
            quantity_mismatch = sum(1 for row in rows if (isinstance(row, dict) and row.get('check_status') == '数量不一致') or (not isinstance(row, dict) and len(row) > 17 and row[17] == '数量不一致'))
            
            result.add_info(f"报表多余记录: {report_extra} 条")
            result.add_info(f"明细多余记录: {detail_extra} 条")
            result.add_info(f"数量不一致: {quantity_mismatch} 条")
    
    result.set_end_time()
    return result

def check_worker_output_sfd():
    """工人产量与报工明细数据稽核(sfd)"""
    result = InspectionResult()
    result.add_info("========== 开始工人产量与报工明细数据稽核(sfd) ==========")
    
    # 获取日期配置
    date_config = get_config('inspectionDateConfig')
    date_options = date_config.get('options', {})
    custom_range = date_config.get('custom_date_range', {})
    
    # 计算不同日期范围
    today = datetime.datetime.now()
    yesterday = today - datetime.timedelta(days=1)
    current_month_start = today.replace(day=1)
    
    # 定义日期范围列表
    date_ranges = []
    
    # 根据配置添加日期范围
    if date_options.get('yesterday', False):
        start_date = yesterday.strftime('%Y-%m-%d')
        end_date = yesterday.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "昨日"))
    
    if date_options.get('today', False):
        start_date = today.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "今日"))
    
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
            # 验证开始日期和结束日期是否在同一个月
            start_month = start_date[:7]  # YYYY-MM
            end_month = end_date[:7]  # YYYY-MM
            if start_month == end_month:
                date_ranges.append((start_date, end_date, "自定义日期范围"))
            else:
                result.add_warning("自定义日期范围的开始日期和结束日期不在同一个月，跳过")
    
    # 如果没有配置日期范围，默认使用今日
    if not date_ranges:
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
        
        # 构建缓存表名（使用开始日期的年份和月份）
        year = start_date.split('-')[0]
        month = int(start_date.split('-')[1])
        cache_table = f"produce_mes_reporting_work_cache_{year}_{month}"
        
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
     FROM {schema}.{cache_table} 
     WHERE "reporting_work_date" BETWEEN '{start_datetime}' AND '{end_datetime}' 
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
    WHERE report_date between '{start_date}' and '{end_date}'
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
    ON d.produce_order_code = r.produce_order_code
    AND d.work_shop_id = r.work_shop_id
    AND d.process_version_id = r.process_version_id
    AND d.section_id = r.produce_section_id
    AND d.line_id = r.line_id
    AND d.user_line_id = r.user_line_id
    AND d.produce_process_name = r.produce_process_name
    AND d.staff_id = r.staff_id
    AND d.station_no = r.station_no
    AND d.reporting_date = r.report_date
    AND d.craft_seq = r.craft_seq
    AND d.tenant_code = r.tenant_code
    AND d.product_code = r.product_code
    AND d.color_name = r.color_name
    AND d.size_name = r.size_name
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
    """工人产量与报工明细稽核（不包含颜色尺码）"""
    result = InspectionResult()
    result.add_info("========== 开始工人产量与报工明细稽核（不包含颜色尺码） ==========")
    
    # 获取日期配置
    date_config = get_config('inspectionDateConfig')
    date_options = date_config.get('options', {})
    custom_range = date_config.get('custom_date_range', {})
    
    # 计算不同日期范围
    today = datetime.datetime.now()
    yesterday = today - datetime.timedelta(days=1)
    current_month_start = today.replace(day=1)
    
    # 定义日期范围列表
    date_ranges = []
    
    # 根据配置添加日期范围
    if date_options.get('yesterday', False):
        start_date = yesterday.strftime('%Y-%m-%d')
        end_date = yesterday.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "昨日"))
    
    if date_options.get('today', False):
        start_date = today.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "今日"))
    
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
            # 验证开始日期和结束日期是否在同一个月
            start_month = start_date[:7]  # YYYY-MM
            end_month = end_date[:7]  # YYYY-MM
            if start_month == end_month:
                date_ranges.append((start_date, end_date, "自定义日期范围"))
            else:
                result.add_warning("自定义日期范围的开始日期和结束日期不在同一个月，跳过")
    
    # 如果没有配置日期范围，默认使用今日
    if not date_ranges:
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
        
        # 构建缓存表名（使用开始日期的年份和月份）
        year = start_date.split('-')[0]
        month = int(start_date.split('-')[1])
        cache_table = f"produce_mes_reporting_work_cache_{year}_{month}"
        
        # 稽核脚本：比较明细汇总与报表数据是否一致（不包含颜色尺码）
        sql = f"""
        WITH 
        -- 明细汇总结果（来自缓存表）
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
                "product_code"         AS product_code
            FROM {schema}.{cache_table}
            WHERE "reporting_work_date" BETWEEN '{start_datetime}' AND '{end_datetime}'
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
                produce_process_name,
                staff_id,
                station_no,
                report_date,
                craft_seq,
                tenant_code,
                product_code
            FROM {schema}.report_mes_user_process_output_cache
            WHERE report_date BETWEEN '{start_date}' AND '{end_date}'
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
            COALESCE(d.produce_process_name, r.produce_process_name) AS produce_process_name,
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
            ON d.produce_order_code = r.produce_order_code
            AND d.work_shop_id = r.work_shop_id
            AND d.process_version_id = r.process_version_id
            AND d.section_id = r.produce_section_id
            AND d.line_id = r.line_id
            AND d.user_line_id = r.user_line_id
            AND d.produce_process_name = r.produce_process_name
            AND d.staff_id = r.staff_id
            AND d.station_no = r.station_no
            AND d.reporting_date = r.report_date
            AND d.craft_seq = r.craft_seq
            AND d.tenant_code = r.tenant_code
            AND d.product_code = r.product_code
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
            # 统计不同类型的差异
            report_extra = sum(1 for row in rows if (isinstance(row, dict) and row.get('check_status') == '报表多余记录') or (not isinstance(row, dict) and len(row) > 15 and row[15] == '报表多余记录'))
            detail_extra = sum(1 for row in rows if (isinstance(row, dict) and row.get('check_status') == '明细多余记录') or (not isinstance(row, dict) and len(row) > 15 and row[15] == '明细多余记录'))
            quantity_mismatch = sum(1 for row in rows if (isinstance(row, dict) and row.get('check_status') == '数量不一致') or (not isinstance(row, dict) and len(row) > 15 and row[15] == '数量不一致'))
            
            result.add_info(f"报表多余记录: {report_extra} 条")
            result.add_info(f"明细多余记录: {detail_extra} 条")
            result.add_info(f"数量不一致: {quantity_mismatch} 条")
    
    result.set_end_time()
    return result

def check_mes_hanging():
    """MES报工明细与吊挂报工明细稽核"""
    result = InspectionResult()
    result.add_info("========== 开始MES报工明细与吊挂报工明细稽核 ==========")
    
    # 获取日期配置
    date_config = get_config('inspectionDateConfig')
    date_options = date_config.get('options', {})
    custom_range = date_config.get('custom_date_range', {})
    
    # 计算不同日期范围
    today = datetime.datetime.now()
    yesterday = today - datetime.timedelta(days=1)
    current_month_start = today.replace(day=1)
    
    # 定义日期范围列表
    date_ranges = []
    
    # 根据配置添加日期范围
    if date_options.get('yesterday', False):
        start_date = yesterday.strftime('%Y-%m-%d')
        end_date = yesterday.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "昨日"))
    
    if date_options.get('today', False):
        start_date = today.strftime('%Y-%m-%d')
        end_date = today.strftime('%Y-%m-%d')
        date_ranges.append((start_date, end_date, "今日"))
    
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
            # 验证开始日期和结束日期是否在同一个月
            start_month = start_date[:7]  # YYYY-MM
            end_month = end_date[:7]  # YYYY-MM
            if start_month == end_month:
                date_ranges.append((start_date, end_date, "自定义日期范围"))
            else:
                result.add_warning("自定义日期范围的开始日期和结束日期不在同一个月，跳过")
    
    # 如果没有配置日期范围，默认使用今日
    if not date_ranges:
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
        
        # 生成缓存表名（使用开始日期的年份和月份）
        year = start_date.split('-')[0]
        month = int(start_date.split('-')[1])
        cache_table = f"produce_mes_reporting_work_cache_{year}_{month}"
        full_table_name = f"{schema}.{cache_table}"
        
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
        
        # 从MES数据库查询
        sql2 = f"""
        SELECT COUNT(*), COALESCE(SUM(total), 0)
        FROM {full_table_name}
        WHERE reporting_work_date BETWEEN '{start_datetime}' AND '{end_datetime}'
        AND type = 1
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

