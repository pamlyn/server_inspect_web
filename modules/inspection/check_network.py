from modules.inspection.helpers import run_command
from modules.inspection.models import InspectionResult


def _network_interface_counters():
    counters = []
    try:
        lines = open('/proc/net/dev', encoding='utf-8').read().splitlines()[2:]
        for line in lines:
            name, values = line.split(':', 1)
            fields = values.split()
            if len(fields) >= 16 and name.strip() != 'lo':
                counters.append((name.strip(), int(fields[0]), int(fields[2]), int(fields[8]), int(fields[10])))
    except (OSError, ValueError, IndexError):
        return []
    return counters


def check_network():
    """检查本机网络栈、TCP 状态和网卡错误，不依赖外网连通性。"""
    result = InspectionResult()
    interfaces = _network_interface_counters()
    if interfaces:
        for name, rx_bytes, rx_errors, tx_bytes, tx_errors in interfaces:
            result.add_info(f'网卡 {name}: RX {rx_bytes} bytes, TX {tx_bytes} bytes, RX错误 {rx_errors}, TX错误 {tx_errors}')
            if rx_errors or tx_errors:
                result.add_warning(f'网卡 {name} 存在收发错误，请检查链路或驱动')
        if not any(item[2] or item[4] for item in interfaces): result.add_normal('网卡未发现收发错误')
    else:
        result.add_info('无法读取 /proc/net/dev 网卡统计')

    ss_path, _, _ = run_command('command -v ss')
    if ss_path.strip():
        summary, _, _ = run_command('ss -s 2>/dev/null')
        states, _, _ = run_command("ss -tan state time-wait 2>/dev/null | tail -n +2 | wc -l")
        established, _, _ = run_command("ss -tan state established 2>/dev/null | tail -n +2 | wc -l")
        listen, _, _ = run_command("ss -ltn 2>/dev/null | tail -n +2 | wc -l")
        result.add_info('TCP汇总:\n' + (summary.strip() or '不可用'))
        result.add_info(f'TCP连接: ESTABLISHED={established.strip() or 0}, TIME_WAIT={states.strip() or 0}, LISTEN={listen.strip() or 0}')
    else:
        result.add_info('未检测到 ss 命令，跳过 TCP 状态统计')

    netstat, _, _ = run_command('cat /proc/net/netstat 2>/dev/null | head -4')
    if netstat.strip(): result.add_info('内核网络统计原始数据:\n' + netstat.strip())
    result.set_end_time()
    return result
