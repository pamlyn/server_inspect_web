"""
Arthas 服务器连接配置管理
持久化到 config.json 的 arthasServers 字段
"""

import json
import os
from typing import List, Dict, Optional

SERVERS_CONFIG_KEY = 'arthasServers'
CONFIG_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'config.json')


class ServerManager:
    """管理Arthas服务器连接配置"""

    def list_servers(self) -> List[Dict]:
        """获取所有保存的服务器配置"""
        config = self._load_config()
        return config.get(SERVERS_CONFIG_KEY, [])

    def get_server(self, server_id: int) -> Optional[Dict]:
        """获取单个服务器配置"""
        servers = self.list_servers()
        for s in servers:
            if s.get('id') == server_id:
                return s
        return None

    def add_server(self, server_info: Dict) -> Dict:
        """新增服务器配置"""
        config = self._load_config()
        servers = config.get(SERVERS_CONFIG_KEY, [])

        # 分配ID
        server_info['id'] = max([s.get('id', 0) for s in servers], default=0) + 1
        servers.append(server_info)
        config[SERVERS_CONFIG_KEY] = servers
        self._save_config(config)
        return server_info

    def update_server(self, server_id: int, server_info: Dict) -> Optional[Dict]:
        """更新服务器配置"""
        config = self._load_config()
        servers = config.get(SERVERS_CONFIG_KEY, [])
        for i, s in enumerate(servers):
            if s.get('id') == server_id:
                server_info['id'] = server_id
                servers[i] = server_info
                config[SERVERS_CONFIG_KEY] = servers
                self._save_config(config)
                return server_info
        return None

    def delete_server(self, server_id: int) -> bool:
        """删除服务器配置"""
        config = self._load_config()
        servers = config.get(SERVERS_CONFIG_KEY, [])
        servers = [s for s in servers if s.get('id') != server_id]
        config[SERVERS_CONFIG_KEY] = servers
        self._save_config(config)
        return True

    def _load_config(self) -> Dict:
        """加载配置文件"""
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"加载配置失败: {e}")
            return {}

    def _save_config(self, config: Dict):
        """保存配置文件"""
        try:
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(config, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"保存配置失败: {e}")