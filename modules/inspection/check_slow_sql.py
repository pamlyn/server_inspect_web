from modules.inspection.models import InspectionResult
from modules.inspection.helpers import run_command
from modules.config_mgmt.helpers import get_config

def check_slow_sql(deduplicate=True):
    """检查慢SQL"""
    result = InspectionResult()
    result.add_info("开始慢SQL检查")
    result.add_info(f"去重模式: {'开启' if deduplicate else '关闭'}")

    THRESHOLDS = get_config('thresholds')

    # 检查Docker容器中的数据库 直接认为Docker已安装，因为我们在Docker容器中运行
    docker_available = True
    docker_status = "Docker已安装"
    result.add_info(f"Docker检查结果: {docker_status}")

    # 检查docker命令是否存在
    docker_cmd_output = run_command("command -v docker")
    docker_cmd_exists = docker_cmd_output[0]
    # 修复docker命令存在性检查
    docker_cmd_exists = bool(docker_cmd_exists.strip())

    if docker_available:
        result.add_info("检查Docker容器中的数据库...")
        # 检查docker命令是否存在
        if docker_cmd_exists:
            # 检查MySQL容器
            mysql_containers, _, _ = run_command("docker ps --filter 'image=*mysql*' --filter 'image=*mariadb*' --format '{{.Names}}' 2>&1")
            mysql_containers = mysql_containers.strip()
            result.add_info(f"MySQL容器检查结果: {mysql_containers}")
            if mysql_containers:
                result.add_info(f"发现MySQL/MariaDB容器: {mysql_containers}")
                for container in mysql_containers.split('\n'):
                    if container:
                        result.add_info(f"检查容器 {container} 中的MySQL慢SQL...")
                        # 跳过容器状态检查，直接查询慢日志
                        result.add_info(f"直接查询容器 {container} 的慢日志")
                        # 检查容器中的慢查询配置
                        mysql_config, _, _ = run_command(f"timeout 10s docker exec -i {container} mysql -e 'SHOW VARIABLES LIKE \"slow_query_log\"; SHOW VARIABLES LIKE \"long_query_time\";' 2>&1")
                        result.add_info(f"MySQL配置查询结果: {mysql_config}")
                        if mysql_config:
                            result.add_info(mysql_config.strip())
                            # 检查慢查询日志
                            mysql_log_dir, _, _ = run_command(f"timeout 10s docker exec -i {container} ls -la /var/log/mysql/ 2>&1")
                            result.add_info(f"MySQL日志目录查询结果: {mysql_log_dir}")
                            if mysql_log_dir:
                                result.add_info("MySQL日志目录:")
                                result.add_info(mysql_log_dir.strip())
                        else:
                            result.add_warning(f"无法连接到MySQL容器 {container}，跳过慢SQL检查")

            # 检查PostgreSQL容器
            result.add_info("执行docker ps命令查看所有容器...")
            all_containers, _, _ = run_command("timeout 5s docker ps 2>&1 || echo ''")
            result.add_info("所有容器信息:")
            result.add_info(all_containers.strip())
            pg_containers, _, _ = run_command("timeout 5s docker ps --format '{{.Names}} {{.Image}}' 2>&1 | grep -i postgres 2>&1 | awk '{print $1}' || echo ''")
            pg_containers = pg_containers.strip()
            result.add_info(f"PostgreSQL容器列表: {pg_containers}")
            if pg_containers:
                result.add_info(f"发现PostgreSQL容器: {pg_containers}")
                for container in pg_containers.split('\n'):
                    if container:
                        result.add_info(f"检查容器 {container} 中的PostgreSQL慢SQL...")
                        # 跳过容器状态检查，直接查询慢日志
                        result.add_info(f"直接查询容器 {container} 的慢日志")
                        # 直接查询Docker日志中的慢SQL，不需要psql命令
                        result.add_info("直接查询Docker日志中的慢SQL:")

                        # 统计慢SQL数量（通过统计duration:出现的次数）
                        slow_sql_count = run_command(f"docker logs {container} 2>&1 | grep -c 'duration:' 2>/dev/null || echo '0'")[0].strip()
                        if slow_sql_count and slow_sql_count.isdigit() and int(slow_sql_count) > 0:
                            result.add_info(f"容器 {container} PostgreSQL慢SQL数量: {slow_sql_count}")

                        slow_sqls, _, _ = run_command(f"docker logs {container} 2>&1 | awk '/duration:/ {{ in_sql=1; print }} in_sql && !/^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}/ {{ print }} /^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}/ && in_sql && !/duration:/ {{ in_sql=0 }}' 2>&1 || echo ''")
                        result.add_info(f"慢SQL查询结果: {slow_sqls}")
                        if slow_sqls.strip():
                            result.add_info("慢SQL记录:")
                            result.add_info(slow_sqls.strip())
                            # 将慢SQL添加到结果中 - 合并多行SQL为一条记录
                            lines = slow_sqls.strip().split('\n')
                            current_sql = ""
                            for line in lines:
                                if line.strip():
                                    # 检查是否是新的慢SQL记录（包含duration:）
                                    if 'duration:' in line:
                                        # 保存之前的SQL记录
                                        if current_sql:
                                            result.slow_sqls.append(f"[PostgreSQL容器 {container}] {current_sql}")
                                        current_sql = line
                                    else:
                                        # 继续追加到当前SQL记录
                                        current_sql += "\n" + line
                            # 保存最后一条SQL记录
                            if current_sql:
                                result.slow_sqls.append(f"[PostgreSQL容器 {container}] {current_sql}")
                        else:
                            result.add_normal("未发现慢SQL")
        else:
            result.add_info("Docker socket存在但未安装docker命令，无法检查容器中的数据库")
    else:
        result.add_info("未找到Docker或Docker socket，跳过容器中的数据库检查")

    # 去重处理
    if deduplicate and result.slow_sqls:
        result.add_info("开始对慢SQL进行去重处理...")
        original_count = len(result.slow_sqls)

        # 提取SQL语句的核心部分进行去重
        unique_sqls = {}
        for sql in result.slow_sqls:
            # 提取SQL语句部分
            # 对于PostgreSQL: 查找 'statement: ' 或 'execute: ' 后面的内容
            # 对于MySQL: 查找SQL语句部分
            sql_core = None

            # 处理PostgreSQL格式
            if 'statement: ' in sql:
                sql_core = sql.split('statement: ')[-1].strip()
            elif 'execute: ' in sql:
                sql_core = sql.split('execute: ')[-1].strip()
            # 处理MySQL格式（简单处理，实际可能需要更复杂的逻辑）
            elif 'Query_time' in sql:
                # 提取SQL语句部分
                parts = sql.split('\n')
                for part in parts:
                    if not part.startswith('#') and not part.startswith('Time:') and not part.startswith('User@Host:') and part.strip():
                        sql_core = part.strip()
                        break

            # 如果提取到了核心SQL，使用它作为键
            if sql_core:
                # 保留第一条出现的记录
                if sql_core not in unique_sqls:
                    unique_sqls[sql_core] = sql
            else:
                # 如果无法提取核心SQL，使用完整记录作为键
                if sql not in unique_sqls:
                    unique_sqls[sql] = sql

        # 转换回列表
        result.slow_sqls = list(unique_sqls.values())
        deduplicated_count = len(result.slow_sqls)
        removed_count = original_count - deduplicated_count
        result.add_info(f"去重完成：从 {original_count} 条慢SQL中去除了 {removed_count} 条重复记录，剩余 {deduplicated_count} 条")

        # 打印去重后的慢SQL记录
        if result.slow_sqls:
            result.add_info("去重后的慢SQL记录：")
            for i, sql in enumerate(result.slow_sqls, 1):
                result.add_info(f"{i}. {sql}")

    # 根据慢SQL数量设置状态
    total_slow_sqls = len(result.slow_sqls)
    slow_sql_thresholds = THRESHOLDS.get("slow_sql", {})
    slow_sql_warning = slow_sql_thresholds.get("warning", 5)
    slow_sql_critical = slow_sql_thresholds.get("critical", 10)

    if total_slow_sqls > slow_sql_critical:
        result.add_critical(f"发现 {total_slow_sqls} 条慢SQL，数量较多，处于紧急状态！")
    elif total_slow_sqls > slow_sql_warning:
        result.add_warning(f"发现 {total_slow_sqls} 条慢SQL，数量较多，处于预警状态")
    elif total_slow_sqls > 0:
        result.add_normal(f"发现 {total_slow_sqls} 条慢SQL，在阈值范围内")
    else:
        result.add_normal("未发现慢SQL")

    result.set_end_time()
    return result