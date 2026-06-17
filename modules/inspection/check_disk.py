from modules.inspection.models import InspectionResult
from modules.inspection.helpers import run_command
from modules.config_mgmt.helpers import get_config

def check_disk():
    """检查磁盘使用情况"""
    result = InspectionResult()
    result.add_info("========== 开始磁盘使用率巡检 ==========")

    THRESHOLDS = get_config('thresholds')

    if run_command("command -v df")[0]:
        # 检查磁盘使用情况
        result.add_info("磁盘使用情况:")
        stdout, stderr, _ = run_command("df -h | grep -E '^/dev'")
        if stdout:
            lines = stdout.strip().split('\n')
            for line in lines:
                parts = line.split()
                if len(parts) >= 6:
                    mount_point = parts[5]
                    usage_percent = parts[4].replace('%', '')
                    total = parts[1]
                    used = parts[2]
                    avail = parts[3]

                    result.add_info(f"  {mount_point}: 总计 {total}, 已用 {used}, 可用 {avail}, 使用率 {usage_percent}%")

                    # 分析磁盘使用率
                    if usage_percent and usage_percent.isdigit():
                        disk_thresholds = THRESHOLDS.get("disk", {})
                        disk_warning = disk_thresholds.get("warning", 80)
                        disk_critical = disk_thresholds.get("critical", 90)

                        if int(usage_percent) > disk_critical:
                            result.add_critical(f"磁盘 {mount_point} 使用率 {usage_percent}% > {disk_critical}%，处于紧急状态！")
                        elif int(usage_percent) > disk_warning:
                            result.add_warning(f"磁盘 {mount_point} 使用率 {usage_percent}% > {disk_warning}%，处于预警状态")
                        else:
                            result.add_normal(f"磁盘 {mount_point} 使用率 {usage_percent}%，正常")

                    # 分析磁盘剩余空间
                    if avail.endswith('G'):
                        avail_gb = float(avail[:-1])
                        disk_free_thresholds = THRESHOLDS.get("disk_free", {})
                        disk_free_warning = disk_free_thresholds.get("warning", 10)
                        disk_free_critical = disk_free_thresholds.get("critical", 5)

                        if avail_gb < disk_free_critical:
                            result.add_critical(f"磁盘 {mount_point} 剩余空间 {avail} < {disk_free_critical}GB，处于紧急状态！")
                        elif avail_gb < disk_free_warning:
                            result.add_warning(f"磁盘 {mount_point} 剩余空间 {avail} < {disk_free_warning}GB，处于预警状态")
                        else:
                            result.add_normal(f"磁盘 {mount_point} 剩余空间 {avail}，正常")

        # 检查inode使用情况
        result.add_info("Inode使用情况:")
        inode_output = run_command("df -i | grep -E '^/dev'")[0]
        if inode_output:
            result.add_info(inode_output.strip())
    else:
        result.add_warning("未找到df命令，无法检查磁盘使用情况")

    result.set_end_time()
    return result

def check_disk_io():
    """检查磁盘IO情况"""
    result = InspectionResult()
    result.add_info("开始磁盘IO巡检")

    THRESHOLDS = get_config('thresholds')

    # 检查iostat命令是否存在，如果不存在尝试安装sysstat
    if not run_command("command -v iostat")[0]:
        result.add_info("未找到iostat命令，尝试自动安装sysstat...")
        # 尝试安装sysstat
        install_success = False
        if run_command("command -v yum")[0]:
            if run_command("yum install -y sysstat 2>/dev/null")[2] == 0:
                install_success = True
        elif run_command("command -v apt-get")[0]:
            if run_command("apt-get update 2>/dev/null && apt-get install -y sysstat 2>/dev/null")[2] == 0:
                install_success = True

        if not install_success:
            result.add_warning("自动安装sysstat失败，请手动安装")
            result.add_info("请手动安装: yum install sysstat 或 apt-get install sysstat")
            # 尝试使用vmstat获取磁盘IO信息
            if run_command("command -v vmstat")[0]:
                vmstat_output = run_command("vmstat 1 3")[0]
                if vmstat_output:
                    result.add_info("磁盘IO统计(vmstat):")
                    result.add_info(vmstat_output.strip())
            return result

    # 获取磁盘IO统计(3次采样)
    io_info = run_command("iostat -x 1 3 | tail -n +4")[0]
    if io_info:
        result.add_info("磁盘IO统计(3次采样):")
        result.add_info(io_info.strip())

    # 获取IO等待时间
    iowait = run_command("iostat -c 1 3 | tail -1 | awk '{print $4}'")[0].strip()
    if iowait:
        iowait_int = iowait.split('.')[0] if '.' in iowait else iowait
        if not iowait_int:
            iowait_int = "0"

        # 使用配置的阈值
        disk_io_thresholds = THRESHOLDS.get("disk_io", {})
        disk_io_warning = disk_io_thresholds.get("warning", 5)
        disk_io_critical = disk_io_thresholds.get("critical", 30)

        if int(iowait_int) > disk_io_critical:
            result.add_critical(f"IO等待时间 {iowait}% > {disk_io_critical}%，存在IO阻塞，处于紧急状态！")
        elif int(iowait_int) > disk_io_warning:
            result.add_warning(f"IO等待时间 {iowait}% > {disk_io_warning}%，处于预警状态")
        else:
            result.add_normal(f"IO等待时间 {iowait}%，正常")
    else:
        result.add_info("无法获取IO等待时间")

    result.set_end_time()
    return result