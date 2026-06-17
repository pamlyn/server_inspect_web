"""
SSH 远程执行模块
用于在远程服务器上执行命令、部署文件，以及Arthas相关操作
"""

import paramiko
import os
import time
from typing import Dict, Tuple, Optional, List


class SSHClient:
    """SSH 客户端封装"""

    ARTHAS_BOOT_URL = 'https://arthas.aliyun.com/arthas-boot.jar'
    ARTHAS_LOCAL_PATH = '/opt/arthas/arthas-boot.jar'
    ARTHAS_DEFAULT_PORT = 8563

    def __init__(self):
        self.client = None

    def connect(self, host: str, port: int = 22, username: str = 'root',
                password: str = None, private_key_path: str = None) -> Tuple[bool, str]:
        """连接到远程服务器"""
        try:
            self.client = paramiko.SSHClient()
            self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

            if private_key_path and os.path.exists(private_key_path):
                private_key = paramiko.RSAKey.from_private_key_file(private_key_path)
                self.client.connect(host, port, username, pkey=private_key)
            elif password:
                self.client.connect(host, port, username, password)
            else:
                return False, "请提供密码或私钥路径"

            return True, "连接成功"
        except Exception as e:
            return False, str(e)

    def execute_command(self, command: str, sudo: bool = False, timeout: int = 300) -> Tuple[bool, str, str]:
        """执行命令"""
        if not self.client:
            return False, "", "未建立连接"

        # 检查连接是否仍然活跃
        if not self.client.get_transport() or not self.client.get_transport().is_active():
            return False, "", "SSH连接已断开"

        try:
            if sudo:
                command = f"sudo {command}"

            stdin, stdout, stderr = self.client.exec_command(command, timeout=timeout)
            output = stdout.read().decode('utf-8', errors='ignore')
            error = stderr.read().decode('utf-8', errors='ignore')

            if stdout.channel.exit_status_ready():
                exit_status = stdout.channel.recv_exit_status()
                if exit_status == 0:
                    return True, output.strip(), error.strip()
                else:
                    full_output = output.strip()
                    if error.strip():
                        if full_output:
                            full_output += "\n" + error.strip()
                        else:
                            full_output = error.strip()
                    return False, full_output, error.strip()
            else:
                return False, "", "命令执行超时"
        except paramiko.SSHException as e:
            return False, "", f"SSH连接异常: {str(e)}"
        except Exception as e:
            return False, "", f"执行异常: {str(e)}"

    def upload_file(self, local_path: str, remote_path: str) -> Tuple[bool, str]:
        """上传文件到远程服务器"""
        if not self.client:
            return False, "未建立连接"

        try:
            sftp = self.client.open_sftp()
            sftp.put(local_path, remote_path)
            sftp.close()
            return True, "上传成功"
        except Exception as e:
            return False, str(e)

    def download_file(self, remote_path: str, local_path: str) -> Tuple[bool, str]:
        """从远程服务器下载文件"""
        if not self.client:
            return False, "未建立连接"

        try:
            sftp = self.client.open_sftp()
            sftp.get(remote_path, local_path)
            sftp.close()
            return True, "下载成功"
        except Exception as e:
            return False, str(e)

    def close(self):
        """关闭连接"""
        if self.client:
            self.client.close()

    # ===================== Arthas相关方法 =====================

    def list_java_processes(self) -> Tuple[bool, List[Dict]]:
        """列出远程服务器上的Java进程（多方法检测）"""
        processes = []
        seen_pids = set()

        # 方法1: jps（JDK自带工具，最准确）
        success, output, _ = self.execute_command('jps -lV 2>/dev/null')
        if success and output.strip():
            for line in output.strip().split('\n'):
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
            success, output, _ = self.execute_command("ps -eo pid,comm --no-headers | awk '$2==\"java\"'")
            if success and output.strip():
                for line in output.strip().split('\n'):
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
            success, output, _ = self.execute_command('ps -eo pid,args --no-headers 2>/dev/null | grep -i java | grep -v grep')
            if success and output.strip():
                for line in output.strip().split('\n'):
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

        return True, processes

    def check_arthas_running(self, port: int = 8563) -> Tuple[bool, str]:
        """检测远程服务器上Arthas是否已运行"""
        success, output, error = self.execute_command(
            f'curl -s -o /dev/null -w "%{{http_code}}" http://localhost:{port}/api 2>/dev/null || echo "unreachable"',
            timeout=10
        )
        if success and '200' in output:
            return True, f'Arthas已在端口{port}运行'
        return False, 'Arthas未运行'

    def download_arthas(self) -> Tuple[bool, str]:
        """在远程服务器上下载 arthas-boot.jar（自动安装）"""
        # 先检查是否已存在
        success, output, _ = self.execute_command(f'ls -la {self.ARTHAS_LOCAL_PATH} 2>/dev/null')
        if success and output:
            return True, 'arthas-boot.jar已存在'

        # 创建目录并下载
        cmds = [
            f'mkdir -p /opt/arthas',
            f'curl -L {self.ARTHAS_BOOT_URL} -o {self.ARTHAS_LOCAL_PATH} 2>/dev/null',
        ]
        for cmd in cmds:
            success, output, error = self.execute_command(cmd, timeout=60)
            if not success:
                return False, f'下载Arthas失败: {error or output}'

        # 验证下载成功
        success, output, _ = self.execute_command(f'ls -la {self.ARTHAS_LOCAL_PATH} 2>/dev/null')
        if success and output:
            return True, 'Arthas下载成功'
        return False, 'Arthas下载后验证失败'

    def start_arthas_standalone(self, port: int = 8563,
                                docker_container: str = None) -> Tuple[bool, str]:
        """启动独立模式的Arthas（不attach到任何进程）

        支持在主机或Docker容器内启动独立的Arthas服务。
        """
        jar_ok, jar_msg = self.download_arthas()
        if not jar_ok:
            return False, f'准备Arthas失败: {jar_msg}'

        if docker_container:
            check_cmd = f'docker exec {docker_container} ls {self.ARTHAS_LOCAL_PATH} 2>/dev/null'
            success, output, _ = self.execute_command(check_cmd, timeout=10)
            if not success or not output.strip():
                cp_cmd = f'docker cp {self.ARTHAS_LOCAL_PATH} {docker_container}:{self.ARTHAS_LOCAL_PATH}'
                success, output, error = self.execute_command(cp_cmd, timeout=30)
                if not success:
                    mkdir_cmd = f'docker exec {docker_container} mkdir -p /opt/arthas'
                    self.execute_command(mkdir_cmd, timeout=10)
                    success, output, error = self.execute_command(cp_cmd, timeout=30)
                    if not success:
                        return False, f'复制Arthas到容器失败: {error or output}'

            start_cmd = (
                f'docker exec -d {docker_container} java -jar {self.ARTHAS_LOCAL_PATH}'
                f' --telnet-port -1 --http-port {port}'
            )
        else:
            start_cmd = (
                f'nohup java -jar {self.ARTHAS_LOCAL_PATH}'
                f' --telnet-port -1 --http-port {port} > /dev/null 2>&1 &'
            )

        success, output, error = self.execute_command(start_cmd, timeout=10)

        for i in range(20):
            time.sleep(2)
            if self._check_port_listening(port, docker_container):
                if docker_container:
                    return True, f'Arthas独立模式已在容器{docker_container}内启动 (端口{port})'
                return True, f'Arthas独立模式已启动 (端口{port})'

        return False, f'Arthas独立模式启动超时（已等待40秒），请检查端口{port}是否被占用'

    def _check_port_listening(self, port: int, docker_container: str = None) -> bool:
        """检查端口是否在监听状态（比API检查更可靠）"""
        try:
            if docker_container:
                check_cmd = (
                    f'docker exec {docker_container} sh -c '
                    f'"ss -tln 2>/dev/null | grep :{port} || netstat -tln 2>/dev/null | grep :{port}"'
                )
                success, output, _ = self.execute_command(check_cmd, timeout=5)
                return success and output.strip()
            else:
                check_cmd = (
                    f'sh -c "ss -tln 2>/dev/null | grep :{port} || netstat -tln 2>/dev/null | grep :{port}"'
                )
                success, output, _ = self.execute_command(check_cmd, timeout=5)
                return success and output.strip()
        except:
            return False

    def start_arthas(self, pid: int, port: int = 8563,
                     docker_container: str = None) -> Tuple[bool, str]:
        """在远程服务器启动Arthas并attach到指定PID

        支持主机进程和Docker容器内进程两种模式。
        如果arthas-boot.jar不存在，会自动下载。
        """
        jar_ok, jar_msg = self.download_arthas()
        if not jar_ok:
            return False, f'准备Arthas失败: {jar_msg}'

        if docker_container:
            check_cmd = f'docker exec {docker_container} ls {self.ARTHAS_LOCAL_PATH} 2>/dev/null'
            success, output, _ = self.execute_command(check_cmd, timeout=10)
            if not success or not output.strip():
                cp_cmd = f'docker cp {self.ARTHAS_LOCAL_PATH} {docker_container}:{self.ARTHAS_LOCAL_PATH}'
                success, output, error = self.execute_command(cp_cmd, timeout=30)
                if not success:
                    mkdir_cmd = f'docker exec {docker_container} mkdir -p /opt/arthas'
                    self.execute_command(mkdir_cmd, timeout=10)
                    success, output, error = self.execute_command(cp_cmd, timeout=30)
                    if not success:
                        return False, f'复制Arthas到容器失败: {error or output}'

            # 容器模式：使用docker exec -d在容器内启动，attach到PID
            start_cmd = (
                f'docker exec -d {docker_container} java -jar {self.ARTHAS_LOCAL_PATH}'
                f' {pid} --telnet-port 3{port} --http-port {port}'
            )
        else:
            # 主机模式：PID作为位置参数
            start_cmd = (
                f'nohup java -jar {self.ARTHAS_LOCAL_PATH} {pid}'
                f' --telnet-port 3{port} --http-port {port}'
                f' > /dev/null 2>&1 &'
            )

        success, output, error = self.execute_command(start_cmd, timeout=15)

        # 轮询检查Arthas是否成功启动（20次 × 2秒 = 40秒等待）
        for i in range(20):
            time.sleep(2)
            if self._check_port_listening(port, docker_container):
                if docker_container:
                    return True, f'Arthas已在容器{docker_container}内启动 (PID {pid}, 端口{port})'
                return True, f'Arthas已启动 (PID {pid}, 端口{port})'

        return False, f'Arthas启动超时（已等待40秒），请检查Java进程{pid}是否有效'

    def stop_arthas(self, pid: int, port: int = 8563,
                    docker_container: str = None) -> Tuple[bool, str]:
        """停止远程服务器上的Arthas"""
        if docker_container:
            # 容器模式：在容器内查找并杀死Arthas进程
            find_cmd = (
                f'docker exec {docker_container} ps -eo pid,args'
                f' | grep arthas | grep -v grep | awk \'{{print $1}}\''
            )
            success, output, _ = self.execute_command(find_cmd, timeout=10)
            if success and output.strip():
                arthas_pids = output.strip().split('\n')
                for apid in arthas_pids:
                    kill_cmd = f'docker exec {docker_container} kill {apid.strip()}'
                    self.execute_command(kill_cmd, timeout=10)
                # 验证停止成功
                time.sleep(1)
                check_cmd = (
                    f'docker exec {docker_container} curl -s -o /dev/null'
                    f' -w "%{{http_code}}" http://localhost:{port}/api 2>/dev/null'
                )
                success, output, _ = self.execute_command(check_cmd, timeout=10)
                if not success or '200' not in output:
                    return True, f'容器{docker_container}内Arthas已停止'
                return False, 'Arthas停止可能未成功'
            else:
                return True, f'容器{docker_container}内未找到Arthas进程'
        else:
            # 主机模式
            find_cmd = (
                f'ps -eo pid,args | grep arthas | grep -v grep'
                f' | grep -- "--attach-pid {pid}" | awk \'{{print $1}}\''
            )
            success, output, _ = self.execute_command(find_cmd, timeout=10)
            if success and output.strip():
                arthas_pids = output.strip().split('\n')
                for apid in arthas_pids:
                    kill_cmd = f'kill {apid.strip()}'
                    self.execute_command(kill_cmd, timeout=10)
                time.sleep(1)
                running, _ = self.check_arthas_running(port)
                if not running:
                    return True, f'Arthas已停止 (PID {pid})'
                return False, 'Arthas停止可能未成功'
            else:
                # 没找到精确匹配，尝试更宽泛的查找
                find_cmd2 = 'ps -eo pid,args | grep arthas-boot | grep -v grep | awk \'{{print $1}}\''
                success, output, _ = self.execute_command(find_cmd2, timeout=10)
                if success and output.strip():
                    arthas_pids = output.strip().split('\n')
                    for apid in arthas_pids:
                        self.execute_command(f'kill {apid.strip()}', timeout=10)
                    time.sleep(1)
                    running, _ = self.check_arthas_running(port)
                    if not running:
                        return True, 'Arthas已停止'
                    return False, 'Arthas停止可能未成功'
                return True, '未找到Arthas进程（可能已停止）'

    def list_docker_containers(self) -> Tuple[bool, List[Dict]]:
        """列出远程服务器上的Docker容器"""
        success, output, error = self.execute_command(
            'docker ps --format \'{{.Names}}\t{{.Image}}\t{{.Status}}\' 2>/dev/null',
            timeout=10
        )
        if not success and not output:
            # Docker可能未安装
            return False, []

        containers = []
        for line in output.strip().split('\n'):
            if not line.strip():
                continue
            parts = line.strip().split('\t')
            if len(parts) >= 2:
                containers.append({
                    'name': parts[0],
                    'image': parts[1],
                    'status': parts[2] if len(parts) > 2 else ''
                })
        return True, containers

    def list_container_java_processes(self, container: str) -> Tuple[bool, List[Dict]]:
        """列出Docker容器内的Java进程（多方法检测）"""
        processes = []
        seen_pids = set()

        # 方法1: jps
        cmd = f'docker exec {container} jps -lV 2>/dev/null'
        success, output, _ = self.execute_command(cmd, timeout=10)
        if success and output.strip():
            for line in output.strip().split('\n'):
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

        # 方法2: ps -eo pid,comm (COMMAND列直接显示java)
        if not processes:
            cmd = f"docker exec {container} sh -c \"ps -eo pid,comm 2>/dev/null | awk '$2==java'\""
            success, output, _ = self.execute_command(cmd, timeout=10)
            if success and output.strip():
                for line in output.strip().split('\n'):
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

        # 方法3: 带完整参数的ps
        if not processes:
            cmd = f"docker exec {container} sh -c \"ps -eo pid,args 2>/dev/null | grep -i java | grep -v grep\""
            success, output, _ = self.execute_command(cmd, timeout=10)
            if success and output.strip():
                for line in output.strip().split('\n'):
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

        return True, processes