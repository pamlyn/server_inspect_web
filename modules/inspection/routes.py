"""
巡检模块 - 路由定义
"""

from flask import Blueprint, jsonify, request, send_file, session
import datetime
import csv
import io
import time

from modules.auth.helpers import login_required
from modules.inspection.helpers import get_inspection_functions, run_full_inspection, execute_sql
from modules.inspection.models import InspectionResult
from modules.inspection.check_worker import get_cache_table_months, build_cache_union_subquery
from modules.config_mgmt.helpers import get_config, notification_cooldowns
from modules.log_storage.helpers import record_inspection_log, derive_status
from dingtalk import dingtalk_notifier

inspection_bp = Blueprint('inspection', __name__, url_prefix='/api')


@inspection_bp.route('/inspect', methods=['POST'])
@login_required
def inspect():
    start_time = datetime.datetime.now()
    start_ts = time.time()
    operator = session.get('username')
    inspection_type_req = request.json.get('type', 'full') if request.json else 'full'
    target = 'full' if inspection_type_req in ('full', None) else inspection_type_req

    try:
        inspection_type = inspection_type_req
        INSPECTION_ITEMS = get_config('inspectionItems')
        if inspection_type == 'slow_sql':
            deduplicate = request.json.get('deduplicate', INSPECTION_ITEMS.get('slow_sql_deduplicate', True))
        else:
            deduplicate = request.json.get('deduplicate', True)

        if inspection_type == 'full' or inspection_type is None:
            results = run_full_inspection(deduplicate)
        else:
            if inspection_type in get_inspection_functions():
                if inspection_type == 'slow_sql':
                    result = get_inspection_functions()[inspection_type](deduplicate)
                else:
                    result = get_inspection_functions()[inspection_type]()
                results = {inspection_type: result.to_dict()}
            else:
                return jsonify({'error': '无效的巡检类型'}), 400

        end_time = datetime.datetime.now()
        duration = f"{time.time() - start_ts:.3f}s"

        # 保存巡检日志到数据库（成功）
        record_inspection_log(
            inspection_type='system', trigger_source='manual',
            target=target, operator=operator,
            status=derive_status(results),
            start_time=start_time, end_time=end_time, duration=duration,
            summary=f"手动巡检: {target}",
            record_count=len(results) if isinstance(results, dict) else 0,
            result=results,
        )

        # 发送钉钉通知
        notification_type = 'user' if inspection_type != 'full' else 'scheduled'
        inspection_item_name = {
            'system_info': '系统信息', 'cpu': 'CPU', 'memory': '内存',
            'swap': '交换分区', 'disk': '磁盘', 'disk_io': '磁盘IO',
            'processes': '进程', 'slow_sql': '慢SQL', 'database': '数据库', 'network': '网络'
        }.get(inspection_type, inspection_type)
        dingtalk_notifier.send_inspection_report(results, notification_type, inspection_item_name)

        return jsonify(results)
    except Exception as e:
        import traceback
        traceback.print_exc()
        end_time = datetime.datetime.now()
        duration = f"{time.time() - start_ts:.3f}s"
        # 保存巡检日志到数据库（失败）
        record_inspection_log(
            inspection_type='system', trigger_source='manual',
            target=target, operator=operator,
            status='error',
            start_time=start_time, end_time=end_time, duration=duration,
            summary=f"手动巡检失败: {target}",
            error=str(e),
        )
        return jsonify({'error': str(e)}), 500


def save_inspection_log_to_db(results, inspection_type):
    """[已废弃] 旧的触发来源式日志保存，保留仅为向后兼容，内部转发到新日志接口。"""
    record_inspection_log(
        inspection_type='system', trigger_source=inspection_type,
        status=derive_status(results), result=results,
        summary=f"巡检: {inspection_type}",
    )


@inspection_bp.route('/inspect/sql', methods=['POST'])
@login_required
def inspect_sql():
    """数据稽查功能"""
    start_time = datetime.datetime.now()
    start_ts = time.time()
    operator = session.get('username')
    data = request.json
    database = data.get('database')
    sql = data.get('sql')
    target = database or ''

    try:
        if not database or not sql:
            return jsonify({'error': '数据库类型和SQL语句不能为空'}), 400

        DATABASE_CONFIG = get_config('databaseConfig')
        if database == 'mes':
            db_config = DATABASE_CONFIG.get('mes')
        elif database == 'hanging':
            db_config = DATABASE_CONFIG.get('hanging')
        else:
            return jsonify({'error': '不支持的数据库类型'}), 400

        if not db_config:
            return jsonify({'error': '数据库配置不存在'}), 400

        columns, rows = execute_sql(db_config['type'], db_config, sql)
        if columns is None:
            end_time = datetime.datetime.now()
            record_inspection_log(
                inspection_type='sql', trigger_source='manual',
                target=target, operator=operator, status='error',
                start_time=start_time, end_time=end_time,
                duration=f"{time.time() - start_ts:.3f}s",
                summary=f"SQL稽查失败: {target}",
                record_count=0,
                result={'database': database, 'sql': sql},
                error=rows,
            )
            return jsonify({'error': rows}), 500

        end_time = datetime.datetime.now()
        record_count = len(rows) if rows else 0
        record_inspection_log(
            inspection_type='sql', trigger_source='manual',
            target=target, operator=operator, status='success',
            start_time=start_time, end_time=end_time,
            duration=f"{time.time() - start_ts:.3f}s",
            summary=f"SQL稽查完成: {target}，{record_count} 条记录",
            record_count=record_count,
            result={'database': database, 'sql': sql, 'columns': columns, 'rows': rows},
        )

        return jsonify({'columns': columns, 'rows': rows})
    except Exception as e:
        import traceback
        traceback.print_exc()
        end_time = datetime.datetime.now()
        record_inspection_log(
            inspection_type='sql', trigger_source='manual',
            target=target, operator=operator, status='error',
            start_time=start_time, end_time=end_time,
            duration=f"{time.time() - start_ts:.3f}s",
            summary=f"SQL稽查失败: {target}",
            result={'database': database, 'sql': sql},
            error=str(e),
        )
        return jsonify({'error': str(e)}), 500


@inspection_bp.route('/inspect/sql/export', methods=['POST'])
@login_required
def export_sql_result():
    """导出数据稽查结果"""
    try:
        data = request.form
        database = data.get('database')
        sql = data.get('sql')
        inspect_name = data.get('inspect_name', 'sql_result')

        if not database or not sql:
            return jsonify({'error': '数据库类型和SQL语句不能为空'}), 400

        DATABASE_CONFIG = get_config('databaseConfig')
        if database == 'mes':
            db_config = DATABASE_CONFIG.get('mes')
        elif database == 'hanging':
            db_config = DATABASE_CONFIG.get('hanging')
        else:
            return jsonify({'error': '不支持的数据库类型'}), 400

        if not db_config:
            return jsonify({'error': '数据库配置不存在'}), 400

        columns, rows = execute_sql(db_config['type'], db_config, sql)
        if columns is None:
            return jsonify({'error': rows}), 500

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(columns)
        for row in rows:
            if isinstance(row, dict):
                writer.writerow([row.get(col) for col in columns])
            else:
                writer.writerow(row)
        output.seek(0)

        filename = f"{inspect_name}_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        return send_file(
            io.BytesIO(output.getvalue().encode('utf-8')),
            mimetype='text/csv', as_attachment=True, download_name=filename
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@inspection_bp.route('/inspect/mes_hanging', methods=['POST'])
@login_required
def inspect_mes_hanging():
    """MES报工明细与吊挂报工明细自动稽核"""
    start_time = datetime.datetime.now()
    start_ts = time.time()
    operator = session.get('username')
    data = request.json or {}
    start_date = data.get('start_date')
    end_date = data.get('end_date')
    target = f"{start_date}~{end_date}" if start_date and end_date else ''

    try:
        if not start_date or not end_date:
            return jsonify({'error': '开始日期和结束日期不能为空'}), 400

        try:
            datetime.datetime.strptime(start_date, '%Y-%m-%d')
            datetime.datetime.strptime(end_date, '%Y-%m-%d')
        except ValueError:
            return jsonify({'error': '无效的日期格式，应为YYYY-MM-DD'}), 400

        start_dt_obj = datetime.datetime.strptime(start_date, '%Y-%m-%d')
        end_dt_obj = datetime.datetime.strptime(end_date, '%Y-%m-%d')
        if start_dt_obj > end_dt_obj:
            return jsonify({'error': '开始日期不能晚于结束日期'}), 400

        start_datetime = f"{start_date} 00:00:00"
        end_datetime = f"{end_date} 23:59:59"

        schema = 'jack_mes'
        # 枚举日期范围覆盖的所有月份（跨月时最多2张表），构建 UNION ALL 子查询
        cache_months = get_cache_table_months(start_date, end_date)
        mes_union = build_cache_union_subquery(
            schema, cache_months, '"total"',
            f"WHERE reporting_work_date BETWEEN '{start_datetime}' AND '{end_datetime}' AND type = 1"
        )
        mes_tables_desc = ', '.join(
            f"{schema}.produce_mes_reporting_work_cache_{y}_{m}" for y, m in cache_months)

        DATABASE_CONFIG = get_config('databaseConfig')

        # MySQL（吊挂）数据库查询
        hanging_config = DATABASE_CONFIG.get('hanging')
        if not hanging_config:
            return jsonify({'error': '吊挂数据库配置不存在'}), 400

        sql1 = f"""
        SELECT COUNT(*), COALESCE(SUM(garments), 0)
        FROM dg_route_record
        WHERE complete_time >= '{start_datetime}' AND complete_time <= '{end_datetime}'
        """
        columns1, rows1 = execute_sql(hanging_config['type'], hanging_config, sql1)
        if columns1 is None:
            return jsonify({'error': f'吊挂数据库查询失败: {rows1}'}), 500

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

        # PostgreSQL（MES）数据库查询（跨月时对多张分表UNION后再聚合）
        mes_config = DATABASE_CONFIG.get('mes')
        if not mes_config:
            return jsonify({'error': 'MES数据库配置不存在'}), 400

        sql2 = f"""
        SELECT COUNT(*), COALESCE(SUM(total), 0)
        FROM {mes_union}
        """
        columns2, rows2 = execute_sql(mes_config['type'], mes_config, sql2)
        if columns2 is None:
            return jsonify({'error': f'MES数据库查询失败: {rows2}'}), 500

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

        is_consistent = count1 == count2 and sum1 == sum2
        result = {
            'start_date': start_date, 'end_date': end_date,
            'hanging': {'count': count1, 'sum': sum1},
            'mes': {'count': count2, 'sum': sum2, 'table': mes_tables_desc},
            'is_consistent': is_consistent,
            'diff': {'count': count1 - count2, 'sum': sum1 - sum2}
        }
        end_time = datetime.datetime.now()
        record_inspection_log(
            inspection_type='mes_hanging', trigger_source='manual',
            target=target, operator=operator,
            status='success' if is_consistent else 'warning',
            start_time=start_time, end_time=end_time,
            duration=f"{time.time() - start_ts:.3f}s",
            summary=f"MES吊挂稽核: {target} {'一致' if is_consistent else '不一致'}",
            record_count=1,
            result=result,
        )
        return jsonify(result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        end_time = datetime.datetime.now()
        record_inspection_log(
            inspection_type='mes_hanging', trigger_source='manual',
            target=target, operator=operator, status='error',
            start_time=start_time, end_time=end_time,
            duration=f"{time.time() - start_ts:.3f}s",
            summary=f"MES吊挂稽核失败: {target}",
            error=str(e),
        )
        return jsonify({'error': str(e)}), 500


@inspection_bp.route('/inspect/mes_hanging/export', methods=['POST'])
@login_required
def export_mes_hanging():
    """导出MES报工明细与吊挂报工明细稽核结果"""
    try:
        data = request.form
        start_date = data.get('start_date')
        end_date = data.get('end_date')
        inspect_name = data.get('inspect_name', 'mes_hanging_inspect')

        if not start_date or not end_date:
            return jsonify({'error': '开始日期和结束日期不能为空'}), 400

        start_datetime = f"{start_date} 00:00:00"
        end_datetime = f"{end_date} 23:59:59"
        schema = 'jack_mes'
        # 枚举日期范围覆盖的所有月份（跨月时最多2张表），构建 UNION ALL 子查询
        cache_months = get_cache_table_months(start_date, end_date)
        mes_union = build_cache_union_subquery(
            schema, cache_months, '"total"',
            f"WHERE reporting_work_date BETWEEN '{start_datetime}' AND '{end_datetime}' AND type = 1"
        )

        DATABASE_CONFIG = get_config('databaseConfig')

        hanging_config = DATABASE_CONFIG.get('hanging')
        if not hanging_config:
            return jsonify({'error': '吊挂数据库配置不存在'}), 400

        sql1 = f"""
        SELECT COUNT(*) AS hanging_count, COALESCE(SUM(garments), 0) AS hanging_sum
        FROM dg_route_record
        WHERE complete_time >= '{start_datetime}' AND complete_time <= '{end_datetime}'
        """
        columns1, rows1 = execute_sql(hanging_config['type'], hanging_config, sql1)
        if columns1 is None:
            return jsonify({'error': f'吊挂数据库查询失败: {rows1}'}), 500

        mes_config = DATABASE_CONFIG.get('mes')
        if not mes_config:
            return jsonify({'error': 'MES数据库配置不存在'}), 400

        sql2 = f"""
        SELECT COUNT(*) AS mes_count, COALESCE(SUM(total), 0) AS mes_sum
        FROM {mes_union}
        """
        columns2, rows2 = execute_sql(mes_config['type'], mes_config, sql2)
        if columns2 is None:
            return jsonify({'error': f'MES数据库查询失败: {rows2}'}), 500

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['数据来源', '数量', '合计'])
        row1 = rows1[0] if rows1 else {}
        row2 = rows2[0] if rows2 else {}
        if isinstance(row1, dict):
            writer.writerow(['吊挂(DG)', row1.get(columns1[0], 0), row1.get(columns1[1], 0)])
        else:
            writer.writerow(['吊挂(DG)', row1[0] if row1 else 0, row1[1] if len(row1) > 1 else 0])
        if isinstance(row2, dict):
            writer.writerow(['MES(报表)', row2.get(columns2[0], 0), row2.get(columns2[1], 0)])
        else:
            writer.writerow(['MES(报表)', row2[0] if row2 else 0, row2[1] if len(row2) > 1 else 0])
        output.seek(0)

        filename = f"{inspect_name}_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        return send_file(
            io.BytesIO(output.getvalue().encode('utf-8')),
            mimetype='text/csv', as_attachment=True, download_name=filename
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@inspection_bp.route('/clear_slow_sql_logs', methods=['POST'])
@login_required
def clear_slow_sql_logs():
    """清理慢SQL日志"""
    try:
        import subprocess
        import os

        find_container_cmd = "docker ps -a --format '{{.Names}}'"
        result = subprocess.run(find_container_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10)

        if result.returncode != 0:
            return jsonify({'success': False, 'message': f'查找容器失败: {result.stderr}'}), 500

        container_names = result.stdout.strip().split('\n')
        container_names = [name for name in container_names if name]

        target_containers = []
        for container_name in container_names:
            if any(keyword in container_name.lower() for keyword in ['postgresql', 'postgres', 'mysql', 'mariadb']):
                target_containers.append(container_name)
            else:
                inspect_cmd = f"docker inspect --format='{{{{.Config.Image}}}}' {container_name}"
                inspect_result = subprocess.run(inspect_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10)
                if inspect_result.returncode == 0:
                    image_name = inspect_result.stdout.strip().strip("'")
                    if any(keyword in image_name.lower() for keyword in ['postgresql', 'postgres', 'mysql', 'mariadb']):
                        target_containers.append(container_name)

        container_names = target_containers
        if not container_names:
            return jsonify({'success': False, 'message': '未找到数据库容器'}), 404

        results = []
        for container_name in container_names:
            truncate_cmd = f"sudo truncate -s 0 $(docker inspect --format='{{{{.LogPath}}}}' {container_name})"
            truncate_result = subprocess.run(truncate_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10)

            if truncate_result.returncode != 0:
                truncate_cmd = f"truncate -s 0 $(docker inspect --format='{{{{.LogPath}}}}' {container_name})"
                truncate_result = subprocess.run(truncate_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10)

            log_size_after = 0
            inspect_cmd = f"docker inspect --format='{{{{.LogPath}}}}' {container_name}"
            inspect_result = subprocess.run(inspect_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10)
            if inspect_result.returncode == 0:
                log_path = inspect_result.stdout.strip().strip("'")
                if os.path.exists(log_path):
                    log_size_after = os.path.getsize(log_path)

            results.append({
                'container': container_name,
                'success': truncate_result.returncode == 0,
                'message': f'日志大小: {log_size_after} 字节' + (f'（清理失败: {truncate_result.stderr.strip()}）' if truncate_result.returncode != 0 else '')
            })

        print(f"[{datetime.datetime.now()}] 清理慢SQL日志结果: {results!r}")
        return jsonify({'success': True, 'results': results})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500