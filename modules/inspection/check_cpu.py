import os
import time

from modules.config_mgmt.helpers import get_config
from modules.inspection.helpers import run_command
from modules.inspection.models import InspectionResult


def _read_cpu_times():
    try:
        fields = open('/proc/stat', encoding='utf-8').readline().split()[1:]
        values = [int(value) for value in fields]
        values += [0] * (8 - len(values))
        return values
    except (OSError, ValueError):
        return None


def _threshold(result, value, warning, critical, label, unit='%'):
    if value >= critical:
        result.add_critical(f'{label} {value:.1f}{unit} >= {critical}{unit}，需要立即处理')
    elif value >= warning:
        result.add_warning(f'{label} {value:.1f}{unit} >= {warning}{unit}，请持续观察')
    else:
        result.add_normal(f'{label} {value:.1f}{unit}，正常')


def check_cpu():
    """采集企业主机巡检常用的 CPU 使用率、负载和 IO 等待指标。"""
    result = InspectionResult()
    thresholds = get_config('thresholds', {}).get('cpu', {})
    warning = float(thresholds.get('warning', 80))
    critical = float(thresholds.get('critical', 90))
    load_warning = float(thresholds.get('load_per_core_warning', 1.0))
    load_critical = float(thresholds.get('load_per_core_critical', 1.5))
    iowait_warning = float(thresholds.get('iowait_warning', 10))
    iowait_critical = float(thresholds.get('iowait_critical', 25))

    cpu_count = os.cpu_count() or 1
    result.add_info(f'逻辑CPU核数: {cpu_count}')
    try:
        load_1, load_5, load_15 = os.getloadavg()
        load_per_core = load_1 / cpu_count
        result.add_info(f'系统负载(1/5/15分钟): {load_1:.2f} / {load_5:.2f} / {load_15:.2f}')
        result.add_metric('cpu_load_per_core', round(load_per_core, 3))
        _threshold(result, load_per_core, load_warning, load_critical, '1分钟负载/逻辑核', '')
    except OSError:
        result.add_info('当前系统不支持读取系统负载')

    before = _read_cpu_times()
    if before:
        time.sleep(0.5)
        after = _read_cpu_times()
        if after:
            deltas = [new - old for old, new in zip(before, after)]
            total = sum(deltas)
            if total > 0:
                idle = deltas[3] + deltas[4]
                busy = (total - idle) * 100 / total
                iowait = deltas[4] * 100 / total
                user = (deltas[0] + deltas[1]) * 100 / total
                system = deltas[2] * 100 / total
                steal = deltas[7] * 100 / total
                result.add_info(f'CPU采样: busy={busy:.1f}%, user={user:.1f}%, system={system:.1f}%, iowait={iowait:.1f}%, steal={steal:.1f}%')
                result.add_metric('cpu_busy_percent', round(busy, 2))
                result.add_metric('cpu_iowait_percent', round(iowait, 2))
                _threshold(result, busy, warning, critical, 'CPU忙碌率')
                _threshold(result, iowait, iowait_warning, iowait_critical, 'CPU IO等待')
            else:
                result.add_warning('CPU采样间隔内无有效计数变化')
    else:
        stdout, _, _ = run_command("top -bn1 2>/dev/null | grep -E 'Cpu|cpu' | head -1")
        result.add_info(f'CPU备用采样: {stdout.strip() or "不可用"}')
        result.add_warning('无法读取 /proc/stat，未执行CPU阈值判断')

    top_cpu, _, _ = run_command('ps -eo pid,ppid,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -6')
    if top_cpu.strip():
        result.add_info('CPU占用TOP5进程:\n' + top_cpu.strip())
    result.set_end_time()
    return result
