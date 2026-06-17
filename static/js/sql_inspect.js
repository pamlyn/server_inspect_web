/**
 * sql_inspect.js — SQL inspect page JS for the Server Inspection System
 * Contains: showSqlInspect(), SQL inspect execution logic, SQL result display,
 * SQL export logic, MES hanging inspect functions, date range validation,
 * SQL type selection change handlers, and color/size dimension toggle logic.
 * Depends on: app.js (showToast, hideAllContent)
 */

// ========== showSqlInspect — overwrite the app.js placeholder ==========

window.showSqlInspect = function () {
    hideAllContent();
    const results = document.getElementById('results');
    const sqlInspectContent = document.getElementById('sqlInspectContent');

    results.classList.remove('hidden');
    configContent.classList.add('hidden');
    sqlInspectContent.classList.remove('hidden');

    // Hide other content areas
    document.querySelectorAll('#results > div').forEach(div => {
        if (div.id !== 'sqlInspectContent') {
            div.classList.add('hidden');
        }
    });
    // Hide slow SQL dedup option
    const deduplicateOption = document.getElementById('deduplicateOption');
    if (deduplicateOption) {
        deduplicateOption.classList.add('hidden');
    }

    // Trigger SQL type change event to auto-generate SQL script
    const sqlInspectType = document.getElementById('sqlInspectType');
    if (sqlInspectType) {
        const event = new Event('change');
        sqlInspectType.dispatchEvent(event);
    }
};

// ========== DOMContentLoaded Setup ==========

document.addEventListener('DOMContentLoaded', function () {
    const executeSqlBtn = document.getElementById('executeSqlBtn');
    const exportSqlBtn = document.getElementById('exportSqlBtn');
    const sqlResult = document.getElementById('sqlResult');
    const sqlResultHeader = document.getElementById('sqlResultHeader');
    const sqlResultBody = document.getElementById('sqlResultBody');
    const sqlInspectType = document.getElementById('sqlInspectType');
    const dateRangeContainer = document.getElementById('dateRangeContainer');
    const colorSizeContainer = document.getElementById('colorSizeContainer');
    const includeColorSize = document.getElementById('includeColorSize');
    const inspectDateStart = document.getElementById('inspectDateStart');
    const inspectDateEnd = document.getElementById('inspectDateEnd');
    const dateRangeHint = document.getElementById('dateRangeHint');
    const sqlQuery = document.getElementById('sqlQuery');

    // ========== Date range validation ==========

    function validateDateRange() {
        const startDate = inspectDateStart.value;
        const endDate = inspectDateEnd.value;

        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);

            if (start.getMonth() !== end.getMonth() || start.getFullYear() !== end.getFullYear()) {
                dateRangeHint.textContent = '错误：开始日期和结束日期必须在同一月';
                dateRangeHint.className = 'text-xs text-red-500 mt-1';
                return false;
            }
            if (start > end) {
                dateRangeHint.textContent = '错误：开始日期不能晚于结束日期';
                dateRangeHint.className = 'text-xs text-red-500 mt-1';
                return false;
            }
            dateRangeHint.textContent = `已选择：${startDate} 至 ${endDate}`;
            dateRangeHint.className = 'text-xs text-green-500 mt-1';
            return true;
        }
        dateRangeHint.textContent = '请选择开始和结束日期（同一月内）';
        dateRangeHint.className = 'text-xs text-gray-500 mt-1';
        return false;
    }

    // Date input change listeners
    if (inspectDateStart && inspectDateEnd) {
        inspectDateStart.addEventListener('change', function () {
            validateDateRange();
            if (sqlInspectType.value !== 'custom') {
                const event = new Event('change');
                sqlInspectType.dispatchEvent(event);
            }
        });
        inspectDateEnd.addEventListener('change', function () {
            validateDateRange();
            if (sqlInspectType.value !== 'custom') {
                const event = new Event('change');
                sqlInspectType.dispatchEvent(event);
            }
        });
    }

    // ========== SQL type selection change handler ==========

    if (sqlInspectType) {
        sqlInspectType.addEventListener('change', function () {
            const type = this.value;

            // Show/hide date selector and color/size dimension selector
            if (type === 'worker_output' || type === 'worker_output_sfd' || type === 'mes_hanging') {
                dateRangeContainer.classList.remove('hidden');
            } else {
                dateRangeContainer.classList.add('hidden');
            }

            // Only worker_output needs color/size dimension selector
            if (type === 'worker_output') {
                colorSizeContainer.classList.remove('hidden');
            } else {
                colorSizeContainer.classList.add('hidden');
            }

            // For mes_hanging, show database selector
            const sqlDatabaseContainer = document.getElementById('sqlDatabaseContainer');
            if (sqlDatabaseContainer) {
                if (type === 'mes_hanging') {
                    sqlDatabaseContainer.classList.remove('hidden');
                }
            }

            // Generate SQL based on type
            if (type === 'worker_output_sfd') {
                includeColorSize.checked = true;

                const startDate = inspectDateStart.value;
                const endDate = inspectDateEnd.value;

                if (startDate && endDate) {
                    const dateObj = new Date(startDate);
                    const year = dateObj.getFullYear();
                    const month = dateObj.getMonth() + 1;
                    const tableSuffix = `${year}_${month}`;

                    const sql = `
-- 稽核脚本：比较明细汇总与工人产量报表数据是否一致
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
        "color_name"           AS color_name,
        "size_name"            AS size_name
     FROM jack_mes.produce_mes_reporting_work_cache_${tableSuffix}
     WHERE "reporting_work_date" BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59'
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
    FROM jack_mes.sfd_repo_mes_sfd_user_process_output_report
    WHERE report_date BETWEEN '${startDate}' AND '${endDate}'
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
ORDER BY check_status, produce_order_code;`;
                    sqlQuery.value = sql;
                }
            } else if (type === 'worker_output') {
                includeColorSize.checked = true;

                const startDate = inspectDateStart.value;
                const endDate = inspectDateEnd.value;

                if (startDate && endDate) {
                    const dateObj = new Date(startDate);
                    const year = dateObj.getFullYear();
                    const month = dateObj.getMonth() + 1;
                    const tableSuffix = `${year}_${month}`;

                    const sql = `-- 稽核脚本：比较明细汇总与报表数据是否一致
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
     FROM jack_mes.produce_mes_reporting_work_cache_${tableSuffix}
     WHERE "reporting_work_date" BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59'
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
         "color_name"            AS color_name,
         "size_name"            AS size_name
     FROM jack_mes.report_mes_user_process_output_cache
     WHERE report_date BETWEEN '${startDate}' AND '${endDate}'
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
 ORDER BY check_status, produce_order_code;`;
                    sqlQuery.value = sql;
                }
            } else if (type === 'mes_hanging') {
                // MES报工明细与吊挂报工明细稽查
                const startDate = inspectDateStart.value;
                const endDate = inspectDateEnd.value;

                if (startDate && endDate) {
                    const dateObj = new Date(startDate);
                    const year = dateObj.getFullYear();
                    const month = dateObj.getMonth() + 1;
                    const tableSuffix = `${year}_${month}`;

                    const sql = `-- MES报工明细与吊挂报工明细稽查脚本
-- 1. 从吊挂数据库（MySQL）查询
SELECT COUNT(*) AS hanging_count, COALESCE(SUM(garments), 0) AS hanging_sum
FROM dg_route_record
WHERE complete_time BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59';

-- 2. 从MES数据库（PostgreSQL）查询
SELECT COUNT(*) AS mes_count, COALESCE(SUM(total), 0) AS mes_sum
FROM jack_mes.produce_mes_reporting_work_cache_${tableSuffix}
WHERE reporting_work_date BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59'
AND type = 1`;
                    sqlQuery.value = sql;
                }
            } else {
                // Custom SQL
                sqlQuery.value = '';
            }
        });
    }

    // ========== Color/size dimension change listener ==========

    if (includeColorSize) {
        includeColorSize.addEventListener('change', updateWorkerOutputSQL);
    }

    if (inspectDateStart) {
        inspectDateStart.addEventListener('change', updateWorkerOutputSQL);
    }
    if (inspectDateEnd) {
        inspectDateEnd.addEventListener('change', updateWorkerOutputSQL);
    }

    // ========== updateWorkerOutputSQL ==========

    function updateWorkerOutputSQL() {
        const type = sqlInspectType.value;
        const startDate = inspectDateStart.value;
        const endDate = inspectDateEnd.value;

        if (type === 'worker_output' && startDate && endDate) {
            const hasColorSize = includeColorSize.checked;
            const dateObj = new Date(startDate);
            const year = dateObj.getFullYear();
            const month = dateObj.getMonth() + 1;
            const tableSuffix = `${year}_${month}`;
            let sql;
            if (hasColorSize) {
                sql = `-- 稽核脚本：比较明细汇总与报表数据是否一致（包含颜色尺码维度）
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
     FROM jack_mes.produce_mes_reporting_work_cache_${tableSuffix}
     WHERE "reporting_work_date" BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59'
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
         "color_name"            AS color_name,
         "size_name"            AS size_name
     FROM jack_mes.report_mes_user_process_output_cache
     WHERE report_date BETWEEN '${startDate}' AND '${endDate}'
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
 ORDER BY check_status, produce_order_code;`;
            } else {
                // SQL without color/size dimension
                sql = `-- 稽核脚本：比较明细汇总与报表数据是否一致（无颜色尺码维度）
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
     FROM jack_mes.produce_mes_reporting_work_cache_${tableSuffix}
     WHERE "reporting_work_date" BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59'
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
     FROM jack_mes.report_mes_user_process_output_cache
     WHERE report_date BETWEEN '${startDate}' AND '${endDate}'
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
 WHERE d.total_qty IS DISTINCT FROM r.number   -- 只过滤有差异的记录（包括某一方缺失）
 ORDER BY check_status, produce_order_code;`;
            }
            sqlQuery.value = sql;
        } else if (type === 'worker_output_sfd' && startDate && endDate) {
            const hasColorSize = includeColorSize.checked;
            let sql = '';
            const dateObj = new Date(startDate);
            const year = dateObj.getFullYear();
            const month = dateObj.getMonth() + 1;
            const tableSuffix = `${year}_${month}`;
            sql = `
-- 稽核脚本：比较明细汇总与工人产量报表数据是否一致
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
        "color_name"           AS color_name,
        "size_name"            AS size_name
     FROM jack_mes.produce_mes_reporting_work_cache_${tableSuffix}
     WHERE "reporting_work_date" BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59'
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
    FROM jack_mes.sfd_repo_mes_sfd_user_process_output_report
    WHERE report_date BETWEEN '${startDate}' AND '${endDate}'
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
ORDER BY check_status, produce_order_code`;
            sqlQuery.value = sql;
        } else if (type === 'mes_hanging' && startDate && endDate) {
            const dateObj = new Date(startDate);
            const year = dateObj.getFullYear();
            const month = dateObj.getMonth() + 1;
            const tableSuffix = `${year}_${month}`;

            const sql = `-- MES报工明细与吊挂报工明细稽查脚本
-- 1. 从吊挂数据库（MySQL）查询
SELECT COUNT(*) AS hanging_count, COALESCE(SUM(garments), 0) AS hanging_sum
FROM dg_route_record
WHERE complete_time BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59';

-- 2. 从MES数据库（PostgreSQL）查询
SELECT COUNT(*) AS mes_count, COALESCE(SUM(total), 0) AS mes_sum
FROM jack_mes.produce_mes_reporting_work_cache_${tableSuffix}
WHERE reporting_work_date BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59'
AND type = 1`;

            sqlQuery.value = sql;
        }
    }

    // ========== Execute SQL button ==========

    if (executeSqlBtn) {
        executeSqlBtn.addEventListener('click', function () {
            const type = sqlInspectType.value;
            const sql = document.getElementById('sqlQuery').value;

            if (!sql) {
                showToast('请输入SQL语句', 'warning');
                return;
            }

            // Show loading state
            executeSqlBtn.innerHTML = '<i class="fa fa-spinner fa-spin mr-2"></i>执行中...';
            executeSqlBtn.disabled = true;

            if (type === 'mes_hanging') {
                // MES hanging inspect — use dedicated API
                const startDate = inspectDateStart.value;
                const endDate = inspectDateEnd.value;
                if (!startDate || !endDate) {
                    showToast('请选择开始日期和结束日期', 'warning');
                    executeSqlBtn.innerHTML = '<i class="fa fa-play mr-2"></i>执行SQL';
                    executeSqlBtn.disabled = false;
                    return;
                }

                fetch('/api/inspect/mes_hanging', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ start_date: startDate, end_date: endDate })
                })
                    .then(response => response.json())
                    .then(data => {
                        if (data.error) {
                            showToast('执行失败: ' + data.error, 'error');
                            return;
                        }

                        // Show results
                        sqlResult.classList.remove('hidden');

                        // Generate header
                        sqlResultHeader.innerHTML = '';
                        const headerRow = document.createElement('tr');
                        const columns = ['日期范围', '吊挂记录数', '吊挂数量总和', 'MES记录数', 'MES数量总和', '是否一致'];
                        columns.forEach(column => {
                            const th = document.createElement('th');
                            th.className = 'px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
                            th.textContent = column;
                            headerRow.appendChild(th);
                        });
                        sqlResultHeader.appendChild(headerRow);

                        // Generate data row
                        sqlResultBody.innerHTML = '';
                        const dataRow = document.createElement('tr');
                        dataRow.className = 'hover:bg-gray-50 transition-all';

                        const values = [
                            `${data.start_date} 至 ${data.end_date}`,
                            data.hanging.count,
                            data.hanging.sum,
                            data.mes.count,
                            data.mes.sum,
                            data.is_consistent ? '一致' : '不一致'
                        ];

                        values.forEach(value => {
                            const td = document.createElement('td');
                            td.className = 'px-4 py-3 whitespace-nowrap text-sm text-gray-500';
                            td.textContent = value;
                            dataRow.appendChild(td);
                        });

                        sqlResultBody.appendChild(dataRow);
                    })
                    .catch(error => {
                        showToast('执行失败: ' + error.message, 'error');
                    })
                    .finally(() => {
                        executeSqlBtn.innerHTML = '<i class="fa fa-play mr-2"></i>执行SQL';
                        executeSqlBtn.disabled = false;
                    });
            } else {
                // Other types — use generic SQL execution API
                const database = document.getElementById('sqlDatabase').value;

                fetch('/api/inspect/sql', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ database, sql })
                })
                    .then(response => response.json())
                    .then(data => {
                        if (data.error) {
                            showToast('执行失败: ' + data.error, 'error');
                            return;
                        }

                        // Show results
                        sqlResult.classList.remove('hidden');

                        // Generate header
                        sqlResultHeader.innerHTML = '';
                        const headerRow = document.createElement('tr');
                        data.columns.forEach(column => {
                            const th = document.createElement('th');
                            th.className = 'px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
                            th.textContent = column;
                            headerRow.appendChild(th);
                        });
                        sqlResultHeader.appendChild(headerRow);

                        // Generate data rows
                        sqlResultBody.innerHTML = '';
                        data.rows.forEach((row, rowIndex) => {
                            const dataRow = document.createElement('tr');
                            dataRow.className = 'hover:bg-gray-50 transition-all';

                            data.columns.forEach((column, colIndex) => {
                                const td = document.createElement('td');
                                td.className = 'px-4 py-3 whitespace-nowrap text-sm text-gray-500';
                                let value = '';
                                if (Array.isArray(row)) {
                                    value = row[colIndex];
                                } else {
                                    value = row[column];
                                }
                                if (value === null || value === undefined) {
                                    td.textContent = '';
                                } else if (typeof value === 'number') {
                                    if (Number.isInteger(value) && Math.abs(value).toString().length > 12) {
                                        td.textContent = value.toString();
                                    } else {
                                        td.textContent = value;
                                    }
                                } else {
                                    td.textContent = value;
                                }
                                dataRow.appendChild(td);
                            });

                            sqlResultBody.appendChild(dataRow);
                        });
                    })
                    .catch(error => {
                        showToast('执行失败: ' + error.message, 'error');
                    })
                    .finally(() => {
                        executeSqlBtn.innerHTML = '<i class="fa fa-play mr-2"></i>执行SQL';
                        executeSqlBtn.disabled = false;
                    });
            }
        });
    }

    // ========== Export SQL button ==========

    if (exportSqlBtn) {
        exportSqlBtn.addEventListener('click', function () {
            const type = sqlInspectType.value;
            const sql = document.getElementById('sqlQuery').value;

            // Get inspection name
            const typeNames = {
                'custom': '自定义SQL稽核',
                'worker_output': '工人产量与报工明细稽核',
                'worker_output_sfd': '工人产量与报工明细数据稽核(sfd)',
                'mes_hanging': 'MES报工明细与吊挂报工明细稽核'
            };
            const inspectName = typeNames[type] || 'sql_result';

            if (!sql) {
                showToast('请输入SQL语句', 'warning');
                return;
            }

            if (type === 'mes_hanging') {
                // MES hanging — use dedicated export API
                const startDate = document.getElementById('inspectDateStart').value;
                const endDate = document.getElementById('inspectDateEnd').value;
                if (!startDate || !endDate) {
                    showToast('请选择日期范围', 'warning');
                    return;
                }

                // Create form submission
                const form = document.createElement('form');
                form.method = 'POST';
                form.action = '/api/inspect/mes_hanging/export';
                form.target = '_blank';

                const startDateInput = document.createElement('input');
                startDateInput.type = 'hidden';
                startDateInput.name = 'start_date';
                startDateInput.value = startDate;
                form.appendChild(startDateInput);

                const endDateInput = document.createElement('input');
                endDateInput.type = 'hidden';
                endDateInput.name = 'end_date';
                endDateInput.value = endDate;
                form.appendChild(endDateInput);

                const inspectNameInput = document.createElement('input');
                inspectNameInput.type = 'hidden';
                inspectNameInput.name = 'inspect_name';
                inspectNameInput.value = inspectName;
                form.appendChild(inspectNameInput);

                document.body.appendChild(form);
                form.submit();
                document.body.removeChild(form);
            } else {
                // Other types — use generic SQL export API
                const database = document.getElementById('sqlDatabase').value;

                const form = document.createElement('form');
                form.method = 'POST';
                form.action = '/api/inspect/sql/export';
                form.target = '_blank';

                const databaseInput = document.createElement('input');
                databaseInput.type = 'hidden';
                databaseInput.name = 'database';
                databaseInput.value = database;
                form.appendChild(databaseInput);

                const sqlInput = document.createElement('input');
                sqlInput.type = 'hidden';
                sqlInput.name = 'sql';
                sqlInput.value = sql;
                form.appendChild(sqlInput);

                const inspectNameInput = document.createElement('input');
                inspectNameInput.type = 'hidden';
                inspectNameInput.name = 'inspect_name';
                inspectNameInput.value = inspectName;
                form.appendChild(inspectNameInput);

                document.body.appendChild(form);
                form.submit();
                document.body.removeChild(form);
            }
        });
    }
});