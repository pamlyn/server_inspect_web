import datetime
import unittest
from unittest.mock import mock_open, patch

from modules.log_storage.helpers import _downsample_samples, aggregate_resource_samples, format_inspection_duration
from modules.resource_metrics.collector import collect_resource_metrics


class ResourceMetricsTests(unittest.TestCase):
    def test_downsampling_keeps_first_and_last_sample(self):
        samples = [{'time': str(index), 'cpu': index, 'memory': index} for index in range(10)]
        reduced = _downsample_samples(samples, 4)
        self.assertEqual(len(reduced), 4)
        self.assertEqual(reduced[0], samples[0])
        self.assertEqual(reduced[-1], samples[-1])

    def test_aggregate_resource_samples_averages_each_time_bucket(self):
        samples = [
            {'time': '2026-08-23 10:00:10', 'cpu': 10, 'memory': 40},
            {'time': '2026-08-23 10:00:50', 'cpu': 30, 'memory': 60},
            {'time': '2026-08-23 10:01:05', 'cpu': None, 'memory': 80},
        ]
        aggregated = aggregate_resource_samples(samples, 60)
        self.assertEqual(len(aggregated), 2)
        self.assertEqual(aggregated[0], {'time': '2026-08-23 10:00:50', 'cpu': 20.0, 'memory': 50.0})
        self.assertEqual(aggregated[1], {'time': '2026-08-23 10:01:05', 'cpu': None, 'memory': 80.0})

    def test_format_inspection_duration_uses_consistent_units(self):
        self.assertEqual(format_inspection_duration(0.004), '4ms')
        self.assertEqual(format_inspection_duration(1.2345), '1.234s')
        self.assertEqual(format_inspection_duration(62.3), '1m 02.3s')
        self.assertEqual(format_inspection_duration(3662.3), '1h 01m 02.3s')
        self.assertEqual(format_inspection_duration(-1), '0ms')


    @patch('modules.resource_metrics.collector._read_cpu_times', side_effect=[
        [10, 0, 10, 70, 10, 0, 0, 0], [20, 0, 20, 130, 20, 0, 0, 0]
    ])
    @patch('modules.resource_metrics.collector.os.getloadavg', return_value=(4.0, 2.0, 1.0))
    @patch('modules.resource_metrics.collector.os.cpu_count', return_value=4)
    def test_collect_resource_metrics_handles_linux_sources(self, *_):
        metrics = collect_resource_metrics(0.1)
        self.assertEqual(metrics['cpu_load_per_core'], 1.0)
        self.assertIn('cpu_busy_percent', metrics)

    @patch('modules.resource_metrics.collector.os.uname')
    @patch('modules.resource_metrics.collector.time.sleep')
    @patch('modules.resource_metrics.collector._read_meminfo')
    @patch('modules.resource_metrics.collector._read_cpu_times', side_effect=[None, None])
    def test_collect_resource_metrics_keeps_memory_when_cpu_unavailable(self, cpu_times, meminfo, sleep, uname):
        uname.return_value.sysname = 'Linux'
        meminfo.return_value = {'MemTotal': 1000, 'MemAvailable': 250}
        metrics = collect_resource_metrics()
        self.assertEqual(metrics['memory_used_percent'], 75.0)
        self.assertNotIn('cpu_busy_percent', metrics)


if __name__ == '__main__':
    unittest.main()
