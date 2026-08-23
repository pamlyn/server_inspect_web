import datetime
import unittest
from unittest.mock import mock_open, patch

from modules.log_storage.helpers import _downsample_samples
from modules.resource_metrics.collector import collect_resource_metrics


class ResourceMetricsTests(unittest.TestCase):
    def test_downsampling_keeps_first_and_last_sample(self):
        samples = [{'time': str(index), 'cpu': index, 'memory': index} for index in range(10)]
        reduced = _downsample_samples(samples, 4)
        self.assertEqual(len(reduced), 4)
        self.assertEqual(reduced[0], samples[0])
        self.assertEqual(reduced[-1], samples[-1])

    @patch('modules.resource_metrics.collector.time.sleep')
    @patch('modules.resource_metrics.collector._read_meminfo', return_value={})
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
