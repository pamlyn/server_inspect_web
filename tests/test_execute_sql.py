import sys
import types
import unittest
from unittest.mock import patch

from modules.inspection.helpers import execute_sql


class FakeCursor:
    def __init__(self, description, rows=None, rowcount=0):
        self.description = description
        self._rows = rows or []
        self.rowcount = rowcount
        self.executed_sql = None
        self.closed = False

    def execute(self, sql):
        self.executed_sql = sql

    def fetchall(self):
        return self._rows

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False
        self.closed = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True

    def close(self):
        self.closed = True


class ExecuteSqlTests(unittest.TestCase):
    def _execute_with_mysql_connection(self, connection, sql):
        pymysql = types.SimpleNamespace(
            connect=lambda **kwargs: connection,
            cursors=types.SimpleNamespace(DictCursor=object),
        )
        psycopg2 = types.SimpleNamespace()
        with patch.dict(sys.modules, {'pymysql': pymysql, 'psycopg2': psycopg2}):
            return execute_sql('mysql', {
                'host': 'localhost', 'port': 3306, 'user': 'tester',
                'password': 'secret', 'database': 'test',
            }, sql)

    def test_update_returns_affected_rows_and_commits(self):
        cursor = FakeCursor(description=None, rowcount=1)
        connection = FakeConnection(cursor)

        columns, rows = self._execute_with_mysql_connection(
            connection,
            'UPDATE sample SET status = 1 WHERE batch_no = 202608200004',
        )

        self.assertEqual(columns, ['受影响行数'])
        self.assertEqual(rows, [[1]])
        self.assertTrue(connection.committed)
        self.assertTrue(cursor.closed)
        self.assertTrue(connection.closed)

    def test_select_keeps_query_result_contract(self):
        cursor = FakeCursor(description=[('batch_no',)], rows=[{'batch_no': 202608200004}])
        connection = FakeConnection(cursor)

        columns, rows = self._execute_with_mysql_connection(
            connection,
            'SELECT batch_no FROM sample',
        )

        self.assertEqual(columns, ['batch_no'])
        self.assertEqual(rows, [{'batch_no': '202608200004'}])
        self.assertFalse(connection.committed)


if __name__ == '__main__':
    unittest.main()
