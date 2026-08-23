import unittest
from unittest.mock import patch

from app import app


class DashboardAccessTests(unittest.TestCase):
    def test_dashboard_permission_can_load_dashboard_data_without_logs_permission(self):
        client = app.test_client()
        with client.session_transaction() as session:
            session['username'] = 'dashboard-user'

        with patch('app.get_user_permissions', return_value={'dashboard'}), \
             patch('modules.auth.helpers.get_user_permissions', return_value={'dashboard'}), \
             patch('modules.log_storage.routes.get_config', return_value={'interval_seconds': 60}), \
             patch('modules.log_storage.routes._get_log_db_config', return_value=None), \
             patch('modules.resource_metrics.local_storage.get_resource_history', return_value=[]):
            response = client.get('/api/logs/dashboard')

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['success'])
        self.assertEqual(response.json['logs'], {'available': False, 'recent': [], 'summary': None})


if __name__ == '__main__':
    unittest.main()
