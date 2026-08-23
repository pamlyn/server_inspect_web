from modules.inspection.helpers import run_command
from modules.inspection.models import InspectionResult


def check_processes():
    """检查进程、僵尸进程、文件描述符和容器运行状态。"""
    result = InspectionResult()
    top_cpu, _, _ = run_command('ps -eo pid,ppid,stat,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -11')
    top_mem, _, _ = run_command('ps -eo pid,ppid,stat,comm,%cpu,%mem --sort=-%mem 2>/dev/null | head -11')
    if top_cpu.strip(): result.add_info('CPU占用TOP10进程:\n' + top_cpu.strip())
    if top_mem.strip(): result.add_info('内存占用TOP10进程:\n' + top_mem.strip())

    zombies, _, _ = run_command("ps -eo stat= 2>/dev/null | awk '$1 ~ /^Z/ {count++} END {print count+0}'")
    zombie_count = int(zombies.strip() or '0') if zombies.strip().isdigit() else 0
    if zombie_count:
        result.add_warning(f'发现 {zombie_count} 个僵尸进程')
    else:
        result.add_normal('未发现僵尸进程')

    file_max, _, _ = run_command('cat /proc/sys/fs/file-max 2>/dev/null')
    file_used, _, _ = run_command("cat /proc/sys/fs/file-nr 2>/dev/null | awk '{print $1}'")
    try:
        ratio = int(file_used.strip()) * 100 / int(file_max.strip())
        result.add_info(f'系统文件描述符: 已分配 {file_used.strip()} / 上限 {file_max.strip()} ({ratio:.1f}%)')
        if ratio >= 90: result.add_critical(f'系统文件描述符使用率 {ratio:.1f}% >= 90%')
        elif ratio >= 80: result.add_warning(f'系统文件描述符使用率 {ratio:.1f}% >= 80%')
        else: result.add_normal(f'系统文件描述符使用率 {ratio:.1f}%，正常')
    except (ValueError, ZeroDivisionError):
        result.add_info('无法读取系统文件描述符使用率')

    docker_path, _, _ = run_command('command -v docker')
    if docker_path.strip():
        containers, error, code = run_command("docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>&1")
        if code == 0:
            result.add_info('Docker容器状态:\n' + (containers.strip() or '暂无容器'))
            restarting, _, _ = run_command("docker ps --filter status=restarting -q | wc -l")
            if int(restarting.strip() or '0') > 0: result.add_critical(f'发现 {restarting.strip()} 个重启中的容器')
        else:
            result.add_warning(f'Docker状态读取失败: {(error or containers).strip()}')
    else:
        result.add_info('未检测到 docker 命令，跳过容器检查')
    result.set_end_time()
    return result
