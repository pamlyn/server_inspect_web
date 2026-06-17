# 钉钉通知模块
import requests
import time
import hmac
import hashlib
import base64
import json

class DingTalkNotifier:
    """钉钉通知器"""

    def __init__(self):
        # 从 config_mgmt 模块获取配置（模块化架构的中心配置）
        from modules.config_mgmt.helpers import get_config
        dingtalk_cfg = get_config('dingtalk') or {}
        self.enabled = dingtalk_cfg.get("enabled", False)
        # 兼容旧配置，确保webhooks是一个列表且不包含重复地址
        if "webhooks" in dingtalk_cfg:
            self.webhooks = list(set(dingtalk_cfg["webhooks"]))
        else:
            webhook = dingtalk_cfg.get("webhook", "")
            self.webhooks = [webhook] if webhook else []
        self.secret = dingtalk_cfg.get("secret", "")
        self.show_details = dingtalk_cfg.get("show_details", True)
        self.project_name = get_config('projectName') or '服务器巡检系统'
    
    def get_sign(self):
        """生成签名"""
        if not self.secret:
            return ""
        
        timestamp = str(int(time.time() * 1000))
        secret_enc = self.secret.encode('utf-8')
        string_to_sign = f"{timestamp}\n{self.secret}"
        string_to_sign_enc = string_to_sign.encode('utf-8')
        hmac_code = hmac.new(secret_enc, string_to_sign_enc, digestmod=hashlib.sha256).digest()
        sign = base64.b64encode(hmac_code).decode('utf-8')
        return f"&timestamp={timestamp}&sign={sign}"
    
    def send_message(self, title, content, server_url=None):
        """发送消息"""
        if not self.enabled or not self.webhooks:
            return False
        
        import json
        
        all_success = True
        
        # 遍历所有webhook地址并发送通知
        for webhook in self.webhooks:
            if not webhook:
                continue
            
            url = f"{webhook}{self.get_sign()}"
            headers = {'Content-Type': 'application/json'}
            
            # 检查内容长度，如果过长使用ActionCard
            if len(content) > 2000:  # 阈值可以根据实际情况调整
                # 提取关键告警信息作为摘要
                summary = """
## 🚨 关键告警信息

"""
                
                # 提取紧急和警告异常
                lines = content.split('\n')
                in_critical = False
                in_warning = False
                
                for line in lines:
                    if '### 🔴' in line:
                        in_critical = True
                        in_warning = False
                        summary += line + '\n'
                    elif '### 🟠' in line:
                        in_critical = False
                        in_warning = True
                        summary += line + '\n'
                    elif ('### ℹ️' in line or '### 📊' in line):
                        in_critical = False
                        in_warning = False
                    elif (in_critical or in_warning) and line.startswith('> '):
                        summary += line + '\n'
                
                # 添加查看完整内容的按钮
                summary += "\n请点击下方按钮查看完整巡检报告"
                
                # 使用ActionCard消息
                data = {
                    "msgtype": "actionCard",
                    "actionCard": {
                        "title": title,
                        "text": summary,
                        "btnOrientation": "0",
                        "btns": [
                            {
                                "title": "查看完整报告",
                                "actionURL": server_url or "http://localhost:5000"  # 动态服务器地址
                            }
                        ]
                    }
                }
            else:
                # 使用普通markdown消息
                data = {
                    "msgtype": "markdown",
                    "markdown": {
                        "title": title,
                        "text": content
                    }
                }
            
            try:
                response = requests.post(url, headers=headers, data=json.dumps(data), timeout=10)
                result = response.json()
                if result.get("errcode") != 0:
                    all_success = False
                    print(f"发送钉钉通知到 {webhook} 失败: {result.get('errmsg', '未知错误')}")
                else:
                    print(f"发送钉钉通知到 {webhook} 成功")
            except Exception as e:
                all_success = False
                print(f"发送钉钉通知到 {webhook} 失败: {e}")
        
        return all_success
    
    def send_inspection_report(self, inspection_results, notification_type="scheduled", inspection_item_name=None):
        """发送巡检报告"""
        # 动态获取最新的配置
        from modules.config_mgmt.helpers import get_config
        dingtalk_cfg = get_config('dingtalk') or {}
        self.enabled = dingtalk_cfg.get("enabled", False)
        if "webhooks" in dingtalk_cfg:
            self.webhooks = list(set(dingtalk_cfg["webhooks"]))
        else:
            webhook = dingtalk_cfg.get("webhook", "")
            self.webhooks = [webhook] if webhook else []
        self.secret = dingtalk_cfg.get("secret", "")
        self.show_details = dingtalk_cfg.get("show_details", True)
        self.project_name = get_config('projectName') or '服务器巡检系统'
        
        if not self.enabled:
            return False
        
        # 检查是否有异常
        has_issues = False
        total_criticals = 0
        total_warnings = 0
        
        for category, result in inspection_results.items():
            criticals = result.get('criticals', [])
            warnings = result.get('warnings', [])
            if criticals or warnings:
                has_issues = True
                total_criticals += len(criticals)
                total_warnings += len(warnings)
        
        # 对于非日常巡检，如果没有异常则跳过通知
        if not has_issues and notification_type != "daily":
            print("无异常，跳过钉钉通知")
            return True
        
        # 生成报告内容
        if notification_type == "scheduled":
            content = f"## 🚨 {self.project_name} 定时巡检异常报告\n\n"
        elif notification_type == "real_time":
            content = f"## 🚨 {self.project_name} 实时监测异常报告\n\n"
        elif notification_type == "user" and inspection_item_name:
            content = f"## 🚨 {self.project_name} {inspection_item_name} 异常报告\n\n"
        else:  # daily
            if has_issues:
                content = f"## 🚨 {self.project_name} 日常巡检报告\n\n"
            else:
                content = f"## 🟢 {self.project_name} 日常巡检报告\n\n"
        
        # 时间信息
        first_result = next(iter(inspection_results.values()), {})
        if first_result:
            # 使用整体时间信息（如果存在）
            if 'overall_start_time' in first_result:
                content += f"- **开始时间**: {first_result.get('overall_start_time', 'N/A')}\n"
                content += f"- **结束时间**: {first_result.get('overall_end_time', 'N/A')}\n"
                content += f"- **耗时**: {first_result.get('overall_duration', 'N/A')}\n"
            else:
                content += f"- **开始时间**: {first_result.get('start_time', 'N/A')}\n"
                content += f"- **结束时间**: {first_result.get('end_time', 'N/A')}\n"
                content += f"- **耗时**: {first_result.get('duration', 'N/A')}\n"
        
        # 异常统计
        content += f"- **紧急异常**: {total_criticals} 项\n"
        content += f"- **警告异常**: {total_warnings} 项\n\n"
        
        # 异常信息
        content += "## 异常详情\n\n"
        
        for category, result in inspection_results.items():
            # 检查是否是自定义脚本，如果是则使用脚本名称
            if category.startswith('custom_script_') and 'script_name' in result:
                category_name = result['script_name']
            else:
                category_name = {
                    'system_info': '系统信息',
                    'cpu': 'CPU使用率',
                    'memory': '内存使用情况',
                    'swap': '交换分区使用情况',
                    'disk': '磁盘使用情况',
                    'disk_io': '磁盘IO情况',
                    'processes': '进程状态',
                    'slow_sql': '慢SQL检查',
                    'database': '数据库检查',
                    'network': '网络状态',
                    'worker_output_with_color_size': '工人产量与报工明细稽核（含颜色尺码）',
                    'worker_output_without_color_size': '工人产量与报工明细稽核（不含颜色尺码）',
                    'worker_output_sfd': '工人产量与报工明细数据稽核(sfd)',
                    'mes_hanging': 'MES报工明细与吊挂报工明细稽核'
                }.get(category, category)
            
            criticals = result.get('criticals', [])
            warnings = result.get('warnings', [])
            info = result.get('info', [])
            slow_sqls = result.get('slow_sqls', [])
            normals = result.get('normals', [])
            
            # 检查是否有异常信息
            category_has_issues = bool(criticals or warnings)
            
            if category_has_issues:
                if criticals:
                    content += f"### 🔴 {category_name} (紧急)\n"
                    for msg in criticals:
                        content += f"> {msg}\n"
                    content += "\n"
                
                if warnings:
                    content += f"### 🟠 {category_name} (警告)\n"
                    for msg in warnings:
                        content += f"> {msg}\n"
                    content += "\n"
            
            # 对于工人产量和报工明细相关的检查，总是显示详细信息，包括稽核日期范围
            if category in ['worker_output_with_color_size', 'worker_output_without_color_size', 'worker_output_sfd', 'mes_hanging']:
                # 确保显示标题
                if not category_has_issues:
                    content += f"### 🟢 {category_name} (正常)\n"
                # 过滤掉开始稽核的信息，只显示关键信息
                relevant_info = []
                if info:
                    relevant_info = [msg for msg in info if not '开始工人产量与报工明细稽核' in msg and not '开始MES报工明细与吊挂报工明细稽核' in msg and not '==========' in msg]
                if relevant_info:
                    for msg in relevant_info:
                        content += f"> {msg}\n"
                    content += "\n"
                else:
                    # 即使没有info信息，也显示正常状态
                    content += "> 一切正常\n"
                    content += "\n"
            elif category_has_issues:
                # 显示相关的详细信息
                if self.show_details and info:
                    content += f"### ℹ️ {category_name} 详细信息\n"
                    # 显示所有相关信息，不限制长度
                    relevant_info = [msg for msg in info if any(keyword in msg for keyword in ['CPU使用率', '内存使用率', '磁盘使用率', '慢SQL', '进程', '负载', 'IO等待', '核心数', '平均使用率', '最高使用率', '负载情况', '磁盘使用', '内存使用', '交换分区', '网络连接', '进程状态', '僵尸进程', '资源占用TOP10'])]
                    if relevant_info:
                        for msg in relevant_info:
                            content += f"> {msg}\n"
                        content += "\n"
                
                # 显示慢SQL信息
                if self.show_details and slow_sqls and category == 'slow_sql':
                    content += f"### 📊 慢SQL详情\n"
                    if slow_sqls:
                        for i, sql in enumerate(slow_sqls, 1):
                            content += f"> **[{i}]** {sql}\n"
                        content += "\n"
            elif notification_type == "daily":
                # 对于日常巡检，显示正常信息
                content += f"### 🟢 {category_name} (正常)\n"
                # 对于工人产量和报工明细相关的检查，总是显示详细信息，包括稽核日期范围
                if category in ['worker_output_with_color_size', 'worker_output_without_color_size', 'worker_output_sfd', 'mes_hanging']:
                    # 过滤掉开始稽核的信息，只显示关键信息
                    relevant_info = []
                    if info:
                        relevant_info = [msg for msg in info if not '开始工人产量与报工明细稽核' in msg and not '==========' in msg]
                    if relevant_info:
                        for msg in relevant_info:
                            content += f"> {msg}\n"
                        content += "\n"
                    else:
                        # 即使没有info信息，也显示正常状态
                        content += "> 一切正常\n"
                        content += "\n"
                elif normals:
                    for msg in normals[:5]:  # 只显示前5条正常信息
                        content += f"> {msg}\n"
                    content += "\n"
                else:
                    content += "> 一切正常\n"
                    content += "\n"
            else:
                # 对于非日常巡检且无异常的情况，对于工人产量和报工明细相关的检查，也显示详细信息
                if category in ['worker_output_with_color_size', 'worker_output_without_color_size', 'worker_output_sfd', 'mes_hanging']:
                    content += f"### 🟢 {category_name} (正常)\n"
                    # 过滤掉开始稽核的信息，只显示关键信息
                    relevant_info = []
                    if info:
                        relevant_info = [msg for msg in info if not '开始工人产量与报工明细稽核' in msg and not '==========' in msg]
                    if relevant_info:
                        for msg in relevant_info:
                            content += f"> {msg}\n"
                        content += "\n"
                    else:
                        # 即使没有info信息，也显示正常状态
                        content += "> 一切正常\n"
                        content += "\n"
        
        # 使用全局的has_issues变量，而不是循环内部的局部变量
        if has_issues:
            content += "## 请及时处理异常情况！"
        else:
            content += "## 所有检查项目均正常！"
        
        # 生成标题
        if notification_type == "scheduled":
            title = f"{self.project_name} 定时巡检异常"
        elif notification_type == "real_time":
            title = f"{self.project_name} 实时监测异常"
        elif notification_type == "user" and inspection_item_name:
            title = f"{self.project_name} {inspection_item_name} 异常"
        elif notification_type == "user":
            title = f"{self.project_name} 用户的巡检项 异常"
        else:  # daily
            if has_issues:
                title = f"{self.project_name} 日常巡检异常"
            else:
                title = f"{self.project_name} 日常巡检正常"
        
        # 获取服务器URL
        from modules.config_mgmt.helpers import get_config
        server_url = get_config('serverUrl')
        
        return self.send_message(title, content, server_url)

# 全局通知器实例
dingtalk_notifier = DingTalkNotifier()
