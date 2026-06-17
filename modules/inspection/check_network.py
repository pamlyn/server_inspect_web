from modules.inspection.models import InspectionResult
from modules.inspection.helpers import run_command
from modules.config_mgmt.helpers import get_config

def check_network():
    """检查网络状态"""
    result = InspectionResult()
    result.add_info("========== 开始网络连接数巡检 ==========")

    # 检查网络连接数
    if run_command("command -v ss")[0]:
        # 获取TCP连接统计
        total_conn = run_command("ss -s | grep 'TCP:' | awk '{print $2}'")[0].strip()
        established = run_command("ss -s | grep 'TCP:' | awk '{print $4}' | cut -d',' -f1")[0].strip()

        result.add_info("TCP连接统计:")
        ss_output = run_command("ss -s")[0]
        if ss_output:
            result.add_info(ss_output.strip())

        # 获取系统最大连接数配置
        max_conn = run_command("cat /proc/sys/net/core/somaxconn 2>/dev/null || echo '128'")[0].strip()
        result.add_info(f"系统最大连接数配置: {max_conn}")

        # 分析连接数
        if established and max_conn:
            if run_command("command -v bc")[0]:
                conn_ratio = run_command(f"echo 'scale=2; {established} * 100 / {max_conn}' | bc")[0].strip()
            else:
                conn_ratio = run_command(f"echo '{established} {max_conn}' | awk '{{print int($1 * 100 / $2)}}'")[0].strip()

            conn_ratio_int = conn_ratio.split('.')[0] if conn_ratio else "0"
            conn_ratio_int = conn_ratio_int if conn_ratio_int.strip() else "0"

            if int(conn_ratio_int) > 80:
                result.add_critical(f"ESTABLISHED连接数占比 {conn_ratio}% > 80%，处于紧急状态！")
            elif int(conn_ratio_int) > 60:
                result.add_warning(f"ESTABLISHED连接数占比 {conn_ratio}% 在60%-80%之间，处于预警状态")
            else:
                result.add_normal(f"ESTABLISHED连接数占比 {conn_ratio}%，正常")

        # 检查监听端口状态
        result.add_info("监听端口状态:")
        ss_listen_output = run_command("ss -tuln | head -20")[0]
        if ss_listen_output:
            result.add_info(ss_listen_output.strip())
    elif run_command("command -v netstat")[0]:
        # 使用netstat检查
        result.add_info("TCP连接统计:")
        netstat_output = run_command("netstat -s | head -20")[0]
        if netstat_output:
            result.add_info(netstat_output.strip())

        result.add_info("监听端口状态:")
        netstat_listen_output = run_command("netstat -tuln | head -20")[0]
        if netstat_listen_output:
            result.add_info(netstat_listen_output.strip())
    else:
        result.add_warning("未找到ss或netstat命令，跳过网络连接检查")

    # 检查网络接口
    result.add_info("网络接口信息:")
    ifconfig_output = run_command("ifconfig | grep 'inet '")[0]
    if ifconfig_output:
        result.add_info(ifconfig_output.strip())
    else:
        result.add_warning("无法获取网络接口信息")

    # 检查ping状态
    result.add_info("网络连接测试:")
    ping_output = run_command("ping -c 4 www.baidu.com")[0]
    if ping_output:
        if "4 received" in ping_output:
            result.add_normal("网络连接正常")
        else:
            result.add_warning("网络连接可能存在问题")
    else:
        result.add_warning("无法检查网络连接")

    result.set_end_time()
    return result