import unittest
from unittest.mock import mock_open, patch

from modules.inspection.check_swap import check_swap


class SwapActivityTests(unittest.TestCase):
    @patch('modules.inspection.check_swap.time.sleep')
    @patch('modules.inspection.check_swap._read_vmstat')
    @patch('modules.inspection.check_swap.get_config')
    @patch('builtins.open', new_callable=mock_open, read_data='SwapTotal:       1048576 kB\nSwapFree:        1048576 kB\n')
    def test_activity_alert_is_disabled_by_default(self, _, get_config, read_vmstat, sleep):
        get_config.return_value = {'swap': {'warning': 30, 'critical': 50}}

        result = check_swap()

        self.assertIn('短窗口换页速率告警未启用', result.info)
        read_vmstat.assert_not_called()
        sleep.assert_not_called()
        self.assertFalse(result.warnings)
        self.assertFalse(result.criticals)

    @patch('modules.inspection.check_swap.time.perf_counter', side_effect=[100.0, 100.5])
    @patch('modules.inspection.check_swap.time.sleep')
    @patch('modules.inspection.check_swap._read_vmstat', side_effect=[
        {'pswpin': 10, 'pswpout': 20}, {'pswpin': 13, 'pswpout': 22}
    ])
    @patch('modules.inspection.check_swap.get_config')
    @patch('builtins.open', new_callable=mock_open, read_data='SwapTotal:       1048576 kB\nSwapFree:        1048576 kB\n')
    def test_activity_uses_pages_per_second_threshold(self, _, get_config, read_vmstat, sleep, perf_counter):
        get_config.return_value = {
            'swap': {
                'warning': 30,
                'critical': 50,
                'activity_enabled': True,
                'activity_warning': 8,
                'activity_critical': 20,
            }
        }

        result = check_swap()

        self.assertIn('短窗口换页速率 10.0 页/秒 >= 8.0 页/秒', result.warnings)
        self.assertFalse(result.criticals)
        sleep.assert_called_once_with(0.5)
        self.assertEqual(read_vmstat.call_count, 2)
        self.assertEqual(perf_counter.call_count, 2)


if __name__ == '__main__':
    unittest.main()
