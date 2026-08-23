"""
日志存储模块 - 巡检日志数据库存储功能

设计：单表 inspection_logs + JSON 结果列。每一次巡检动作（系统巡检 / SQL稽查 /
MES吊挂稽核 / 自定义脚本执行，含成功与失败）都记一行，完整结果存入 result JSON 列，
兼容任意结果结构。
"""

import uuid
import json
import re
import datetime


# 新表所需列定义（顺序无关，迁移时按需 ADD COLUMN）
# (列名, postgres 类型, mysql 类型)
_COLUMNS = [
    ('id',              'SERIAL PRIMARY KEY',                         'INT AUTO_INCREMENT PRIMARY KEY'),
    ('inspection_id',   'VARCHAR(36)',                                'VARCHAR(36)'),
    ('inspection_type', 'VARCHAR(50)',                                'VARCHAR(50)'),
    ('trigger_source',  'VARCHAR(20)',                                'VARCHAR(20)'),
    ('target',          'VARCHAR(200)',                               'VARCHAR(200)'),
    ('operator',        'VARCHAR(100)',                               'VARCHAR(100)'),
    ('status',          'VARCHAR(20)',                                'VARCHAR(20)'),
    ('record_count',    'INT',                                        'INT'),
    ('start_time',      'TIMESTAMP',                                  'DATETIME'),
    ('end_time',        'TIMESTAMP',                                  'DATETIME'),
    ('duration',        'VARCHAR(50)',                                'VARCHAR(50)'),
    ('summary',         'TEXT',                                        'TEXT'),
    ('result',          'JSONB',                                      'TEXT'),
    ('error',           'TEXT',                                        'TEXT'),
    ('created_at',      'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',        'DATETIME DEFAULT CURRENT_TIMESTAMP'),
]

# 新表非主键列（建表/迁移用），id 为主键单独处理
_NON_PK_COLUMNS = [c for c in _COLUMNS if c[0] != 'id']

_RESOURCE_METRIC_COLUMNS = (
    'cpu_busy_percent', 'cpu_load_per_core', 'cpu_iowait_percent',
    'memory_used_percent', 'memory_available_percent',
    'memory_total_bytes', 'memory_available_bytes',
)


def _connect(db_type, db_config):
    """建立数据库连接，返回 (conn, cursor)。db_config 需包含 host/port/user/password/database。"""
    import psycopg2
    import pymysql

    if db_type == 'postgresql':
        conn = psycopg2.connect(
            host=db_config['host'], port=db_config['port'],
            user=db_config['user'], password=db_config['password'],
            database=db_config['database'],
            options='-c password_encryption=md5'
        )
    elif db_type == 'mysql':
        conn = pymysql.connect(
            host=db_config['host'], port=db_config['port'],
            user=db_config['user'], password=db_config['password'],
            database=db_config['database'],
            cursorclass=pymysql.cursors.DictCursor
        )
    else:
        raise ValueError("不支持的数据库类型")
    return conn, conn.cursor()


def ensure_table_exists(db_type, db_config):
    """确保日志表存在；若旧表结构不含新列，自动幂等迁移补列。"""
    conn = None
    cursor = None
    try:
        conn, cursor = _connect(db_type, db_config)

        # 列定义（不含 id 主键）
        if db_type == 'postgresql':
            col_defs = []
            for name, pg_type, _ in _NON_PK_COLUMNS:
                col_defs.append(f'"{name}" {pg_type}')
            create_sql = f"""
                CREATE TABLE IF NOT EXISTS inspection_logs (
                    id SERIAL PRIMARY KEY,
                    {', '.join(col_defs)}
                );
            """
        else:
            col_defs = []
            for name, _, mysql_type in _NON_PK_COLUMNS:
                col_defs.append(f'`{name}` {mysql_type}')
            create_sql = f"""
                CREATE TABLE IF NOT EXISTS inspection_logs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    {', '.join(col_defs)}
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            """
        cursor.execute(create_sql)

        # 幂等迁移：对已存在的旧表补齐新列
        existing_cols = _get_existing_columns(cursor, db_type, 'inspection_logs')
        for name, pg_type, mysql_type in _NON_PK_COLUMNS:
            if name not in existing_cols:
                col_type = pg_type if db_type == 'postgresql' else mysql_type
                quoted = f'"{name}"' if db_type == 'postgresql' else f'`{name}`'
                try:
                    cursor.execute(f'ALTER TABLE inspection_logs ADD COLUMN {quoted} {col_type}')
                except Exception as e:
                    # ADD COLUMN IF NOT EXISTS 兼容兜底：忽略"列已存在"类错误
                    print(f"[{datetime.datetime.now()}] 迁移列 {name} 跳过: {e}")

        # 索引
        if db_type == 'postgresql':
            for idx_sql in (
                "CREATE INDEX IF NOT EXISTS idx_inspection_logs_id ON inspection_logs(inspection_id)",
                "CREATE INDEX IF NOT EXISTS idx_inspection_logs_type ON inspection_logs(inspection_type)",
                "CREATE INDEX IF NOT EXISTS idx_inspection_logs_source ON inspection_logs(trigger_source)",
                "CREATE INDEX IF NOT EXISTS idx_inspection_logs_time ON inspection_logs(start_time)",
                "CREATE INDEX IF NOT EXISTS idx_inspection_logs_operator ON inspection_logs(operator)",
            ):
                cursor.execute(idx_sql)
        else:
            # MySQL 索引名重复会报错，逐一 try
            for idx_name, col in (
                ('idx_inspection_logs_type', 'inspection_type'),
                ('idx_inspection_logs_source', 'trigger_source'),
                ('idx_inspection_logs_time', 'start_time'),
                ('idx_inspection_logs_operator', 'operator'),
            ):
                try:
                    cursor.execute(f'CREATE INDEX {idx_name} ON inspection_logs({col})')
                except Exception as e:
                    print(f"[{datetime.datetime.now()}] 创建索引 {idx_name} 跳过: {e}")

        conn.commit()
        return True, "表创建/迁移成功"
    except Exception as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        return False, str(e)
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def _get_existing_columns(cursor, db_type, table_name):
    """查询表已存在的列名集合（用于迁移判断）。"""
    cols = set()
    try:
        if db_type == 'postgresql':
            cursor.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = %s
            """, (table_name,))
        else:
            cursor.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = %s
            """, (table_name,))
        for row in cursor.fetchall():
            # PG 返回元组，MySQL(DictCursor) 返回 dict
            if isinstance(row, dict):
                cols.add(row.get('column_name') or row.get('COLUMN_NAME'))
            else:
                cols.add(row[0])
    except Exception as e:
        print(f"[{datetime.datetime.now()}] 查询列信息失败: {e}")
    return cols


def ensure_resource_metrics_table(db_type, db_config):
    """确保连续资源指标表存在，并建立时间索引。"""
    conn = cursor = None
    try:
        conn, cursor = _connect(db_type, db_config)
        if db_type == 'postgresql':
            cursor.execute('''CREATE TABLE IF NOT EXISTS resource_metrics (
                id SERIAL PRIMARY KEY, collected_at TIMESTAMP NOT NULL,
                cpu_busy_percent DOUBLE PRECISION, cpu_load_per_core DOUBLE PRECISION,
                cpu_iowait_percent DOUBLE PRECISION, memory_used_percent DOUBLE PRECISION,
                memory_available_percent DOUBLE PRECISION, memory_total_bytes BIGINT,
                memory_available_bytes BIGINT, collector_version VARCHAR(30)
            )''')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_resource_metrics_time ON resource_metrics(collected_at)')
        else:
            cursor.execute('''CREATE TABLE IF NOT EXISTS resource_metrics (
                id INT AUTO_INCREMENT PRIMARY KEY, collected_at DATETIME NOT NULL,
                cpu_busy_percent DOUBLE, cpu_load_per_core DOUBLE, cpu_iowait_percent DOUBLE,
                memory_used_percent DOUBLE, memory_available_percent DOUBLE,
                memory_total_bytes BIGINT, memory_available_bytes BIGINT,
                collector_version VARCHAR(30), INDEX idx_resource_metrics_time (collected_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4''')
        conn.commit()
        return True, '资源指标表已就绪'
    except Exception as error:
        if conn:
            conn.rollback()
        return False, str(error)
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def save_resource_metrics(db_type, db_config, metrics, collected_at=None):
    """保存一次连续资源采样；缺失指标以 NULL 持久化。"""
    conn = cursor = None
    try:
        conn, cursor = _connect(db_type, db_config)
        collected_at = collected_at or datetime.datetime.now()
        columns = ('collected_at',) + _RESOURCE_METRIC_COLUMNS + ('collector_version',)
        placeholders = ', '.join(['%s'] * len(columns))
        cursor.execute(
            f"INSERT INTO resource_metrics ({', '.join(columns)}) VALUES ({placeholders})",
            [collected_at] + [metrics.get(name) for name in _RESOURCE_METRIC_COLUMNS] + ['1'],
        )
        conn.commit()
        return True, '资源指标保存成功'
    except Exception as error:
        if conn:
            conn.rollback()
        return False, str(error)
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def prune_resource_metrics(db_type, db_config, retention_days, now=None):
    """按保留天数清理过期连续采样。"""
    conn = cursor = None
    try:
        conn, cursor = _connect(db_type, db_config)
        cutoff = (now or datetime.datetime.now()) - datetime.timedelta(days=max(1, int(retention_days)))
        cursor.execute('DELETE FROM resource_metrics WHERE collected_at < %s', (cutoff,))
        deleted = cursor.rowcount
        conn.commit()
        return True, deleted
    except Exception as error:
        if conn:
            conn.rollback()
        return False, str(error)
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def save_inspection_log(db_type, db_config, *, inspection_type, trigger_source,
                        target='', operator=None, status='success',
                        start_time=None, end_time=None, duration=None,
                        summary='', record_count=0, result=None, error=None):
    """
    保存一条巡检日志。每次巡检动作（含失败）记一行。

    :param inspection_type: 巡检类别 system/sql/mes_hanging/custom_script
    :param trigger_source:  触发来源 manual/scheduled/daily/real_time
    :param target:          具体对象（cpu/full/脚本名/库名 等）
    :param operator:        操作人（手动为登录用户，自动为 None）
    :param status:          success/warning/critical/error
    :param start_time/end_time/duration: 时间信息
    :param summary:         一句话摘要
    :param record_count:    结果记录数/行数
    :param result:          完整结果（任意结构，存入 JSON 列）
    :param error:           失败原因（status=error 时）
    :return: (success: bool, message: str)
    """
    conn = None
    cursor = None
    try:
        conn, cursor = _connect(db_type, db_config)

        now = datetime.datetime.now()
        if start_time is None:
            start_time = now
        if end_time is None:
            end_time = now
        if isinstance(start_time, str):
            start_time = datetime.datetime.strptime(start_time, '%Y-%m-%d %H:%M:%S')
        if isinstance(end_time, str):
            end_time = datetime.datetime.strptime(end_time, '%Y-%m-%d %H:%M:%S')
        if duration is None and start_time and end_time:
            duration = str(end_time - start_time)

        inspection_id = str(uuid.uuid4())

        result_json = json.dumps(result, ensure_ascii=False, default=str) if result is not None else None

        if db_type == 'postgresql':
            # result 用 JSONB；传入字符串 psycopg2 会按 JSONB 接收
            insert_sql = """
                INSERT INTO inspection_logs
                    (inspection_id, inspection_type, trigger_source, target, operator, status,
                     record_count, start_time, end_time, duration, summary, result, error)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            """
        else:
            insert_sql = """
                INSERT INTO inspection_logs
                    (inspection_id, inspection_type, trigger_source, target, operator, status,
                     record_count, start_time, end_time, duration, summary, result, error)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """

        cursor.execute(insert_sql, (
            inspection_id,
            inspection_type,
            trigger_source,
            target,
            operator,
            status,
            record_count,
            start_time,
            end_time,
            duration,
            summary,
            result_json,
            error,
        ))
        conn.commit()

        return True, f"日志保存成功，inspection_id: {inspection_id}"
    except Exception as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        return False, str(e)
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def _get_log_db_config():
    """读取日志数据库配置，未启用返回 None。"""
    from modules.config_mgmt.helpers import get_config
    log_db = get_config('logDatabase')
    if not log_db or not log_db.get('enabled', False):
        return None
    db_type = log_db.get('type')
    db_config = {
        'host': log_db.get('host'),
        'port': log_db.get('port'),
        'user': log_db.get('user'),
        'password': log_db.get('password'),
        'database': log_db.get('database'),
    }
    return db_type, db_config


def record_inspection_log(*, inspection_type, trigger_source, target='', operator=None,
                          status='success', start_time=None, end_time=None, duration=None,
                          summary='', record_count=0, result=None, error=None):
    """
    统一巡检日志入口（供各路由调用）。日志库未启用时静默跳过。
    失败不抛异常，仅打印，避免影响巡检主流程。
    """
    try:
        cfg = _get_log_db_config()
        if cfg is None:
            return
        db_type, db_config = cfg
        success, message = save_inspection_log(
            db_type, db_config,
            inspection_type=inspection_type, trigger_source=trigger_source,
            target=target, operator=operator, status=status,
            start_time=start_time, end_time=end_time, duration=duration,
            summary=summary, record_count=record_count, result=result, error=error,
        )
        if success:
            print(f"[{datetime.datetime.now()}] 巡检日志保存成功: {message}")
        else:
            print(f"[{datetime.datetime.now()}] 巡检日志保存失败: {message}")
    except Exception as e:
        print(f"[{datetime.datetime.now()}] 保存巡检日志出错: {e}")
        import traceback
        traceback.print_exc()


def derive_status(results):
    """从系统巡检结果 dict 推导整体状态：critical/warning/success。"""
    has_critical = False
    has_warning = False
    if isinstance(results, dict):
        for result in results.values():
            if not isinstance(result, dict):
                continue
            if result.get('criticals'):
                has_critical = True
            if result.get('warnings'):
                has_warning = True
    if has_critical:
        return 'critical'
    if has_warning:
        return 'warning'
    return 'success'


# ===================== 日志查询/删除接口 =====================

# 列表查询所需字段（不含 result，列表轻量化）
_LIST_COLUMNS = [
    'id', 'inspection_id', 'inspection_type', 'trigger_source', 'target',
    'operator', 'status', 'record_count', 'start_time', 'end_time',
    'duration', 'summary', 'created_at',
]


def _connect_dict(db_type, db_config):
    """建立返回 dict 行的连接：PG 用 RealDictCursor，MySQL 用 DictCursor。"""
    import psycopg2
    import psycopg2.extras
    import pymysql

    if db_type == 'postgresql':
        conn = psycopg2.connect(
            host=db_config['host'], port=db_config['port'],
            user=db_config['user'], password=db_config['password'],
            database=db_config['database'],
            options='-c password_encryption=md5'
        )
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    elif db_type == 'mysql':
        conn = pymysql.connect(
            host=db_config['host'], port=db_config['port'],
            user=db_config['user'], password=db_config['password'],
            database=db_config['database'],
            cursorclass=pymysql.cursors.DictCursor
        )
        cursor = conn.cursor()
    else:
        raise ValueError("不支持的数据库类型")
    return conn, cursor


def _row_to_plain_dict(row):
    """把 PG RealDictRow / MySQL dict 转成普通 dict，并确保可 JSON 序列化。"""
    if row is None:
        return None
    d = dict(row) if not isinstance(row, dict) else dict(row)
    return d


def query_inspection_logs(db_type, db_config, filters=None, page=1, page_size=20):
    """分页查询巡检日志列表。

    :param filters: dict, 支持字段:
        inspection_type, trigger_source, status, operator, target(模糊),
        keyword(summary/target 模糊), start_time, end_time
    :return: (logs: list[dict], total: int)
    """
    filters = filters or {}
    conn = None
    cursor = None
    try:
        conn, cursor = _connect_dict(db_type, db_config)

        where_parts = []
        params = []

        def _like(v):
            return f'%{v}%'

        for field in ('inspection_type', 'trigger_source', 'status', 'operator'):
            val = filters.get(field)
            if val:
                where_parts.append(f'{field} = %s')
                params.append(val)

        if filters.get('target'):
            where_parts.append('target LIKE %s')
            params.append(_like(filters['target']))

        if filters.get('keyword'):
            where_parts.append('(summary LIKE %s OR target LIKE %s)')
            params.extend([_like(filters['keyword']), _like(filters['keyword'])])

        if filters.get('start_time'):
            where_parts.append('start_time >= %s')
            params.append(filters['start_time'])
        if filters.get('end_time'):
            where_parts.append('start_time <= %s')
            params.append(filters['end_time'])

        where_clause = (' WHERE ' + ' AND '.join(where_parts)) if where_parts else ''

        # 计算总数
        cursor.execute(f'SELECT COUNT(*) AS cnt FROM inspection_logs{where_clause}', params)
        count_row = cursor.fetchone()
        total = 0
        if count_row is not None:
            # PG RealDictRow 支持 .get；MySQL dict 也支持；tuple 走索引
            if hasattr(count_row, 'get'):
                total = count_row.get('cnt') or count_row.get(0) or 0
            else:
                total = count_row[0]
        total = int(total) if total is not None else 0

        # 分页查询列表（不含 result，避免列表过大）
        offset = max(0, (page - 1) * page_size)
        col_list = ', '.join(_LIST_COLUMNS)
        order_field = 'created_at' if db_type == 'mysql' else 'created_at'
        sql = (
            f'SELECT {col_list} FROM inspection_logs{where_clause} '
            f'ORDER BY {order_field} DESC LIMIT %s OFFSET %s'
        )
        cursor.execute(sql, params + [page_size, offset])
        rows = cursor.fetchall()

        logs = []
        for row in rows:
            logs.append(_row_to_plain_dict(row))
        return logs, total
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def export_inspection_logs(db_type, db_config, filters=None, max_records=5000):
    """查询全部匹配日志用于导出，并限制最大记录数保护日志数据库。"""
    logs, total = query_inspection_logs(db_type, db_config, filters=filters, page=1, page_size=200)
    if total > max_records:
        raise ValueError(f'匹配日志超过 {max_records} 条，请缩小筛选范围后再导出')

    all_logs = list(logs)
    for page in range(2, (total + 199) // 200 + 1):
        batch, _ = query_inspection_logs(db_type, db_config, filters=filters, page=page, page_size=200)
        all_logs.extend(batch)
    return all_logs


def _downsample_samples(samples, max_points):
    """按时间均匀抽样，同时保留首尾点。"""
    if len(samples) <= max_points:
        return samples
    if max_points < 3:
        return [samples[0], samples[-1]]
    interior = len(samples) - 2
    step = interior / (max_points - 2)
    indexes = [0] + [1 + min(int(index * step), interior - 1) for index in range(max_points - 2)] + [len(samples) - 1]
    return [samples[index] for index in indexes]


def get_continuous_resource_history(db_type, db_config, start_time, max_records=50000, max_points=240):
    """查询连续采集的资源指标，返回按时间升序且受限的可视化样本。"""
    conn = cursor = None
    try:
        conn, cursor = _connect_dict(db_type, db_config)
        cursor.execute(
            '''SELECT collected_at, cpu_busy_percent, memory_used_percent
               FROM resource_metrics WHERE collected_at >= %s
               ORDER BY collected_at ASC LIMIT %s''',
            (start_time, max_records),
        )
        samples = []
        for row in cursor.fetchall():
            row = _row_to_plain_dict(row)
            timestamp = row.get('collected_at')
            if isinstance(timestamp, datetime.datetime):
                timestamp = timestamp.strftime('%Y-%m-%d %H:%M:%S')
            samples.append({'time': str(timestamp), 'cpu': row.get('cpu_busy_percent'), 'memory': row.get('memory_used_percent')})
        return _downsample_samples(samples, max_points)
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def get_resource_history(db_type, db_config, start_time, max_records=2000, max_points=160):
    """从旧系统巡检日志提取 CPU 与内存利用率历史样本。"""
    conn = cursor = None
    try:
        conn, cursor = _connect_dict(db_type, db_config)
        cursor.execute(
            '''SELECT start_time, result FROM inspection_logs
               WHERE inspection_type = %s AND start_time >= %s AND result IS NOT NULL
               ORDER BY start_time ASC LIMIT %s''',
            ('system', start_time, max_records),
        )
        samples = []
        for row in cursor.fetchall():
            row = _row_to_plain_dict(row)
            result = row.get('result')
            if isinstance(result, str):
                try:
                    result = json.loads(result)
                except (TypeError, ValueError):
                    continue
            if not isinstance(result, dict):
                continue
            cpu = _extract_metric(result.get('cpu'), 'cpu_busy_percent', r'CPU(?:整体)?使用率[：:]\s*([0-9.]+)%')
            memory_used = _extract_metric(result.get('memory'), 'memory_used_percent', r'内存使用率[：:]\s*([0-9.]+)%')
            if memory_used is None:
                memory_available = _extract_metric(result.get('memory'), 'memory_available_percent', r'可用内存[：:]\s*([0-9.]+)%')
                memory_used = 100 - memory_available if memory_available is not None else None
            if cpu is None and memory_used is None:
                continue
            timestamp = row.get('start_time')
            if isinstance(timestamp, datetime.datetime):
                timestamp = timestamp.strftime('%Y-%m-%d %H:%M:%S')
            samples.append({'time': str(timestamp), 'cpu': cpu, 'memory': memory_used})
        return _downsample_samples(samples, max_points)
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def _extract_metric(section, metric_name, pattern):
    if not isinstance(section, dict):
        return None
    metrics = section.get('metrics') or {}
    try:
        if metrics.get(metric_name) is not None:
            return round(float(metrics[metric_name]), 2)
    except (TypeError, ValueError):
        pass
    for message in (section.get('info') or []) + (section.get('warnings') or []) + (section.get('criticals') or []) + (section.get('normals') or []):
        match = re.search(pattern, str(message))
        if match:
            try:
                return round(float(match.group(1)), 2)
            except ValueError:
                continue
    return None


def get_inspection_log_detail(db_type, db_config, log_id):
    """查询单条日志详情（含 result、error）。"""
    conn = cursor = None
    try:
        conn, cursor = _connect_dict(db_type, db_config)
        cursor.execute('SELECT * FROM inspection_logs WHERE id = %s', (log_id,))
        return _row_to_plain_dict(cursor.fetchone())
    finally:
        if cursor: cursor.close()
        if conn: conn.close()


def delete_inspection_logs(db_type, db_config, before_date=None, keep_days=None):
    """删除日志：按 before_date（早于该日期）或 keep_days（保留最近 N 天）。

    :return: 删除行数
    """
    conn = None
    cursor = None
    try:
        conn, cursor = _connect_dict(db_type, db_config)
        params = []
        if before_date:
            where = 'WHERE created_at < %s'
            params.append(before_date)
        elif keep_days:
            import datetime as _dt
            threshold = _dt.datetime.now() - _dt.timedelta(days=int(keep_days))
            where = 'WHERE created_at < %s'
            params.append(threshold)
        else:
            where = ''
        sql = f'DELETE FROM inspection_logs {where}'
        cursor.execute(sql, params)
        deleted = cursor.rowcount
        conn.commit()
        return deleted
    except Exception:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        raise
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()
