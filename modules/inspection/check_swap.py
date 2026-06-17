from modules.inspection.models import InspectionResult
from modules.inspection.helpers import run_command
from modules.config_mgmt.helpers import get_config

def check_swap():
    """检查交换分区使用情况"""
    result = InspectionResult()
    result.add_info("========== 开始交换分区巡检 ==========")

    THRESHOLDS = get_config('thresholds')

    if run_command("command -v free")[0]:
        # 获取交换分区信息
        swap_info = run_command("free -m | grep 'Swap:'")[0].strip()
        if swap_info:
            parts = swap_info.split()
            if len(parts) >= 4:
                total_swap = parts[1]
                used_swap = parts[2]
                free_swap = parts[3]

                if int(total_swap) > 0:
                    # 计算交换分区使用率
                    if run_command("command -v bc")[0]:
                        swap_usage, _, _ = run_command(f"echo 'scale=2; {used_swap} * 100 / {total_swap}' | bc")
                        swap_usage = swap_usage.strip()
                    else:
                        swap_usage, _, _ = run_command(f"echo '{used_swap} {total_swap}' | awk '{{print int($1 * 100 / $2)}}'")
                        swap_usage = swap_usage.strip()

                    swap_usage_int = swap_usage.split('.')[0] if swap_usage else "0"
                    swap_usage_int = swap_usage_int if swap_usage_int.strip() else "0"

                    result.add_info(f"交换分区总量: {total_swap}MB")
                    result.add_info(f"已用交换分区: {used_swap}MB")
                    result.add_info(f"剩余交换分区: {free_swap}MB")
                    result.add_info(f"交换分区使用率: {swap_usage}%")

                    # 分析交换分区使用率
                    swap_thresholds = THRESHOLDS.get("swap", {})
                    swap_warning = swap_thresholds.get("warning", 80)
                    swap_critical = swap_thresholds.get("critical", 90)

                    if int(swap_usage_int) > swap_critical:
                        result.add_critical(f"交换分区使用率 {swap_usage}% > {swap_critical}%，可能导致系统卡顿，处于紧急状态！")
                    elif int(swap_usage_int) > swap_warning:
                        result.add_warning(f"交换分区使用率 {swap_usage}% 在{swap_warning}%-{swap_critical}%之间，提示内存不足")
                    else:
                        result.add_normal(f"交换分区使用率 {swap_usage}%，正常")
                else:
                    result.add_info("未配置交换分区")
            else:
                result.add_info("未找到交换分区信息")
    else:
        result.add_warning("未找到free命令，无法检查交换分区使用情况")

    result.set_end_time()
    return result