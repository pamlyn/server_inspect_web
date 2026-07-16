"""
日志存储模块 - 巡检日志数据库存储功能

设计：单表 inspection_logs + JSON 结果列。每一次巡检动作（系统巡检 / SQL稽查 /
MES吊挂稽核 / 自定义脚本执行，含成功与失败）都记一行，完整结果存入 result JSON 列，
兼容任意结果结构。
"""

import uuid
import json
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
