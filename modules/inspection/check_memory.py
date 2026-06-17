from modules.inspection.models import InspectionResult
from modules.inspection.helpers import run_command
from modules.config_mgmt.helpers import get_config

def check_memory():
    """检查内存使用情况"""
    result = InspectionResult()
    result.add_info("========== 开始内存使用率巡检 ==========")

    THRESHOLDS = get_config('thresholds')

    if run_command("command -v free")[0]:
        # 获取内存使用情况
        stdout, stderr, _ = run_command("free -m")
        if stdout:
            lines = stdout.strip().split('\n')
            if len(lines) >= 2:
                memory_info = lines[1].split()
                if len(memory_info) >= 7:
                    total = memory_info[1]
                    used = memory_info[2]
                    buffers = memory_info[5]
                    cached = memory_info[6]

                    # 计算实际使用内存
                    actual_used = int(used) - int(buffers) - int(cached)
                    if actual_used < 0:
                        actual_used = int(used)

                    # 计算内存使用率
                    if int(total) > 0:
                        if run_command("command -v bc")[0]:
                            mem_usage = run_command(f"echo 'scale=2; {actual_used} * 100 / {total}' | bc")[0].strip()
                        else:
                            mem_usage = run_command(f"echo '{actual_used} {total}' | awk '{{print int($1 * 100 / $2)}}'")[0].strip()
                    else:
                        mem_usage = "0"

                    mem_usage_int = mem_usage.split('.')[0] if mem_usage else "0"

                    result.add_info(f"内存总量: {total}MB")
                    result.add_info(f"已用内存: {used}MB")
                    result.add_info(f"缓存: {cached}MB")
                    result.add_info(f"缓冲区: {buffers}MB")
                    result.add_info(f"实际使用: {actual_used}MB")
                    result.add_info(f"内存使用率: {mem_usage}%")

                    # 分析内存使用率
                    memory_thresholds = THRESHOLDS.get("memory", {})
                    memory_warning = memory_thresholds.get("warning", 80)
                    memory_critical = memory_thresholds.get("critical", 90)

                    if int(mem_usage_int) > memory_critical:
                        result.add_critical(f"内存使用率 {mem_usage}% > {memory_critical}%，处于紧急状态！")
                    elif int(mem_usage_int) > memory_warning:
                        result.add_warning(f"内存使用率 {mem_usage}% 在{memory_warning}%-{memory_critical}%之间，处于预警状态")
                    else:
                        result.add_normal(f"内存使用率 {mem_usage}%，正常")
                else:
                    result.add_warning("无法解析内存信息")
            else:
                result.add_warning("无法获取内存信息")
    else:
        result.add_warning("未找到free命令，无法检查内存使用情况")

    result.set_end_time()
    return result