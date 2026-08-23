import time

from modules.config_mgmt.helpers import get_config
from modules.inspection.models import InspectionResult


def _read_vmstat():
    values = {}
    try:
        with open('/proc/vmstat', encoding='utf-8') as file:
            for line in file:
                key, value = line.split()
                if key in {'pswpin', 'pswpout'}:
                    values[key] = int(value)
    except (OSError, ValueError):
        return {}
    return values


def check_swap():
    """检查交换分区容量与短窗口换页活动。"""
    result = InspectionResult()
    thresholds = get_config('thresholds', {}).get('swap', {})
    warning = float(thresholds.get('warning', 30))
    critical = float(thresholds.get('critical', 50))
    activity_warning = float(thresholds.get('activity_warning', 1))
    activity_critical = float(thresholds.get('activity_critical', 10))
    values = {}
    try:
        with open('/proc/meminfo', encoding='utf-8') as file:
            for line in file:
                key, value = line.split(':', 1)
                if key in {'SwapTotal', 'SwapFree'}:
                    values[key] = int(value.strip().split()[0]) * 1024
    except (OSError, ValueError, IndexError):
        result.add_warning('无法读取交换分区信息')
        result.set_end_time()
        return result

    total = values.get('SwapTotal', 0)
    free = values.get('SwapFree', 0)
    if total <= 0:
        result.add_info('未配置交换分区；当前不按异常处理')
        result.set_end_time()
        return result
    used_percent = (total - free) * 100 / total
    result.add_info(f'交换分区: 总计 {total / 1024 ** 3:.2f} GiB，可用 {free / 1024 ** 3:.2f} GiB，使用率 {used_percent:.1f}%')
    if used_percent >= critical:
        result.add_critical(f'交换分区使用率 {used_percent:.1f}% >= {critical}%')
    elif used_percent >= warning:
        result.add_warning(f'交换分区使用率 {used_percent:.1f}% >= {warning}%')
    else:
        result.add_normal(f'交换分区使用率 {used_percent:.1f}%，正常')

    before = _read_vmstat()
    time.sleep(0.5)
    after = _read_vmstat()
    if before and after:
        activity = (after.get('pswpin', 0) - before.get('pswpin', 0)) + (after.get('pswpout', 0) - before.get('pswpout', 0))
        result.add_info(f'0.5秒采样换页活动: {activity} 页')
        if activity >= activity_critical:
            result.add_critical(f'短窗口换页活动 {activity} 页 >= {activity_critical} 页')
        elif activity >= activity_warning:
            result.add_warning(f'短窗口换页活动 {activity} 页 >= {activity_warning} 页')
        else:
            result.add_normal('短窗口无明显换页活动')
    result.set_end_time()
    return result
