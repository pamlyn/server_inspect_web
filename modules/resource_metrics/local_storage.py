"""本地 SQLite 资源指标存储，作为外部日志库不可用时的持久化后备。"""

import datetime
import os
import sqlite3


DATABASE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    'config', 'resource_metrics.sqlite3'
)
_COLUMNS = ('cpu_busy_percent', 'cpu_load_per_core', 'cpu_iowait_percent',
            'memory_used_percent', 'memory_available_percent',
            'memory_total_bytes', 'memory_available_bytes')


def _connect():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('''CREATE TABLE IF NOT EXISTS resource_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at TEXT NOT NULL,
        cpu_busy_percent REAL, cpu_load_per_core REAL, cpu_iowait_percent REAL,
        memory_used_percent REAL, memory_available_percent REAL,
        memory_total_bytes INTEGER, memory_available_bytes INTEGER,
        collector_version TEXT
    )''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_resource_metrics_time ON resource_metrics(collected_at)')
    return conn


def save_resource_metrics(metrics, collected_at=None):
    collected_at = collected_at or datetime.datetime.now()
    values = [collected_at.strftime('%Y-%m-%d %H:%M:%S')]
    values.extend(metrics.get(name) for name in _COLUMNS)
    values.append('1')
    conn = _connect()
    try:
        conn.execute(
            f"INSERT INTO resource_metrics (collected_at, {', '.join(_COLUMNS)}, collector_version) "
            f"VALUES ({', '.join('?' for _ in values)})", values
        )
        conn.commit()
    finally:
        conn.close()


def get_resource_history(start_time, max_records=50000, max_points=240):
    from modules.log_storage.helpers import _downsample_samples
    conn = _connect()
    try:
        rows = conn.execute(
            '''SELECT collected_at, cpu_busy_percent, memory_used_percent
               FROM resource_metrics WHERE collected_at >= ?
               ORDER BY collected_at ASC LIMIT ?''',
            (start_time.strftime('%Y-%m-%d %H:%M:%S'), max_records),
        ).fetchall()
        samples = [{'time': row['collected_at'], 'cpu': row['cpu_busy_percent'],
                    'memory': row['memory_used_percent']} for row in rows]
        return _downsample_samples(samples, max_points)
    finally:
        conn.close()


def prune_resource_metrics(retention_days, now=None):
    cutoff = (now or datetime.datetime.now()) - datetime.timedelta(days=max(1, int(retention_days)))
    conn = _connect()
    try:
        cursor = conn.execute('DELETE FROM resource_metrics WHERE collected_at < ?',
                              (cutoff.strftime('%Y-%m-%d %H:%M:%S'),))
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()
