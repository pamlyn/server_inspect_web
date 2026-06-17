from modules.inspection.models import InspectionResult
from modules.inspection.helpers import run_command
from modules.config_mgmt.helpers import get_config

def check_system_info():
    """检查系统信息"""
    result = InspectionResult()
    result.add_info("========== 开始系统信息巡检 ==========")

    # 检查系统版本
    stdout, stderr, _ = run_command("uname -a")
    if stdout:
        result.add_info(f"系统版本: {stdout.strip()}")

    # 检查内核版本
    stdout, stderr, _ = run_command("cat /etc/os-release 2>/dev/null || cat /etc/redhat-release 2>/dev/null || cat /etc/debian_version 2>/dev/null")
    if stdout:
        result.add_info("操作系统信息:")
        for line in stdout.strip().split('\n'):
            result.add_info(line.strip())

    # 检查主机名
    stdout, stderr, _ = run_command("hostname")
    if stdout:
        result.add_info(f"主机名: {stdout.strip()}")

    # 检查当前时间
    stdout, stderr, _ = run_command("date")
    if stdout:
        result.add_info(f"当前时间: {stdout.strip()}")

    result.set_end_time()
    return result