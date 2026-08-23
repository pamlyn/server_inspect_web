"""只读采集本机 CPU/内存指标，供持续历史趋势使用。"""

import os
import re
import subprocess
import time


def _read_cpu_times():
    try:
        with open('/proc/stat', encoding='utf-8') as file:
            values = [int(value) for value in file.readline().split()[1:]]
        return values + [0] * max(0, 8 - len(values))
    except (OSError, ValueError):
        return None


def _read_meminfo():
    values = {}
    try:
        with open('/proc/meminfo', encoding='utf-8') as file:
            for line in file:
                key, value = line.split(':', 1)
                values[key] = int(value.strip().split()[0]) * 1024
    except (OSError, ValueError, IndexError):
        return {}
    return values


def _run_readonly_command(command):
    try:
        return subprocess.run(command, shell=True, capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return ''


def _collect_macos_metrics(metrics):
    """macOS 开发/部署环境的只读回退采样。"""
    cpu_output = _run_readonly_command("top -l 2 -n 0 | grep '^CPU usage' | tail -1")
    cpu_match = re.search(r'([0-9.]+)%\s+idle', cpu_output)
    if cpu_match and 'cpu_busy_percent' not in metrics:
        metrics['cpu_busy_percent'] = round(100 - float(cpu_match.group(1)), 2)

    total_output = _run_readonly_command('sysctl -n hw.memsize').strip()
    vm_output = _run_readonly_command('vm_stat')
    page_match = re.search(r'page size of (\d+) bytes', vm_output)
    free_match = re.search(r'Pages free:\s+(\d+)', vm_output)
    inactive_match = re.search(r'Pages inactive:\s+(\d+)', vm_output)
    try:
        total = int(total_output)
        page_size = int(page_match.group(1))
        available = (int(free_match.group(1)) + int(inactive_match.group(1))) * page_size
        available = min(total, available)
    except (AttributeError, TypeError, ValueError):
        return
    available_percent = available * 100 / total
    if 'memory_used_percent' not in metrics:
        metrics['memory_available_percent'] = round(available_percent, 2)
        metrics['memory_used_percent'] = round(100 - available_percent, 2)
        metrics['memory_total_bytes'] = total
        metrics['memory_available_bytes'] = available


def collect_resource_metrics(sample_seconds=0.5):
    """返回一次本机资源快照；不执行巡检、告警或外部命令。"""
    metrics = {}
    cpu_count = os.cpu_count() or 1
    try:
        load_1, _, _ = os.getloadavg()
        metrics['cpu_load_per_core'] = round(load_1 / cpu_count, 3)
    except OSError:
        pass

    before = _read_cpu_times()
    if before:
        time.sleep(max(0.1, float(sample_seconds)))
        after = _read_cpu_times()
        if after:
            deltas = [new - old for old, new in zip(before, after)]
            total = sum(deltas)
            if total > 0:
                idle = deltas[3] + deltas[4]
                metrics['cpu_busy_percent'] = round((total - idle) * 100 / total, 2)
                metrics['cpu_iowait_percent'] = round(deltas[4] * 100 / total, 2)

    meminfo = _read_meminfo()
    total = meminfo.get('MemTotal', 0)
    available = meminfo.get('MemAvailable', 0)
    if total and available:
        available_percent = available * 100 / total
        metrics['memory_available_percent'] = round(available_percent, 2)
        metrics['memory_used_percent'] = round(100 - available_percent, 2)
        metrics['memory_total_bytes'] = total
        metrics['memory_available_bytes'] = available
    if os.uname().sysname == 'Darwin' and ('cpu_busy_percent' not in metrics or 'memory_used_percent' not in metrics):
        _collect_macos_metrics(metrics)
    return metrics
