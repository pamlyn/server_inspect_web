"""
Arthas HTTP API客户端
与Arthas服务通信的核心模块
"""

import requests
import time
from typing import Optional, Dict, List, Tuple


class ArthasClient:
    """与Arthas HTTP API通信的客户端"""

    DEFAULT_PORT = 8563
    DEFAULT_TIMEOUT = 30
    ASYNC_POLL_INTERVAL = 2
    ASYNC_MAX_WAIT = 60

    def __init__(self, host: str = 'localhost', port: int = 8563, timeout: int = 30):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.base_url = f'http://{host}:{port}/api'

    @classmethod
    def from_server_config(cls, server: Dict) -> 'ArthasClient':
        """从保存的服务器配置创建客户端"""
        host = server['host']
        port = server.get('arthas_port', cls.DEFAULT_PORT)
        if server.get('connection_mode') == 'ssh_tunnel':
            host = 'localhost'
            port = server.get('ssh_local_port', 18563)
        return cls(host=host, port=port)

    def _post(self, action: str, command: Optional[str] = None,
              job_id: Optional[int] = None) -> Dict:
        """核心HTTP请求到Arthas API"""
        payload = {'action': action}
        if command:
            payload['command'] = command
        if job_id:
            payload['jobId'] = job_id

        try:
            response = requests.post(
                self.base_url,
                json=payload,
                timeout=self.timeout
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.ConnectionError:
            return {'state': 'FAILED', 'message': f'无法连接到Arthas服务 ({self.host}:{self.port})，请确认Arthas已启动'}
        except requests.exceptions.Timeout:
            return {'state': 'FAILED', 'message': 'Arthas请求超时'}
        except Exception as e:
            return {'state': 'FAILED', 'message': str(e)}

    def exec_sync(self, command: str) -> Dict:
        """同步执行命令 (action=exec)"""
        result = self._post('exec', command=command)
        if result.get('state') == 'SUCCEEDED' and 'body' in result:
            results = result['body'].get('results', [])
            if results:
                output = results[0].get('output', '')
                return {'success': True, 'output': output, 'command': command}
        return {'success': False, 'output': result.get('message', '未知错误'), 'command': command}

    def exec_async(self, command: str) -> Dict:
        """异步执行命令 + 轮询等待结果"""
        # 启动异步命令
        result = self._post('async_exec', command=command)
        if result.get('state') != 'SUCCEEDED':
            return {'success': False, 'output': result.get('message', '异步执行失败'), 'command': command}

        body = result.get('body', {})
        job_id = body.get('jobId')
        if not job_id:
            return {'success': False, 'output': '未获取到jobId', 'command': command}

        # 轮询等待结果
        waited = 0
        while waited < self.ASYNC_MAX_WAIT:
            time.sleep(self.ASYNC_POLL_INTERVAL)
            waited += self.ASYNC_POLL_INTERVAL

            # 检查job状态
            status = self._post('exec', command='jobs')
            if status.get('state') == 'SUCCEEDED':
                results = status.get('body', {}).get('results', [])
                for r in results:
                    if r.get('jobId') == job_id and r.get('status') == 'DONE':
                        output_result = self._post('exec', command=f'jobresult {job_id}')
                        if output_result.get('state') == 'SUCCEEDED':
                            output = output_result.get('body', {}).get('results', [])
                            if output:
                                return {'success': True, 'output': output[0].get('output', ''), 'command': command}

        # 超时
        self.interrupt_job(job_id)
        return {'success': False, 'output': '异步命令执行超时', 'command': command}

    def interrupt_job(self, job_id: int) -> Dict:
        """中断异步任务"""
        return self._post('interrupt', job_id=job_id)

    def check_connection(self) -> Tuple[bool, str]:
        """检测Arthas连接是否可用"""
        result = self._post('exec', command='help')
        if result.get('state') == 'SUCCEEDED':
            return True, 'Arthas连接正常'
        return False, result.get('message', 'Arthas不可达')