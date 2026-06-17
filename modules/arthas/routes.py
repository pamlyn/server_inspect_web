"""
Arthas 诊断模块 - 路由定义
参考 arthas-web 的 session-based 架构：
  SSH连接 -> sessionId -> 容器/进程 -> 启动Arthas -> 执行命令
"""

from flask import Blueprint, jsonify, request, Response
import subprocess
import time
import threading

from modules.auth.helpers import login_required
from modules.arthas.arthas_client import ArthasClient
from modules.arthas.arthas_presets import get_all_presets, get_preset_commands
from modules.arthas.server_manager import ServerManager
from utils.ssh_client import SSHClient

arthas_bp = Blueprint('arthas', __name__, url_prefix='/api/arthas')
server_mgr = ServerManager()

# SSH 会话存储（内存中，进程级别）
_ssh_sessions = {}
_session_lock = threading.Lock()


# ===================== SSH 会话管理 =====================

@arthas_bp.route('/sessions', methods=['POST'])
@login_required
def create_session():
    """创建 SSH 会话，返回 sessionId"""
    data = request.json
    host = data.get('host')
    ssh_port = data.get('port', 22)
    username = data.get('username', 'root')
    auth_type = data.get('auth_type', 'password')
    password = data.get('password', '')
    private_key = data.get('private_key', '')

    if not host:
        return jsonify({'success': False, 'message': '主机地址不能为空'}), 400

    ssh = SSHClient()
    if auth_type == 'key':
        success, msg = ssh.connect(host, ssh_port, username, private_key_path=private_key)
    else:
        success, msg = ssh.connect(host, ssh_port, username, password=password)

    if not success:
        return jsonify({'success': False, 'message': f'SSH连接失败: {msg}'}), 500

    # 分配 sessionId
    with _session_lock:
        session_id = str(len(_ssh_sessions) + 1)
        _ssh_sessions[session_id] = ssh

    return jsonify({
        'success': True,
        'sessionId': session_id,
        'host': host,
        'username': username
    })


@arthas_bp.route('/sessions/<session_id>', methods=['DELETE'])
@login_required
def delete_session(session_id):
    """断开 SSH 会话"""
    with _session_lock:
        ssh = _ssh_sessions.pop(session_id, None)
    if ssh:
        ssh.close()
    return jsonify({'success': True, 'message': '会话已断开'})


@arthas_bp.route('/sessions/<session_id>/containers', methods=['GET'])
@login_required
def list_containers(session_id):
    """列出远程服务器的 Docker 容器"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    # 检查 SSH 连接是否仍然活跃
    if not ssh.client or not ssh.client.get_transport() or not ssh.client.get_transport().is_active():
        return jsonify({'success': False, 'message': 'SSH会话已断开，请重新连接'}), 400

    success, containers = ssh.list_docker_containers()
    if not success:
        return jsonify({'success': True, 'containers': [], 'message': 'Docker未安装或无法访问'})

    return jsonify({'success': True, 'containers': containers})


@arthas_bp.route('/sessions/<session_id>/containers/<container_id>/java-processes', methods=['GET'])
@login_required
def list_container_java_processes(session_id, container_id):
    """列出容器内的 Java 进程"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    success, processes = ssh.list_container_java_processes(container_id)
    if not success:
        return jsonify({'success': False, 'message': '获取进程列表失败'})

    return jsonify({'success': True, 'processes': processes})


# ===================== 本机操作（无需SSH） =====================

@arthas_bp.route('/local/java-processes', methods=['GET'])
@login_required
def local_java_processes():
    """列出本机 Java 进程（多方法检测）"""
    try:
        processes = []
        seen_pids = set()

        # 方法1: jps（JDK自带工具，最准确）
        result = subprocess.run('jps -lV 2>/dev/null',
                                shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            for line in result.stdout.strip().split('\n'):
                if not line.strip():
                    continue
                parts = line.strip().split(None, 1)
                if len(parts) >= 1:
                    try:
                        pid = int(parts[0])
                        if pid <= 100 or pid in seen_pids:
                            continue
                        seen_pids.add(pid)
                        name = parts[1] if len(parts) > 1 else 'java'
                        processes.append({'pid': pid, 'name': name[:80]})
                    except ValueError:
                        continue

        # 方法2: ps -eo pid,comm (COMMAND列直接显示java)
        if not processes:
            result = subprocess.run("ps -eo pid,comm --no-headers 2>/dev/null | awk '$2==\"java\"'",
                                    shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    universal_newlines=True, timeout=10)
            if result.stdout.strip():
                for line in result.stdout.strip().split('\n'):
                    if not line.strip():
                        continue
                    parts = line.strip().split(None, 1)
                    if len(parts) >= 1:
                        try:
                            pid = int(parts[0])
                            if pid <= 100 or pid in seen_pids:
                                continue
                            seen_pids.add(pid)
                            processes.append({'pid': pid, 'name': 'java'})
                        except ValueError:
                            continue

        # 方法3: 带完整参数的ps（最广泛）
        if not processes:
            result = subprocess.run('ps -eo pid,args --no-headers 2>/dev/null | grep -i java | grep -v grep',
                                    shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    universal_newlines=True, timeout=10)
            if result.stdout.strip():
                for line in result.stdout.strip().split('\n'):
                    if not line.strip() or 'grep' in line.lower():
                        continue
                    parts = line.strip().split(None, 1)
                    if len(parts) >= 1:
                        try:
                            pid = int(parts[0])
                            if pid <= 100 or pid in seen_pids:
                                continue
                            seen_pids.add(pid)
                            name = parts[1] if len(parts) > 1 else 'java'
                            processes.append({'pid': pid, 'name': name[:80]})
                        except ValueError:
                            continue

        return jsonify({'success': True, 'processes': processes})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@arthas_bp.route('/local/containers', methods=['GET'])
@login_required
def local_containers():
    """列出本机 Docker 容器"""
    try:
        result = subprocess.run(
            'docker ps --format \'{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\' 2>/dev/null',
            shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=10
        )

        containers = []
        for line in result.stdout.strip().split('\n'):
            if not line.strip():
                continue
            parts = line.strip().split('\t')
            if len(parts) >= 2:
                containers.append({
                    'id': parts[0] if len(parts) >= 4 else '',
                    'name': parts[1],
                    'image': parts[2] if len(parts) >= 3 else '',
                    'status': parts[3] if len(parts) >= 4 else ''
                })

        return jsonify({'success': True, 'containers': containers})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@arthas_bp.route('/local/containers/<container_id>/java-processes', methods=['GET'])
@login_required
def local_container_java_processes(container_id):
    """列出本机 Docker 容器内的 Java 进程（多方法检测）"""
    try:
        processes = []
        seen_pids = set()

        # 方法1: jps
        result = subprocess.run(
            f'docker exec {container_id} jps -lV 2>/dev/null',
            shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=10
        )
        if result.returncode == 0 and result.stdout.strip():
            for line in result.stdout.strip().split('\n'):
                if not line.strip():
                    continue
                parts = line.strip().split(None, 1)
                if len(parts) >= 1:
                    try:
                        pid = int(parts[0])
                        if pid <= 10 or pid in seen_pids:
                            continue
                        seen_pids.add(pid)
                        name = parts[1] if len(parts) > 1 else 'java'
                        processes.append({'pid': pid, 'name': name[:80]})
                    except ValueError:
                        continue

        # 方法2: ps -eo pid,comm
        if not processes:
            result = subprocess.run(
                f"docker exec {container_id} sh -c \"ps -eo pid,comm 2>/dev/null | awk '$2==java'\"",
                shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=10
            )
            if result.stdout.strip():
                for line in result.stdout.strip().split('\n'):
                    if not line.strip():
                        continue
                    parts = line.strip().split(None, 1)
                    if len(parts) >= 1:
                        try:
                            pid = int(parts[0])
                            if pid <= 10 or pid in seen_pids:
                                continue
                            seen_pids.add(pid)
                            processes.append({'pid': pid, 'name': 'java'})
                        except ValueError:
                            continue

        # 方法3: ps -eo pid,args with grep
        if not processes:
            result = subprocess.run(
                f"docker exec {container_id} sh -c \"ps -eo pid,args 2>/dev/null | grep -i java | grep -v grep\"",
                shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=10
            )
            if result.stdout.strip():
                for line in result.stdout.strip().split('\n'):
                    if not line.strip() or 'grep' in line.lower():
                        continue
                    parts = line.strip().split(None, 1)
                    if len(parts) >= 1:
                        try:
                            pid = int(parts[0])
                            if pid <= 10 or pid in seen_pids:
                                continue
                            seen_pids.add(pid)
                            name = parts[1] if len(parts) > 1 else 'java'
                            processes.append({'pid': pid, 'name': name[:80]})
                        except ValueError:
                            continue

        return jsonify({'success': True, 'processes': processes})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


# ===================== Arthas 启动/停止/状态 =====================

@arthas_bp.route('/sessions/<session_id>/arthas/start', methods=['POST'])
@login_required
def remote_start_arthas(session_id):
    """远程启动 Arthas（通过 SSH 会话）"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    # 检查 SSH 连接是否仍然活跃
    if not ssh.client or not ssh.client.get_transport() or not ssh.client.get_transport().is_active():
        return jsonify({'success': False, 'message': 'SSH会话已断开，请重新连接'}), 400

    data = request.json
    container_id = data.get('containerId', '')
    java_pid = data.get('javaPid')
    http_port = data.get('httpPort', 8563)

    # 如果没有指定PID，尝试启动独立模式
    if not java_pid:
        success, msg = ssh.start_arthas_standalone(http_port, docker_container=container_id or None)
        if success:
            return jsonify({'success': True, 'message': msg, 'httpPort': http_port})
        return jsonify({'success': False, 'message': msg}), 500

    success, msg = ssh.start_arthas(java_pid, http_port, docker_container=container_id or None)
    if success:
        return jsonify({'success': True, 'message': msg, 'httpPort': http_port})
    return jsonify({'success': False, 'message': msg}), 500


@arthas_bp.route('/local/arthas/start', methods=['POST'])
@login_required
def local_start_arthas():
    """本机启动 Arthas - 支持进程模式和独立模式"""
    data = request.json
    container_id = data.get('containerId', '')
    java_pid = data.get('javaPid')
    http_port = data.get('httpPort', 8563)

    # 未指定PID时启动独立模式
    if not java_pid:
        return _local_start_arthas_standalone(http_port, container_id)

    arthas_jar = SSHClient.ARTHAS_LOCAL_PATH
    if not _check_arthas_jar_local():
        return jsonify({'success': False, 'message': '下载arthas-boot.jar失败'}), 500

    if container_id:
        # 容器模式：确保jar存在，使用docker exec -d启动
        subprocess.run(f'docker exec {container_id} mkdir -p /opt/arthas', shell=True, timeout=10)
        subprocess.run(f'docker cp {arthas_jar} {container_id}:{arthas_jar}', shell=True, timeout=30)
        start_cmd = (
            f'docker exec -d {container_id} java -jar {arthas_jar}'
            f' {java_pid} --telnet-port 3{http_port} --http-port {http_port}'
        )
    else:
        # 主机模式：PID作为位置参数，独立端口
        start_cmd = (
            f'nohup java -jar {arthas_jar} {java_pid}'
            f' --telnet-port 3{http_port} --http-port {http_port}'
            f' > /dev/null 2>&1 &'
        )

    subprocess.run(start_cmd, shell=True, timeout=15)

    # 轮询检查端口监听（20次 × 2秒 = 40秒）
    for i in range(20):
        time.sleep(2)
        if _check_port_listening_local(http_port, container_id):
            return jsonify({'success': True, 'message': f'Arthas启动成功 (PID {java_pid}, 端口{http_port})', 'httpPort': http_port})

    return jsonify({'success': False, 'message': f'Arthas启动超时（已等待40秒），请检查Java进程{java_pid}是否有效'}), 500


@arthas_bp.route('/sessions/<session_id>/arthas/status', methods=['POST'])
@login_required
def remote_arthas_status(session_id):
    """远程检查 Arthas 状态"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    data = request.json
    http_port = data.get('httpPort', 8563)
    container_id = data.get('containerId', '')

    running, msg = ssh.check_arthas_running(http_port)
    return jsonify({'success': True, 'running': running, 'message': msg})


@arthas_bp.route('/local/arthas/status', methods=['POST'])
@login_required
def local_arthas_status():
    """本机检查 Arthas 状态"""
    data = request.json
    http_port = data.get('httpPort', 8563)

    client = ArthasClient(host='localhost', port=http_port)
    running, msg = client.check_connection()
    return jsonify({'success': True, 'running': running, 'message': msg})


@arthas_bp.route('/sessions/<session_id>/arthas/stop', methods=['POST'])
@login_required
def remote_stop_arthas(session_id):
    """远程停止 Arthas"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    data = request.json
    container_id = data.get('containerId', '')
    http_port = data.get('httpPort', 8563)
    java_pid = data.get('javaPid', 0)

    success, msg = ssh.stop_arthas(java_pid, http_port, docker_container=container_id or None)
    return jsonify({'success': True, 'message': msg})


@arthas_bp.route('/local/arthas/stop', methods=['POST'])
@login_required
def local_stop_arthas():
    """本机停止 Arthas"""
    data = request.json
    container_id = data.get('containerId', '')
    http_port = data.get('httpPort', 8563)

    if container_id:
        find_cmd = f'docker exec {container_id} ps -eo pid,args | grep arthas | grep -v grep | awk \'{{print $1}}\''
        result = subprocess.run(find_cmd, shell=True, capture_output=True, text=True, timeout=10)
        if result.stdout.strip():
            for apid in result.stdout.strip().split('\n'):
                subprocess.run(f'docker exec {container_id} kill {apid.strip()}', shell=True, timeout=10)
    else:
        find_cmd = f'ps -eo pid,args | grep arthas | grep -v grep | awk \'{{print $1}}\''
        result = subprocess.run(find_cmd, shell=True, capture_output=True, text=True, timeout=10)
        if result.stdout.strip():
            for apid in result.stdout.strip().split('\n'):
                subprocess.run(f'kill {apid.strip()}', shell=True, timeout=10)

    return jsonify({'success': True, 'message': 'Arthas已停止'})


# ===================== Arthas 命令执行 =====================

@arthas_bp.route('/sessions/<session_id>/arthas/exec', methods=['POST'])
@login_required
def remote_exec_command(session_id):
    """远程执行 Arthas 命令（同步）"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    data = request.json
    command = data.get('command')
    http_port = data.get('httpPort', 8563)
    container_id = data.get('containerId', '')
    exec_timeout = data.get('execTimeout', 30000)

    if not command:
        return jsonify({'success': False, 'message': '命令不能为空'}), 400

    # 通过 SSH 隧道连接 Arthas HTTP API
    # 方式1：容器内直接 curl
    # 方式2：主机端口映射（已映射到本机）
    # 方式3：SSH 端口转发（需要额外处理）
    # 这里简化处理：尝试通过 curl 在远程执行
    if container_id:
        curl_cmd = (
            f'docker exec {container_id} curl -s -X POST'
            f' http://localhost:{http_port}/api'
            f' -H "Content-Type: application/json"'
            f' -d \'{{"action":"exec","command":"{command}"}}\''
        )
    else:
        curl_cmd = (
            f'curl -s -X POST http://localhost:{http_port}/api'
            f' -H "Content-Type: application/json"'
            f' -d \'{{"action":"exec","command":"{command}"}}\''
        )

    success, output, error = ssh.execute_command(curl_cmd, timeout=max(exec_timeout // 1000, 10))

    if not success and not output:
        return jsonify({'success': False, 'message': f'命令执行失败: {error or "无响应"}'})

    try:
        import json
        arthas_result = json.loads(output)
        if arthas_result.get('state') == 'SUCCEEDED' and 'body' in arthas_result:
            results = arthas_result['body'].get('results', [])
            if results:
                cmd_output = results[0].get('output', '')
                return jsonify({'success': True, 'output': cmd_output})
        return jsonify({'success': False, 'output': arthas_result.get('message', output or '未知错误')})
    except json.JSONDecodeError:
        return jsonify({'success': False, 'output': output or error or '解析响应失败'})


@arthas_bp.route('/local/arthas/exec', methods=['POST'])
@login_required
def local_exec_command():
    """本机执行 Arthas 命令（同步）"""
    data = request.json
    command = data.get('command')
    http_port = data.get('httpPort', 8563)
    exec_timeout = data.get('execTimeout', 30)

    if not command:
        return jsonify({'success': False, 'message': '命令不能为空'}), 400

    client = ArthasClient(host='localhost', port=http_port, timeout=exec_timeout)

    # 区分异步命令和同步命令
    async_commands = ['dashboard', 'profiler start', 'watch', 'trace', 'stack']
    is_async = any(command.strip().startswith(cmd) for cmd in async_commands)

    if is_async:
        result = client.exec_async(command)
    else:
        result = client.exec_sync(command)

    return jsonify(result)


@arthas_bp.route('/sessions/<session_id>/arthas/async/start', methods=['POST'])
@login_required
def remote_async_start(session_id):
    """远程启动异步命令（watch/trace 等）"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    data = request.json
    command = data.get('command')
    http_port = data.get('httpPort', 8563)
    container_id = data.get('containerId', '')

    if not command:
        return jsonify({'success': False, 'message': '命令不能为空'}), 400

    # 构建异步命令的 curl 请求
    if container_id:
        curl_cmd = (
            f'docker exec {container_id} curl -s -X POST'
            f' http://localhost:{http_port}/api'
            f' -H "Content-Type: application/json"'
            f" -d '{{\"action\":\"async_exec\",\"command\":\"{command}\"}}'"
        )
    else:
        curl_cmd = (
            f'curl -s -X POST http://localhost:{http_port}/api'
            f' -H "Content-Type: application/json"'
            f" -d '{{\"action\":\"async_exec\",\"command\":\"{command}\"}}'"
        )

    success, output, error = ssh.execute_command(curl_cmd, timeout=10)

    if not success and not output:
        return jsonify({'success': False, 'message': f'异步启动失败: {error or "无响应"}'})

    try:
        import json
        arthas_result = json.loads(output)
        body = arthas_result.get('body', {})
        job_id = body.get('jobId')
        return jsonify({
            'success': True,
            'jobId': job_id,
            'sessionId': session_id,
            'httpPort': http_port,
            'containerId': container_id,
            'message': '异步命令已启动'
        })
    except json.JSONDecodeError:
        return jsonify({'success': False, 'message': output or error or '解析响应失败'})


@arthas_bp.route('/local/arthas/async/start', methods=['POST'])
@login_required
def local_async_start():
    """本机启动异步命令"""
    data = request.json
    command = data.get('command')
    http_port = data.get('httpPort', 8563)

    if not command:
        return jsonify({'success': False, 'message': '命令不能为空'}), 400

    client = ArthasClient(host='localhost', port=http_port)
    result = client._post('async_exec', command=command)

    if result.get('state') == 'SUCCEEDED':
        body = result.get('body', {})
        job_id = body.get('jobId')
        return jsonify({
            'success': True,
            'jobId': job_id,
            'httpPort': http_port,
            'message': '异步命令已启动'
        })

    return jsonify({'success': False, 'message': result.get('message', '异步启动失败')})


@arthas_bp.route('/sessions/<session_id>/arthas/async/pull', methods=['POST'])
@login_required
def remote_async_pull(session_id):
    """远程拉取异步命令结果"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    data = request.json
    http_port = data.get('httpPort', 8563)
    container_id = data.get('containerId', '')
    arthas_session_id = data.get('arthasSessionId', '')

    # 使用 consumerId 模式拉取结果
    # Arthas HTTP API: POST /api action=exec command="jobresult <id>"
    # 或者直接用 async_exec 模式拉取结果
    # 简化：通过 curl 执行 jobs 命令查看状态
    if container_id:
        curl_cmd = (
            f'docker exec {container_id} curl -s -X POST'
            f' http://localhost:{http_port}/api'
            f' -H "Content-Type: application/json"'
            f' -d \'{{"action":"exec","command":"jobs"}}\''
        )
    else:
        curl_cmd = (
            f'curl -s -X POST http://localhost:{http_port}/api'
            f' -H "Content-Type: application/json"'
            f' -d \'{{"action":"exec","command":"jobs"}}\''
        )

    success, output, error = ssh.execute_command(curl_cmd, timeout=10)

    if not success and not output:
        return jsonify({'success': False, 'message': f'拉取结果失败: {error or "无响应"}'})

    try:
        import json
        arthas_result = json.loads(output)
        if arthas_result.get('state') == 'SUCCEEDED' and 'body' in arthas_result:
            results = arthas_result['body'].get('results', [])
            return jsonify({'success': True, 'results': results})
        return jsonify({'success': False, 'message': arthas_result.get('message', '拉取失败')})
    except json.JSONDecodeError:
        return jsonify({'success': False, 'message': output or error or '解析响应失败'})


@arthas_bp.route('/sessions/<session_id>/arthas/async/interrupt', methods=['POST'])
@login_required
def remote_async_interrupt(session_id):
    """远程中断异步命令"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    data = request.json
    job_id = data.get('jobId')
    http_port = data.get('httpPort', 8563)
    container_id = data.get('containerId', '')

    if not job_id:
        return jsonify({'success': False, 'message': 'jobId不能为空'}), 400

    if container_id:
        curl_cmd = (
            f'docker exec {container_id} curl -s -X POST'
            f' http://localhost:{http_port}/api'
            f' -H "Content-Type: application/json"'
            f' -d \'{{"action":"interrupt","jobId":{job_id}}}\''
        )
    else:
        curl_cmd = (
            f'curl -s -X POST http://localhost:{http_port}/api'
            f' -H "Content-Type: application/json"'
            f' -d \'{{"action":"interrupt","jobId":{job_id}}}\''
        )

    ssh.execute_command(curl_cmd, timeout=10)
    return jsonify({'success': True, 'message': '异步命令已中断'})


@arthas_bp.route('/local/arthas/async/interrupt', methods=['POST'])
@login_required
def local_async_interrupt():
    """本机中断异步命令"""
    data = request.json
    job_id = data.get('jobId')
    http_port = data.get('httpPort', 8563)

    if not job_id:
        return jsonify({'success': False, 'message': 'jobId不能为空'}), 400

    client = ArthasClient(host='localhost', port=http_port)
    client.interrupt_job(int(job_id))
    return jsonify({'success': True, 'message': '异步命令已中断'})


# ===================== 预设命令 =====================

@arthas_bp.route('/presets', methods=['GET'])
@login_required
def get_presets():
    """获取所有预设定义"""
    return jsonify({'success': True, 'presets': get_all_presets()})


@arthas_bp.route('/preset/exec', methods=['POST'])
@login_required
def exec_preset():
    """执行一键诊断预设（顺序执行多条命令）— 本机模式"""
    data = request.json
    http_port = data.get('httpPort', 8563)
    preset_id = data.get('preset_id')
    template_vars = data.get('template_vars', {})

    if not preset_id:
        return jsonify({'success': False, 'message': '预设ID不能为空'}), 400

    commands = get_preset_commands(preset_id)
    if not commands:
        return jsonify({'success': False, 'message': '预设不存在'}), 400

    client = ArthasClient(host='localhost', port=http_port)
    results = []

    for cmd_info in commands:
        command = cmd_info['command']

        if cmd_info.get('is_template'):
            for var_name in cmd_info.get('template_vars', []):
                var_value = template_vars.get(var_name, '')
                if var_value:
                    command = command.replace(f'{{{var_name}}}', var_value)
                else:
                    results.append({
                        'command': command, 'label': cmd_info.get('label', ''),
                        'success': False, 'output': f'缺少模板变量: {var_name}',
                        'desc': cmd_info.get('desc', '')
                    })
                    continue

        result = client.exec_sync(command)
        results.append({
            'command': command, 'label': cmd_info.get('label', ''),
            'success': result.get('success', False),
            'output': result.get('output', ''),
            'desc': cmd_info.get('desc', '')
        })

    return jsonify({'success': True, 'results': results})


# ===================== 服务器配置管理 =====================

@arthas_bp.route('/servers', methods=['GET'])
@login_required
def list_servers():
    """获取保存的服务器配置列表"""
    return jsonify({'success': True, 'servers': server_mgr.list_servers()})


@arthas_bp.route('/servers', methods=['POST'])
@login_required
def add_server():
    """新增服务器配置"""
    data = request.json
    required_fields = ['name', 'host']
    for field in required_fields:
        if not data.get(field):
            return jsonify({'success': False, 'message': f'{field}不能为空'}), 400

    server_info = {
        'name': data.get('name'),
        'host': data.get('host'),
        'ssh_port': data.get('ssh_port', 22),
        'username': data.get('username', 'root'),
        'auth_type': data.get('auth_type', 'password'),
        'password': data.get('password', ''),
        'private_key_path': data.get('private_key_path', ''),
        'arthas_port': data.get('arthas_port', 8563),
        'connection_mode': data.get('connection_mode', 'direct'),
        'ssh_local_port': data.get('ssh_local_port', 18563)
    }

    new_server = server_mgr.add_server(server_info)
    return jsonify({'success': True, 'server': new_server})


@arthas_bp.route('/servers/<int:server_id>', methods=['PUT'])
@login_required
def update_server(server_id):
    """更新服务器配置"""
    data = request.json
    updated = server_mgr.update_server(server_id, data)
    if not updated:
        return jsonify({'success': False, 'message': '服务器配置不存在'}), 404
    return jsonify({'success': True, 'server': updated})


@arthas_bp.route('/servers/<int:server_id>', methods=['DELETE'])
@login_required
def delete_server(server_id):
    """删除服务器配置"""
    server_mgr.delete_server(server_id)
    return jsonify({'success': True, 'message': '删除成功'})


# ===================== 辅助函数 =====================

def _check_arthas_jar_local():
    """确保本机有 arthas-boot.jar，不存在则下载"""
    import os
    arthas_jar = SSHClient.ARTHAS_LOCAL_PATH
    if os.path.exists(arthas_jar):
        return True
    os.makedirs('/opt/arthas', exist_ok=True)
    try:
        subprocess.run(
            f'curl -L {SSHClient.ARTHAS_BOOT_URL} -o {arthas_jar}',
            shell=True, timeout=60, check=True
        )
        return True
    except subprocess.CalledProcessError:
        return False


def _check_port_listening_local(port, container_id=None):
    """本地检查端口是否在监听"""
    try:
        if container_id:
            result = subprocess.run(
                f'docker exec {container_id} sh -c "ss -tln 2>/dev/null | grep :{port} || netstat -tln 2>/dev/null | grep :{port}"',
                shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5
            )
            return result.returncode == 0 and result.stdout.strip()
        else:
            result = subprocess.run(
                f'sh -c "ss -tln 2>/dev/null | grep :{port} || netstat -tln 2>/dev/null | grep :{port}"',
                shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5
            )
            return result.returncode == 0 and result.stdout.strip()
    except:
        return False


def _local_start_arthas_standalone(http_port, container_id=None):
    """本机启动独立模式Arthas"""
    arthas_jar = SSHClient.ARTHAS_LOCAL_PATH
    if not _check_arthas_jar_local():
        return jsonify({'success': False, 'message': '下载arthas-boot.jar失败'}), 500

    if container_id:
        subprocess.run(f'docker exec {container_id} mkdir -p /opt/arthas', shell=True, timeout=10)
        subprocess.run(f'docker cp {arthas_jar} {container_id}:{arthas_jar}', shell=True, timeout=30)
        start_cmd = f'docker exec -d {container_id} java -jar {arthas_jar} --telnet-port -1 --http-port {http_port}'
    else:
        start_cmd = f'nohup java -jar {arthas_jar} --telnet-port -1 --http-port {http_port} > /dev/null 2>&1 &'

    subprocess.run(start_cmd, shell=True, timeout=10)

    import time
    for i in range(20):
        time.sleep(2)
        if _check_port_listening_local(http_port, container_id):
            return jsonify({'success': True, 'message': f'Arthas独立模式已启动 (端口{http_port})', 'httpPort': http_port})

    return jsonify({'success': False, 'message': f'Arthas启动超时（已等待40秒），请检查端口{http_port}是否被占用'}), 500


# ===================== 容器日志 API =====================

@arthas_bp.route('/sessions/<session_id>/containers/<container_id>/logs', methods=['GET'])
@login_required
def get_container_logs(session_id, container_id):
    """获取远程容器日志（支持实时/非实时模式）"""
    with _session_lock:
        ssh = _ssh_sessions.get(session_id)
    if not ssh:
        return jsonify({'success': False, 'message': '会话不存在，请重新连接'}), 404

    if not ssh.client or not ssh.client.get_transport() or not ssh.client.get_transport().is_active():
        return jsonify({'success': False, 'message': 'SSH会话已断开，请重新连接'}), 400

    lines = request.args.get('lines', 100)
    follow = request.args.get('follow', 'false').lower() == 'true'

    if follow:
        # 实时模式：使用Streaming Response持续读取
        def generate():
            import paramiko
            try:
                ssh_cmd = f'docker logs --tail {lines} --follow {container_id}'
                stdin, stdout, stderr = ssh.client.exec_command(ssh_cmd, timeout=3600)
                while True:
                    line = stdout.readline()
                    if not line:
                        break
                    yield line
            except Exception as e:
                yield f'\n[连接断开: {str(e)}]'

        return Response(generate(), mimetype='text/plain')
    else:
        # 非实时模式：一次性读取
        cmd = f'docker logs --tail {lines} {container_id}'
        success, output, error = ssh.execute_command(cmd, timeout=30)
        if success:
            return jsonify({'success': True, 'logs': output or ''})
        return jsonify({'success': False, 'message': f'获取日志失败: {error or output}'}), 500


@arthas_bp.route('/local/containers/<container_id>/logs', methods=['GET'])
@login_required
def get_local_container_logs(container_id):
    """获取本机容器日志（支持实时/非实时模式）"""
    lines = request.args.get('lines', 100)
    follow = request.args.get('follow', 'false').lower() == 'true'

    try:
        if follow:
            # 实时模式：使用Popen持续读取
            def generate():
                try:
                    proc = subprocess.Popen(
                        f'docker logs --tail {lines} --follow {container_id}',
                        shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        universal_newlines=True
                    )
                    for line in proc.stdout:
                        yield line
                except Exception as e:
                    yield f'\n[连接断开: {str(e)}]'

            return Response(generate(), mimetype='text/plain')
        else:
            # 非实时模式：一次性读取
            result = subprocess.run(
                f'docker logs --tail {lines} {container_id}',
                shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=30
            )
            if result.returncode == 0:
                return jsonify({'success': True, 'logs': result.stdout or ''})
            return jsonify({'success': False, 'message': result.stderr or '获取日志失败'}), 500
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500