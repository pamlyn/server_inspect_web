import os
import time

from modules.config_mgmt.helpers import get_config
from modules.inspection.helpers import run_command
from modules.inspection.models import InspectionResult

PSEUDO_FILESYSTEMS = {
    'tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'proc', 'sysfs', 'cgroup',
    'cgroup2', 'devpts', 'mqueue', 'tracefs', 'debugfs', 'securityfs', 'nsfs',
}


def _local_mounts():
    mounts = []
    try:
        for line in open('/proc/mounts', encoding='utf-8'):
            source, mount, filesystem, options, *_ = line.split()
            if filesystem in PSEUDO_FILESYSTEMS or not os.path.isdir(mount):
                continue
            mounts.append((source, mount.replace('\\040', ' '), filesystem, options))
    except OSError:
        return []
    return mounts


def _alert(result, value, warning, critical, label, operator='>='):
    breached_critical = value >= critical if operator == '>=' else value <= critical
    breached_warning = value >= warning if operator == '>=' else value <= warning
    if breached_critical:
        result.add_critical(f'{label} {value:.1f}% {operator} {critical}%')
    elif breached_warning:
        result.add_warning(f'{label} {value:.1f}% {operator} {warning}%')
    else:
        result.add_normal(f'{label} {value:.1f}%，正常')


def check_disk():
    """检查真实文件系统的容量、可用空间与 inode，忽略伪文件系统。"""
    result = InspectionResult()
    thresholds = get_config('thresholds', {})
    disk_thresholds = thresholds.get('disk', {})
    free_thresholds = thresholds.get('disk_free', {})
    warning = float(disk_thresholds.get('warning', 80))
    critical = float(disk_thresholds.get('critical', 90))
    inode_warning = float(disk_thresholds.get('inode_warning', 80))
    inode_critical = float(disk_thresholds.get('inode_critical', 90))
    free_warning = float(free_thresholds.get('warning', 10))
    free_critical = float(free_thresholds.get('critical', 5))
    mounts = _local_mounts()

    if not mounts:
        result.add_warning('未找到可巡检的本地文件系统')
        result.set_end_time()
        return result

    seen_devices = set()
    for source, mount, filesystem, _ in mounts:
        try:
            stat = os.statvfs(mount)
        except OSError as error:
            result.add_warning(f'无法读取挂载点 {mount}: {error}')
            continue
        device_key = (stat.f_fsid, mount)
        if device_key in seen_devices:
            continue
        seen_devices.add(device_key)
        total = stat.f_blocks * stat.f_frsize
        available = stat.f_bavail * stat.f_frsize
        used_percent = (1 - stat.f_bavail / stat.f_blocks) * 100 if stat.f_blocks else 0
        available_gib = available / (1024 ** 3)
        result.add_info(f'文件系统 {mount} ({filesystem}, {source}): 总计 {total / 1024 ** 3:.2f} GiB，可用 {available_gib:.2f} GiB，使用率 {used_percent:.1f}%')
        _alert(result, used_percent, warning, critical, f'磁盘 {mount} 使用率')
        if available_gib <= free_critical:
            result.add_critical(f'磁盘 {mount} 可用空间 {available_gib:.2f} GiB <= {free_critical} GiB')
        elif available_gib <= free_warning:
            result.add_warning(f'磁盘 {mount} 可用空间 {available_gib:.2f} GiB <= {free_warning} GiB')
        else:
            result.add_normal(f'磁盘 {mount} 可用空间 {available_gib:.2f} GiB，正常')
        if stat.f_files:
            inode_used = (1 - stat.f_favail / stat.f_files) * 100
            _alert(result, inode_used, inode_warning, inode_critical, f'磁盘 {mount} inode使用率')

    result.set_end_time()
    return result


def _cpu_iowait_sample():
    try:
        before = [int(value) for value in open('/proc/stat', encoding='utf-8').readline().split()[1:]]
        time.sleep(0.5)
        after = [int(value) for value in open('/proc/stat', encoding='utf-8').readline().split()[1:]]
        total = sum(after) - sum(before)
        return ((after[4] - before[4]) * 100 / total) if total > 0 and len(after) > 4 else None
    except (OSError, ValueError):
        return None


def check_disk_io():
    """只读采集磁盘 IO 证据；不再自动安装任何系统软件。"""
    result = InspectionResult()
    thresholds = get_config('thresholds', {}).get('disk_io', {})
    warning = float(thresholds.get('warning', 10))
    critical = float(thresholds.get('critical', 25))
    iowait = _cpu_iowait_sample()
    if iowait is None:
        result.add_warning('无法读取 CPU IO等待，未执行磁盘IO阈值判断')
    elif iowait >= critical:
        result.add_critical(f'磁盘IO等待 {iowait:.1f}% >= {critical}%，存在IO阻塞风险')
    elif iowait >= warning:
        result.add_warning(f'磁盘IO等待 {iowait:.1f}% >= {warning}%，请关注设备队列与延迟')
    else:
        result.add_normal(f'磁盘IO等待 {iowait:.1f}%，正常')

    iostat, _, code = run_command('iostat -x 1 2 2>/dev/null')
    if code == 0 and iostat.strip():
        result.add_info('磁盘IO扩展统计(第二次采样):\n' + iostat.strip())
    else:
        try:
            lines = open('/proc/diskstats', encoding='utf-8').read().splitlines()
            result.add_info('未安装 iostat；/proc/diskstats 原始计数(前10项):\n' + '\n'.join(lines[:10]))
        except OSError:
            result.add_info('未安装 iostat，且无法读取 /proc/diskstats')
    result.set_end_time()
    return result
