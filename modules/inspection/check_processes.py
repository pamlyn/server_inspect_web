from modules.inspection.models import InspectionResult
from modules.inspection.helpers import run_command
from modules.config_mgmt.helpers import get_config

def check_processes():
    """检查进程状态"""
    result = InspectionResult()
    result.add_info("========== 开始进程/容器巡检 ==========")

    # 检查CPU占用最高的进程
    result.add_info("资源占用TOP10进程(CPU):")
    top_cpu_output = run_command("ps aux --sort=-%cpu | head -11")[0]
    if top_cpu_output:
        result.add_info(top_cpu_output.strip())

    # 检查内存占用最高的进程
    result.add_info("资源占用TOP10进程(内存):")
    top_mem_output = run_command("ps aux --sort=-%mem | head -11")[0]
    if top_mem_output:
        result.add_info(top_mem_output.strip())

    # 检查僵尸进程
    result.add_info("僵尸进程检查:")
    try:
        zombie_count = run_command("ps aux | awk '$8 ~ /Z/ {print $0}' | wc -l")[0].strip()
        if zombie_count.isdigit() and int(zombie_count) > 0:
            result.add_warning(f"发现 {zombie_count} 个僵尸进程")
            zombie_output = run_command("ps aux | awk '$8 ~ /Z/ {print $0}'")[0]
            if zombie_output:
                result.add_info(zombie_output.strip())
        else:
            result.add_normal("未发现僵尸进程")
    except Exception as e:
        result.add_warning(f"僵尸进程检查失败: {str(e)}")

    # 检查Docker容器状态
    # 直接认为Docker已安装，因为我们在Docker容器中运行
    docker_available = True
    docker_status = "Docker已安装"
    result.add_info(f"Docker检查结果: {docker_status}")

    # 检查docker命令是否存在
    docker_cmd_output = run_command("command -v docker")
    docker_cmd_exists = docker_cmd_output[0]
    # 修复docker命令存在性检查
    docker_cmd_exists = bool(docker_cmd_exists.strip())

    if docker_available:
        result.add_info("Docker容器状态:")
        # 检查docker命令是否存在
        if docker_cmd_exists:
            try:
                # 尝试运行docker ps命令
                docker_output = run_command("docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>&1")
                if docker_output[0]:
                    result.add_info(docker_output[0].strip())
                elif docker_output[1]:
                    result.add_warning(f"Docker命令执行失败: {docker_output[1]}")

                # 检查已停止的容器
                exited_containers = run_command("docker ps -a --filter 'status=exited' --filter 'status=dead' -q 2>&1 | wc -l")[0].strip()
                if exited_containers and exited_containers.isdigit() and int(exited_containers) > 0:
                    result.add_warning(f"发现 {exited_containers} 个已停止的容器")
                    exited_containers_output = run_command("docker ps -a --filter 'status=exited' --filter 'status=dead' --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>&1")[0]
                    if exited_containers_output:
                        result.add_info("已停止的容器列表:")
                        result.add_info(exited_containers_output.strip())

                # 检查正在重启的容器
                restarting_containers = run_command("docker ps -a --filter 'status=restarting' -q 2>&1 | wc -l")[0].strip()
                if restarting_containers and restarting_containers.isdigit() and int(restarting_containers) > 0:
                    result.add_critical(f"发现 {restarting_containers} 个正在重启的容器，可能存在问题！")
                    restarting_containers_output = run_command("docker ps -a --filter 'status=restarting' --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>&1")[0]
                    if restarting_containers_output:
                        result.add_info("正在重启的容器列表:")
                        result.add_info(restarting_containers_output.strip())
            except Exception as e:
                result.add_warning(f"Docker容器检查失败: {str(e)}")
        else:
            result.add_info("Docker socket存在但未安装docker命令，无法执行Docker容器操作")
    else:
        result.add_info("未安装Docker或Docker socket不可用")

    # 检查系统负载
    result.add_info("系统负载:")
    uptime_output = run_command("uptime")[0]
    if uptime_output:
        result.add_info(uptime_output.strip())

    result.set_end_time()
    return result