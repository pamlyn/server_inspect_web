# 配置文件

# 项目配置
PROJECT_NAME = "服务器巡检系统"

# 定时巡检配置
SCHEDULER_CONFIG = {
    "enabled": True,  # 是否启用定时巡检
    "cron": "*/20 * * * *"  # 每20分钟执行一次
}

# 钉钉机器人配置
DINGTALK_CONFIG = {
    "enabled": True,  # 是否启用钉钉通知
    "webhooks": ["https://oapi.dingtalk.com/robot/send?access_token=7d68d7d6103bd0493500f1ca538bc166b82013947dd3f785652f7b31178e3a8d"],  # 钉钉机器人webhook地址列表
    "secret": "",  # 钉钉机器人secret（可选）
    "show_details": True  # 是否显示异常详细信息
}

# 巡检项配置
INSPECTION_ITEMS = {
    "system_info": True,  # 系统信息
    "cpu": True,  # CPU
    "memory": True,  # 内存
    "swap": True,  # 交换分区
    "disk": True,  # 磁盘
    "disk_io": True,  # 磁盘IO
    "processes": True,  # 进程
    "slow_sql": True,  # 慢SQL
    "slow_sql_deduplicate": True,  # 慢SQL去重
    "database": True,  # 数据库
    "network": True  # 网络
}

# 异常阈值配置
THRESHOLDS = {
    "cpu": {
        "warning": 80,  # CPU使用率警告阈值（%）
        "critical": 90  # CPU使用率紧急阈值（%）
    },
    "memory": {
        "warning": 80,  # 内存使用率警告阈值（%）
        "critical": 90  # 内存使用率紧急阈值（%）
    },
    "disk": {
        "warning": 80,  # 磁盘使用率警告阈值（%）
        "critical": 90  # 磁盘使用率紧急阈值（%）
    },
    "disk_free": {
        "warning": 30,  # 磁盘剩余空间警告阈值（GB）
        "critical": 20  # 磁盘剩余空间紧急阈值（GB）
    },
    "swap": {
        "warning": 30,  # 交换分区使用率警告阈值（%）
        "critical": 50  # 交换分区使用率紧急阈值（%）
    },
    "slow_sql": {
        "warning": 1,  # 慢SQL数量警告阈值
        "critical": 5  # 慢SQL数量紧急阈值
    }
}

# 实时监控配置
REAL_TIME_MONITORING = {
    "enabled": False,  # 是否启用实时监控
    "interval": 30,  # 实时监控间隔（秒）
    "items": {
        "cpu": True,  # CPU实时监控
        "memory": True,  # 内存实时监控
        "disk": True,  # 磁盘实时监控
        "disk_io": False,  # 磁盘IO实时监控
        "swap": True,  # 交换分区实时监控
        "processes": False,  # 进程实时监控
        "slow_sql": False,  # 慢SQL实时监控
        "worker_output_with_color_size": True,  # 工人产量与报工明细稽核（含颜色尺码）
        "worker_output_without_color_size": True,  # 工人产量与报工明细稽核（不含颜色尺码）
        "worker_output_sfd": True,  # 工人产量与报工明细数据稽核(sfd)
        "mes_hanging": True  # MES报工明细与吊挂报工明细稽核
    },
    "notification": {
        "enabled": True,  # 是否启用实时通知
        "alert_levels": ["warning", "critical"],  # 通知的告警级别
        "dingtalk": True,  # 是否通过钉钉通知
        "cooldown_period": 300  # 通知冷却期（秒），避免频繁通知
    },
    "performance": {
        "max_concurrent_checks": 3,  # 最大并发检查数
        "timeout": 10,  # 检查超时时间（秒）
        "resource_limit": {
            "cpu_percent": 15,  # 监控进程CPU使用率限制（%）
            "memory_mb": 200  # 监控进程内存使用限制（MB）
        }
    }
}

# 数据稽查日期配置
INSPECTION_DATE_CONFIG = {
    "enabled": True,  # 是否启用日期配置
    "options": {
        "yesterday": True,  # 昨日
        "today": True,  # 今日
        "current_month_to_yesterday": False,  # 当前月到昨天
        "current_month_to_today": False,  # 当前月到今天
        "custom": False  # 自定义日期范围
    },
    "custom_date_range": {
        "start_date": "",  # 开始日期
        "end_date": ""  # 结束日期
    }
}

# 数据库连接配置
DATABASE_CONFIG = {
    "mes": {
        "type": "postgresql",  # postgresql 或 mysql
        "host": "localhost",
        "port": 5432,
        "user": "postgres",
        "password": "password",
        "database": "mes"
    },
    "hanging": {
        "type": "mysql",
        "host": "localhost",
        "port": 3306,
        "user": "root",
        "password": "password",
        "database": "hanging"
    }
}
