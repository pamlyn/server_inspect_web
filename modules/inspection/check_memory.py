from modules.config_mgmt.helpers import get_config
from modules.inspection.helpers import run_command
from modules.inspection.models import InspectionResult


def _meminfo():
    values = {}
    try:
        with open('/proc/meminfo', encoding='utf-8') as file:
            for line in file:
                key, value = line.split(':', 1)
                values[key] = int(value.strip().split()[0]) * 1024
    except (OSError, ValueError, IndexError):
        return {}
    return values


def check_memory():
    """使用 MemAvailable 评估可用内存，避免把文件缓存误判为压力。"""
    result = InspectionResult()
    thresholds = get_config('thresholds', {}).get('memory', {})
    available_warning = float(thresholds.get('available_warning', 20))
    available_critical = float(thresholds.get('available_critical', 10))
    meminfo = _meminfo()
    total = meminfo.get('MemTotal', 0)
    available = meminfo.get('MemAvailable', 0)

    if not total or not available:
        stdout, _, _ = run_command('free -b 2>/dev/null')
        result.add_info(f'内存备用采样:\n{stdout.strip() or "不可用"}')
        result.add_warning('无法读取 MemAvailable，未执行内存压力阈值判断')
        result.set_end_time()
        return result

    used = total - available
    available_percent = available * 100 / total
    used_percent = used * 100 / total
    cache = meminfo.get('Cached', 0) + meminfo.get('Buffers', 0) + meminfo.get('SReclaimable', 0)
    gib = 1024 ** 3
    result.add_info(f'物理内存: 总计 {total / gib:.2f} GiB，可用 {available / gib:.2f} GiB ({available_percent:.1f}%)，已使用 {used / gib:.2f} GiB ({used_percent:.1f}%)')
    result.add_info(f'可回收缓存与缓冲区: {cache / gib:.2f} GiB；指标基于 Linux MemAvailable 计算')
    result.add_metric('memory_available_percent', round(available_percent, 2))
    result.add_metric('memory_used_percent', round(used_percent, 2))
    result.add_metric('memory_total_bytes', total)
    result.add_metric('memory_available_bytes', available)
    if available_percent <= available_critical:
        result.add_critical(f'可用内存 {available_percent:.1f}% <= {available_critical}%，内存压力严重')
    elif available_percent <= available_warning:
        result.add_warning(f'可用内存 {available_percent:.1f}% <= {available_warning}%，请观察内存增长趋势')
    else:
        result.add_normal(f'可用内存 {available_percent:.1f}%，正常')

    vmstat = {}
    try:
        with open('/proc/vmstat', encoding='utf-8') as file:
            for line in file:
                key, value = line.split()
                if key in {'pswpin', 'pswpout', 'pgmajfault'}:
                    vmstat[key] = int(value)
        result.add_info(f'累计换页: pswpin={vmstat.get("pswpin", 0)}, pswpout={vmstat.get("pswpout", 0)}, major_fault={vmstat.get("pgmajfault", 0)}')
    except (OSError, ValueError):
        result.add_info('无法读取 /proc/vmstat')

    top_mem, _, _ = run_command('ps -eo pid,ppid,comm,%mem,rss --sort=-%mem 2>/dev/null | head -6')
    if top_mem.strip():
        result.add_info('内存占用TOP5进程:\n' + top_mem.strip())
    result.set_end_time()
    return result
