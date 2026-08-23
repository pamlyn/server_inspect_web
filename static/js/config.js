/**
 * config.js — Config page JS for the Server Inspection System
 * Contains: loadConfig(), saveConfig(), reloadConfig(), scheduler config UI logic,
 * config form handling, date config validation, and cancel button logic.
 * Depends on: app.js (showToast, showConfirm)
 */

let activeConfigScope = null;
const configScopePermissions = {
    basic: 'config_basic_alert',
    inspection: 'config_inspection_strategy',
    data: 'config_data_notification',
    'custom-sql': 'config_custom_sql',
};

// ========== Load Configuration ==========

function loadConfig(scope = activeConfigScope) {
    if (!scope) return;
    fetch(`/api/config?scope=${encodeURIComponent(scope)}`)
        .then(response => response.json().then(data => ({ response, data })))
        .then(({ response, data }) => {
            if (!response.ok) throw new Error(data.error || '加载配置失败');
            document.getElementById('projectName').value = data.projectName || '';
            document.getElementById('schedulerEnabled').value = data.scheduler?.enabled ? 'true' : 'false';
            document.getElementById('schedulerCron').value = data.scheduler?.cron || '*/20 * * * *';
            // Extract config from cron expression
            const cronExpression = data.scheduler?.cron || '*/20 * * * *';
            const parts = cronExpression.split(' ');
            if (parts.length === 5) {
                if (parts[0].startsWith('*/')) {
                    // Interval execution
                    document.getElementById('intervalMinutes').value = parts[0].substring(2);
                    document.getElementById('fixedHour').value = '0';
                    document.getElementById('fixedMinute').value = '0';
                } else if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
                    // Fixed time execution
                    document.getElementById('fixedMinute').value = parts[0];
                    document.getElementById('fixedHour').value = parts[1];
                    document.getElementById('intervalMinutes').value = '20';
                } else {
                    // Other cases
                    document.getElementById('intervalMinutes').value = '20';
                    document.getElementById('fixedHour').value = '0';
                    document.getElementById('fixedMinute').value = '0';
                }
            } else {
                // Invalid cron expression
                document.getElementById('intervalMinutes').value = '20';
                document.getElementById('fixedHour').value = '0';
                document.getElementById('fixedMinute').value = '0';
            }

            document.getElementById('cpuWarningThreshold').value = data.thresholds?.cpu?.warning || 80;
            document.getElementById('cpuCriticalThreshold').value = data.thresholds?.cpu?.critical || 90;
            document.getElementById('memoryWarningThreshold').value = data.thresholds?.memory?.warning || 80;
            document.getElementById('memoryCriticalThreshold').value = data.thresholds?.memory?.critical || 90;
            document.getElementById('diskWarningThreshold').value = data.thresholds?.disk?.warning || 80;
            document.getElementById('diskCriticalThreshold').value = data.thresholds?.disk?.critical || 90;
            document.getElementById('diskFreeWarningThreshold').value = data.thresholds?.disk_free?.warning || 10;
            document.getElementById('diskFreeCriticalThreshold').value = data.thresholds?.disk_free?.critical || 5;
            document.getElementById('slowSqlWarningThreshold').value = data.thresholds?.slow_sql?.warning || 5;
            document.getElementById('slowSqlCriticalThreshold').value = data.thresholds?.slow_sql?.critical || 10;

            // Scheduled inspection items config
            document.getElementById('scheduledInspectSystemInfo').checked = data.scheduledInspectionItems?.system_info === true;
            document.getElementById('scheduledInspectCpu').checked = data.scheduledInspectionItems?.cpu === true;
            document.getElementById('scheduledInspectMemory').checked = data.scheduledInspectionItems?.memory === true;
            document.getElementById('scheduledInspectSwap').checked = data.scheduledInspectionItems?.swap === true;
            document.getElementById('scheduledInspectDisk').checked = data.scheduledInspectionItems?.disk === true;
            document.getElementById('scheduledInspectDiskIo').checked = data.scheduledInspectionItems?.disk_io === true;
            document.getElementById('scheduledInspectProcesses').checked = data.scheduledInspectionItems?.processes === true;
            document.getElementById('scheduledInspectSlowSql').checked = data.scheduledInspectionItems?.slow_sql === true;
            document.getElementById('scheduledInspectDatabase').checked = data.scheduledInspectionItems?.database === true;
            document.getElementById('scheduledInspectNetwork').checked = data.scheduledInspectionItems?.network === true;
            document.getElementById('scheduledInspectWorkerOutput').checked = data.scheduledInspectionItems?.worker_output_with_color_size === true;
            document.getElementById('scheduledInspectWorkerOutputWithoutColorSize').checked = data.scheduledInspectionItems?.worker_output_without_color_size === true;
            document.getElementById('scheduledInspectWorkerOutputSfd').checked = data.scheduledInspectionItems?.worker_output_sfd === true;
            document.getElementById('scheduledInspectMesHanging').checked = data.scheduledInspectionItems?.mes_hanging === true;

            // Full inspection items config
            document.getElementById('fullInspectSystemInfo').checked = data.fullInspectionItems?.system_info === true;
            document.getElementById('fullInspectCpu').checked = data.fullInspectionItems?.cpu === true;
            document.getElementById('fullInspectMemory').checked = data.fullInspectionItems?.memory === true;
            document.getElementById('fullInspectSwap').checked = data.fullInspectionItems?.swap === true;
            document.getElementById('fullInspectDisk').checked = data.fullInspectionItems?.disk === true;
            document.getElementById('fullInspectDiskIo').checked = data.fullInspectionItems?.disk_io === true;
            document.getElementById('fullInspectProcesses').checked = data.fullInspectionItems?.processes === true;
            document.getElementById('fullInspectSlowSql').checked = data.fullInspectionItems?.slow_sql === true;
            document.getElementById('fullInspectDatabase').checked = data.fullInspectionItems?.database === true;
            document.getElementById('fullInspectNetwork').checked = data.fullInspectionItems?.network === true;
            document.getElementById('fullInspectWorkerOutput').checked = data.fullInspectionItems?.worker_output_with_color_size === true;
            document.getElementById('fullInspectWorkerOutputWithoutColorSize').checked = data.fullInspectionItems?.worker_output_without_color_size === true;
            document.getElementById('fullInspectWorkerOutputSfd').checked = data.fullInspectionItems?.worker_output_sfd === true;
            document.getElementById('fullInspectMesHanging').checked = data.fullInspectionItems?.mes_hanging === true;

            // Daily inspection items config
            document.getElementById('dailyInspectSystemInfo').checked = data.dailyInspectionItems?.system_info === true;
            document.getElementById('dailyInspectCpu').checked = data.dailyInspectionItems?.cpu === true;
            document.getElementById('dailyInspectMemory').checked = data.dailyInspectionItems?.memory === true;
            document.getElementById('dailyInspectSwap').checked = data.dailyInspectionItems?.swap === true;
            document.getElementById('dailyInspectDisk').checked = data.dailyInspectionItems?.disk === true;
            document.getElementById('dailyInspectDiskIo').checked = data.dailyInspectionItems?.disk_io === true;
            document.getElementById('dailyInspectProcesses').checked = data.dailyInspectionItems?.processes === true;
            document.getElementById('dailyInspectSlowSql').checked = data.dailyInspectionItems?.slow_sql === true;
            document.getElementById('dailyInspectDatabase').checked = data.dailyInspectionItems?.database === true;
            document.getElementById('dailyInspectNetwork').checked = data.dailyInspectionItems?.network === true;
            document.getElementById('dailyInspectWorkerOutput').checked = data.dailyInspectionItems?.worker_output_with_color_size === true;
            document.getElementById('dailyInspectWorkerOutputWithoutColorSize').checked = data.dailyInspectionItems?.worker_output_without_color_size === true;
            document.getElementById('dailyInspectWorkerOutputSfd').checked = data.dailyInspectionItems?.worker_output_sfd === true;
            document.getElementById('dailyInspectMesHanging').checked = data.dailyInspectionItems?.mes_hanging === true;

            // Daily inspection config
            document.getElementById('dailyInspectionEnabled').value = data.dailyInspection?.enabled ? 'true' : 'false';
            document.getElementById('dailyInspectionHour').value = data.dailyInspection?.hour || 17;
            document.getElementById('dailyInspectionMinute').value = data.dailyInspection?.minute || 0;

            // Real-time monitoring config
            document.getElementById('realTimeMonitoringEnabled').value = data.realTimeMonitoring?.enabled ? 'true' : 'false';
            document.getElementById('realTimeMonitoringInterval').value = data.realTimeMonitoring?.interval || 30;
            document.getElementById('realTimeMonitoringOnlyErrorNotification').value = data.realTimeMonitoring?.notification?.only_error ? 'true' : 'false';
            document.getElementById('rtmCpu').checked = data.realTimeMonitoring?.items?.cpu === true;
            document.getElementById('rtmMemory').checked = data.realTimeMonitoring?.items?.memory === true;
            document.getElementById('rtmDisk').checked = data.realTimeMonitoring?.items?.disk === true;
            document.getElementById('rtmDiskIo').checked = data.realTimeMonitoring?.items?.disk_io === true;
            document.getElementById('rtmSwap').checked = data.realTimeMonitoring?.items?.swap === true;
            document.getElementById('rtmProcesses').checked = data.realTimeMonitoring?.items?.processes === true;
            document.getElementById('rtmSlowSql').checked = data.realTimeMonitoring?.items?.slow_sql === true;
            document.getElementById('rtmWorkerOutput').checked = data.realTimeMonitoring?.items?.worker_output_with_color_size === true;
            document.getElementById('rtmWorkerOutputWithoutColorSize').checked = data.realTimeMonitoring?.items?.worker_output_without_color_size === true;
            document.getElementById('rtmWorkerOutputSfd').checked = data.realTimeMonitoring?.items?.worker_output_sfd === true;
            document.getElementById('rtmMesHanging').checked = data.realTimeMonitoring?.items?.mes_hanging === true;
            document.getElementById('rtmNotificationEnabled').value = data.realTimeMonitoring?.notification?.enabled ? 'true' : 'false';
            document.getElementById('rtmCooldownPeriod').value = data.realTimeMonitoring?.notification?.cooldown_period || 300;

            // Scheduled inspection — only error notification
            document.getElementById('schedulerOnlyErrorNotification').value = data.scheduler?.only_error_notification ? 'true' : 'false';

            // Daily inspection — only error notification
            document.getElementById('dailyInspectionOnlyErrorNotification').value = data.dailyInspection?.only_error_notification ? 'true' : 'false';

            document.getElementById('dingtalkEnabled').value = data.dingtalk?.enabled ? 'true' : 'false';
            document.getElementById('dingtalkShowDetails').value = data.dingtalk?.show_details ? 'true' : 'false';
            document.getElementById('dingtalkWebhook1').value = data.dingtalk?.webhooks?.[0] || data.dingtalk?.webhook || '';
            document.getElementById('dingtalkWebhook2').value = data.dingtalk?.webhooks?.[1] || '';
            document.getElementById('dingtalkWebhook3').value = data.dingtalk?.webhooks?.[2] || '';

            // Database config - dynamic rendering
            renderDatabaseConfigs(data.databaseConfig || {});

            // Data inspection date config
            const dateConfig = data.inspectionDateConfig || {};
            const dateOptions = dateConfig.options || {};
            document.getElementById('dateYesterday').checked = dateOptions.yesterday || false;
            document.getElementById('dateToday').checked = dateOptions.today || false;
            document.getElementById('dateLastNToYesterday').checked = dateOptions.last_n_to_yesterday || false;
            document.getElementById('dateLastNToToday').checked = dateOptions.last_n_to_today || false;
            document.getElementById('dateCurrentMonthToYesterday').checked = dateOptions.current_month_to_yesterday || false;
            document.getElementById('dateCurrentMonthToToday').checked = dateOptions.current_month_to_today || false;
            document.getElementById('dateCustom').checked = dateOptions.custom || false;

            // Show/hide custom date range
            const customDateRange = document.getElementById('customDateRange');
            if (document.getElementById('dateCustom').checked) {
                customDateRange.classList.remove('hidden');
            } else {
                customDateRange.classList.add('hidden');
            }

            // Show/hide lastN config
            const lastNConfig = document.getElementById('lastNConfig');
            if (document.getElementById('dateLastNToYesterday').checked || document.getElementById('dateLastNToToday').checked) {
                lastNConfig.classList.remove('hidden');
            } else {
                lastNConfig.classList.add('hidden');
            }

            // Set custom date range values
            const customRange = dateConfig.custom_date_range || {};
            document.getElementById('customStartDate').value = customRange.start_date || '';
            document.getElementById('customEndDate').value = customRange.end_date || '';

            // Set lastN days value
            document.getElementById('lastNDays').value = dateConfig.last_n_days || 7;

            // Log database config
            const logDbConfig = data.logDatabase || {};
            document.getElementById('logDbEnabled').value = logDbConfig.enabled ? 'true' : 'false';
            document.getElementById('logDbType').value = logDbConfig.type || 'postgresql';
            document.getElementById('logDbHost').value = logDbConfig.host || '';
            document.getElementById('logDbPort').value = logDbConfig.port || '';
            document.getElementById('logDbUser').value = logDbConfig.user || '';
            document.getElementById('logDbPassword').value = logDbConfig.password || '';
            document.getElementById('logDbName').value = logDbConfig.database || '';
        })
        .catch(error => {
            console.error('加载配置失败:', error);
        });
}

// ========== Save Configuration ==========

function setupConfigFormSubmit() {
    const mainConfigForm = document.getElementById('mainConfigForm');
    if (mainConfigForm) {
        mainConfigForm.addEventListener('submit', function (e) {
            e.preventDefault();

            let cronExpression = '';
            const type = document.getElementById('scheduleType').value;

            if (type === 'interval') {
                const minutes = document.getElementById('intervalMinutes').value;
                cronExpression = `*/${minutes} * * * *`;
            } else if (type === 'fixed') {
                const hour = document.getElementById('fixedHour').value;
                const minute = document.getElementById('fixedMinute').value;
                cronExpression = `${minute} ${hour} * * *`;
            } else if (type === 'custom') {
                cronExpression = document.getElementById('schedulerCron').value;
            }

            const config = {
                projectName: document.getElementById('projectName').value,
                scheduler: {
                    enabled: document.getElementById('schedulerEnabled').value === 'true',
                    cron: cronExpression,
                    only_error_notification: document.getElementById('schedulerOnlyErrorNotification').value === 'true'
                },
                dailyInspection: {
                    enabled: document.getElementById('dailyInspectionEnabled').value === 'true',
                    hour: parseInt(document.getElementById('dailyInspectionHour').value),
                    minute: parseInt(document.getElementById('dailyInspectionMinute').value),
                    only_error_notification: document.getElementById('dailyInspectionOnlyErrorNotification').value === 'true'
                },
                realTimeMonitoring: {
                    enabled: document.getElementById('realTimeMonitoringEnabled').value === 'true',
                    interval: parseInt(document.getElementById('realTimeMonitoringInterval').value),
                    items: {
                        cpu: document.getElementById('rtmCpu').checked,
                        memory: document.getElementById('rtmMemory').checked,
                        disk: document.getElementById('rtmDisk').checked,
                        disk_io: document.getElementById('rtmDiskIo').checked,
                        swap: document.getElementById('rtmSwap').checked,
                        processes: document.getElementById('rtmProcesses').checked,
                        slow_sql: document.getElementById('rtmSlowSql').checked,
                        worker_output_with_color_size: document.getElementById('rtmWorkerOutput').checked,
                        worker_output_without_color_size: document.getElementById('rtmWorkerOutputWithoutColorSize').checked,
                        worker_output_sfd: document.getElementById('rtmWorkerOutputSfd').checked,
                        mes_hanging: document.getElementById('rtmMesHanging').checked
                    },
                    notification: {
                        enabled: document.getElementById('rtmNotificationEnabled').value === 'true',
                        only_error: document.getElementById('realTimeMonitoringOnlyErrorNotification').value === 'true',
                        alert_levels: ['warning', 'critical'],
                        dingtalk: true,
                        cooldown_period: parseInt(document.getElementById('rtmCooldownPeriod').value)
                    },
                    performance: {
                        max_concurrent_checks: 3,
                        timeout: 10,
                        resource_limit: {
                            cpu_percent: 15,
                            memory_mb: 200
                        }
                    }
                },
                thresholds: {
                    cpu: {
                        warning: parseInt(document.getElementById('cpuWarningThreshold').value),
                        critical: parseInt(document.getElementById('cpuCriticalThreshold').value)
                    },
                    memory: {
                        warning: parseInt(document.getElementById('memoryWarningThreshold').value),
                        critical: parseInt(document.getElementById('memoryCriticalThreshold').value)
                    },
                    disk: {
                        warning: parseInt(document.getElementById('diskWarningThreshold').value),
                        critical: parseInt(document.getElementById('diskCriticalThreshold').value)
                    },
                    disk_free: {
                        warning: parseInt(document.getElementById('diskFreeWarningThreshold').value),
                        critical: parseInt(document.getElementById('diskFreeCriticalThreshold').value)
                    },
                    slow_sql: {
                        warning: parseInt(document.getElementById('slowSqlWarningThreshold').value),
                        critical: parseInt(document.getElementById('slowSqlCriticalThreshold').value)
                    }
                },
                inspectionItems: {
                    system_info: document.getElementById('scheduledInspectSystemInfo').checked,
                    cpu: document.getElementById('scheduledInspectCpu').checked,
                    memory: document.getElementById('scheduledInspectMemory').checked,
                    swap: document.getElementById('scheduledInspectSwap').checked,
                    disk: document.getElementById('scheduledInspectDisk').checked,
                    disk_io: document.getElementById('scheduledInspectDiskIo').checked,
                    processes: document.getElementById('scheduledInspectProcesses').checked,
                    slow_sql: document.getElementById('scheduledInspectSlowSql').checked
                },
                scheduledInspectionItems: {
                    system_info: document.getElementById('scheduledInspectSystemInfo').checked,
                    cpu: document.getElementById('scheduledInspectCpu').checked,
                    memory: document.getElementById('scheduledInspectMemory').checked,
                    swap: document.getElementById('scheduledInspectSwap').checked,
                    disk: document.getElementById('scheduledInspectDisk').checked,
                    disk_io: document.getElementById('scheduledInspectDiskIo').checked,
                    processes: document.getElementById('scheduledInspectProcesses').checked,
                    slow_sql: document.getElementById('scheduledInspectSlowSql').checked,
                    database: document.getElementById('scheduledInspectDatabase').checked,
                    network: document.getElementById('scheduledInspectNetwork').checked,
                    worker_output_with_color_size: document.getElementById('scheduledInspectWorkerOutput').checked,
                    worker_output_without_color_size: document.getElementById('scheduledInspectWorkerOutputWithoutColorSize').checked,
                    worker_output_sfd: document.getElementById('scheduledInspectWorkerOutputSfd').checked,
                    mes_hanging: document.getElementById('scheduledInspectMesHanging').checked
                },
                fullInspectionItems: {
                    system_info: document.getElementById('fullInspectSystemInfo').checked,
                    cpu: document.getElementById('fullInspectCpu').checked,
                    memory: document.getElementById('fullInspectMemory').checked,
                    swap: document.getElementById('fullInspectSwap').checked,
                    disk: document.getElementById('fullInspectDisk').checked,
                    disk_io: document.getElementById('fullInspectDiskIo').checked,
                    processes: document.getElementById('fullInspectProcesses').checked,
                    slow_sql: document.getElementById('fullInspectSlowSql').checked,
                    database: document.getElementById('fullInspectDatabase').checked,
                    network: document.getElementById('fullInspectNetwork').checked,
                    worker_output_with_color_size: document.getElementById('fullInspectWorkerOutput').checked,
                    worker_output_without_color_size: document.getElementById('fullInspectWorkerOutputWithoutColorSize').checked,
                    worker_output_sfd: document.getElementById('fullInspectWorkerOutputSfd').checked,
                    mes_hanging: document.getElementById('fullInspectMesHanging').checked
                },
                dailyInspectionItems: {
                    system_info: document.getElementById('dailyInspectSystemInfo').checked,
                    cpu: document.getElementById('dailyInspectCpu').checked,
                    memory: document.getElementById('dailyInspectMemory').checked,
                    swap: document.getElementById('dailyInspectSwap').checked,
                    disk: document.getElementById('dailyInspectDisk').checked,
                    disk_io: document.getElementById('dailyInspectDiskIo').checked,
                    processes: document.getElementById('dailyInspectProcesses').checked,
                    slow_sql: document.getElementById('dailyInspectSlowSql').checked,
                    database: document.getElementById('dailyInspectDatabase').checked,
                    network: document.getElementById('dailyInspectNetwork').checked,
                    worker_output_with_color_size: document.getElementById('dailyInspectWorkerOutput').checked,
                    worker_output_without_color_size: document.getElementById('dailyInspectWorkerOutputWithoutColorSize').checked,
                    worker_output_sfd: document.getElementById('dailyInspectWorkerOutputSfd').checked,
                    mes_hanging: document.getElementById('dailyInspectMesHanging').checked
                },
                dingtalk: {
                    enabled: document.getElementById('dingtalkEnabled').value === 'true',
                    webhooks: [
                        document.getElementById('dingtalkWebhook1').value,
                        document.getElementById('dingtalkWebhook2').value,
                        document.getElementById('dingtalkWebhook3').value
                    ].filter(Boolean),
                    show_details: document.getElementById('dingtalkShowDetails').value === 'true'
                },
                databaseConfig: collectDatabaseConfigs(),
                inspectionDateConfig: {
                    enabled: true,
                    options: {
                        yesterday: document.getElementById('dateYesterday').checked,
                        today: document.getElementById('dateToday').checked,
                        last_n_to_yesterday: document.getElementById('dateLastNToYesterday').checked,
                        last_n_to_today: document.getElementById('dateLastNToToday').checked,
                        current_month_to_yesterday: document.getElementById('dateCurrentMonthToYesterday').checked,
                        current_month_to_today: document.getElementById('dateCurrentMonthToToday').checked,
                        custom: document.getElementById('dateCustom').checked
                    },
                    last_n_days: Math.min(parseInt(document.getElementById('lastNDays').value) || 7, 28),
                    custom_date_range: {
                        start_date: document.getElementById('customStartDate').value,
                        end_date: document.getElementById('customEndDate').value
                    }
                },
                logDatabase: {
                    enabled: document.getElementById('logDbEnabled').value === 'true',
                    type: document.getElementById('logDbType').value,
                    host: document.getElementById('logDbHost').value,
                    port: parseInt(document.getElementById('logDbPort').value) || 5432,
                    user: document.getElementById('logDbUser').value,
                    password: document.getElementById('logDbPassword').value,
                    database: document.getElementById('logDbName').value
                }
            };

            fetch(`/api/config?scope=${encodeURIComponent(activeConfigScope)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            })
                .then(response => response.json())
                .then(data => {
                    if (data.message) {
                        showToast('配置保存成功！', 'success');
                    } else {
                        showToast('配置保存失败: ' + (data.error || '未知错误'), 'error');
                    }
                })
                .catch(error => {
                    console.error('保存配置失败:', error);
                    showToast('配置保存失败，请检查网络连接', 'error');
                });
        });
    }
}

// ========== Cancel/Reload Config ==========

function setupCancelConfigBtn() {
    const cancelConfigBtn = document.getElementById('cancelConfigBtn');
    if (cancelConfigBtn) {
        cancelConfigBtn.addEventListener('click', function () {
            loadConfig();
        });
    }
}

// ========== Dynamic Database Config Functions ==========

function renderDatabaseConfigs(databaseConfig) {
    const container = document.getElementById('databaseConfigsContainer');
    if (!container) return;

    container.innerHTML = '';

    const priorityDbIds = ['mes', 'hanging'];
    const dbIds = Object.keys(databaseConfig).sort((left, right) => {
        const leftPriority = priorityDbIds.indexOf(left);
        const rightPriority = priorityDbIds.indexOf(right);
        if (leftPriority !== -1 || rightPriority !== -1) {
            return (leftPriority === -1 ? priorityDbIds.length : leftPriority) -
                (rightPriority === -1 ? priorityDbIds.length : rightPriority);
        }
        return left.localeCompare(right, 'zh-CN');
    });
    if (dbIds.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm">暂无数据库配置，点击"新增数据库配置"开始添加</p>';
        return;
    }

    dbIds.forEach(dbId => {
        const dbConfig = databaseConfig[dbId];
        const isPreset = ['mes', 'hanging'].includes(dbId);

        const dbDiv = document.createElement('div');
        dbDiv.className = 'border border-gray-200 rounded-lg p-4';
        dbDiv.dataset.dbId = dbId;

        const headerDiv = document.createElement('div');
        headerDiv.className = 'flex items-center justify-between mb-3';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'font-medium text-sm border-none bg-transparent focus:outline-none focus:ring-0 w-auto';
        nameInput.value = dbId;
        nameInput.dataset.field = 'id';
        nameInput.readOnly = isPreset;
        if (isPreset) {
            nameInput.classList.add('text-primary', 'font-bold');
        }

        if (!isPreset) {
            nameInput.addEventListener('input', function () {
                const newName = this.value.trim();
                if (newName) {
                    dbDiv.dataset.dbId = newName;
                } else {
                    dbDiv.dataset.dbId = dbId;
                }
            });
        }

        const btnGroup = document.createElement('div');
        btnGroup.className = 'flex items-center space-x-2';

        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'text-xs px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 transition-all';
        testBtn.innerHTML = '<i class="fa fa-check mr-1"></i>测试连接';
        testBtn.onclick = function () { testDatabaseConnection(dbDiv.dataset.dbId); };

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'text-xs px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 transition-all';
        deleteBtn.innerHTML = '<i class="fa fa-trash mr-1"></i>删除';
        deleteBtn.onclick = function () { removeDatabaseConfig(dbDiv.dataset.dbId); };
        if (isPreset) {
            deleteBtn.disabled = true;
            deleteBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }

        btnGroup.appendChild(testBtn);
        btnGroup.appendChild(deleteBtn);
        headerDiv.appendChild(nameInput);
        headerDiv.appendChild(btnGroup);

        const fieldsDiv = document.createElement('div');
        fieldsDiv.className = 'grid grid-cols-2 md:grid-cols-3 gap-4';

        const typeSelect = document.createElement('select');
        typeSelect.className = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all db-config-input';
        typeSelect.style.setProperty('--tw-ring-color', 'var(--primary-color)');
        typeSelect.innerHTML = `
            <option value="postgresql" ${dbConfig.type === 'postgresql' ? 'selected' : ''}>PostgreSQL</option>
            <option value="mysql" ${dbConfig.type === 'mysql' ? 'selected' : ''}>MySQL</option>
        `;
        typeSelect.dataset.field = 'type';

        const hostInput = createDbInput('host', dbConfig.host || '', '主机');
        const portInput = createDbInput('port', dbConfig.port || '', '端口', 'number');
        const userInput = createDbInput('user', dbConfig.user || '', '用户名');
        const passwordInput = createDbInput('password', dbConfig.password || '', '密码', 'password');
        const databaseInput = createDbInput('database', dbConfig.database || '', '数据库名');

        fieldsDiv.appendChild(createField('数据库类型', typeSelect));
        fieldsDiv.appendChild(createField('主机', hostInput));
        fieldsDiv.appendChild(createField('端口', portInput));
        fieldsDiv.appendChild(createField('用户名', userInput));
        fieldsDiv.appendChild(createField('密码', passwordInput));
        fieldsDiv.appendChild(createField('数据库名', databaseInput));

        dbDiv.appendChild(headerDiv);
        dbDiv.appendChild(fieldsDiv);
        container.appendChild(dbDiv);
    });

    setupAddDatabaseConfigBtn();
}

function createDbInput(field, value, placeholder, type) {
    const input = document.createElement('input');
    input.type = type || 'text';
    input.className = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all db-config-input';
    input.style.setProperty('--tw-ring-color', 'var(--primary-color)');
    input.value = value;
    input.placeholder = placeholder;
    input.dataset.field = field;
    if (type === 'number') {
        input.min = '1';
        input.max = '65535';
    }
    return input;
}

function createField(label, input) {
    const div = document.createElement('div');
    const labelEl = document.createElement('label');
    labelEl.className = 'block text-xs font-medium text-gray-600 mb-1';
    labelEl.textContent = label;
    div.appendChild(labelEl);
    div.appendChild(input);
    return div;
}

function collectDatabaseConfigs() {
    const configs = {};
    const dbDivs = document.querySelectorAll('#databaseConfigsContainer > div[data-db-id]');

    dbDivs.forEach(dbDiv => {
        const inputs = dbDiv.querySelectorAll('.db-config-input, input[data-field]');

        let dbId = dbDiv.dataset.dbId;
        const config = {};
        inputs.forEach(input => {
            const field = input.dataset.field;
            if (field === 'port') {
                config[field] = parseInt(input.value) || (config.type === 'postgresql' ? 5432 : 3306);
            } else if (field === 'id') {
                dbId = input.value.trim() || dbId;
            } else {
                config[field] = input.value;
            }
        });

        configs[dbId] = config;
    });

    return configs;
}

function setupAddDatabaseConfigBtn() {
    const btn = document.getElementById('addDatabaseConfigBtn');
    if (btn) {
        btn.onclick = function () { addDatabaseConfig(); };
    }
}

function addDatabaseConfig() {
    const container = document.getElementById('databaseConfigsContainer');
    if (!container) return;

    let newId = 'db_new_1';
    const existingIds = Array.from(container.querySelectorAll('[data-db-id]')).map(el => el.dataset.dbId);
    let counter = 1;
    while (existingIds.includes(newId)) {
        counter++;
        newId = 'db_new_' + counter;
    }

    const dbDiv = document.createElement('div');
    dbDiv.className = 'border border-gray-200 rounded-lg p-4';
    dbDiv.dataset.dbId = newId;

    const headerDiv = document.createElement('div');
    headerDiv.className = 'flex items-center justify-between mb-3';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'font-medium text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-2';
    nameInput.value = newId;
    nameInput.dataset.field = 'id';
    nameInput.placeholder = '请输入数据库标识';

    nameInput.addEventListener('input', function () {
        const newName = this.value.trim();
        if (newName) {
            dbDiv.dataset.dbId = newName;
        } else {
            dbDiv.dataset.dbId = newId;
        }
    });

    const btnGroup = document.createElement('div');
    btnGroup.className = 'flex items-center space-x-2';

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'text-xs px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 transition-all';
    testBtn.innerHTML = '<i class="fa fa-check mr-1"></i>测试连接';
    testBtn.onclick = function () { testDatabaseConnection(dbDiv.dataset.dbId); };

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'text-xs px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 transition-all';
    deleteBtn.innerHTML = '<i class="fa fa-trash mr-1"></i>删除';
    deleteBtn.onclick = function () { removeDatabaseConfig(dbDiv.dataset.dbId); };

    btnGroup.appendChild(testBtn);
    btnGroup.appendChild(deleteBtn);
    headerDiv.appendChild(nameInput);
    headerDiv.appendChild(btnGroup);

    const fieldsDiv = document.createElement('div');
    fieldsDiv.className = 'grid grid-cols-2 md:grid-cols-3 gap-4';

    const typeSelect = document.createElement('select');
    typeSelect.className = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all db-config-input';
    typeSelect.style.setProperty('--tw-ring-color', 'var(--primary-color)');
    typeSelect.innerHTML = `
        <option value="postgresql">PostgreSQL</option>
        <option value="mysql">MySQL</option>
    `;
    typeSelect.dataset.field = 'type';

    const hostInput = createDbInput('host', '', 'localhost');
    const portInput = createDbInput('port', '5432', '5432', 'number');
    const userInput = createDbInput('user', 'postgres', '用户名');
    const passwordInput = createDbInput('password', '', '密码', 'password');
    const databaseInput = createDbInput('database', '', '数据库名');

    fieldsDiv.appendChild(createField('数据库类型', typeSelect));
    fieldsDiv.appendChild(createField('主机', hostInput));
    fieldsDiv.appendChild(createField('端口', portInput));
    fieldsDiv.appendChild(createField('用户名', userInput));
    fieldsDiv.appendChild(createField('密码', passwordInput));
    fieldsDiv.appendChild(createField('数据库名', databaseInput));

    dbDiv.appendChild(headerDiv);
    dbDiv.appendChild(fieldsDiv);
    container.appendChild(dbDiv);

    nameInput.focus();
}

async function removeDatabaseConfig(dbId) {
    const dbDiv = document.querySelector(`#databaseConfigsContainer > div[data-db-id="${dbId}"]`);
    if (!dbDiv) return;

    const isPreset = ['mes', 'hanging'].includes(dbId);
    if (isPreset) {
        showToast('系统预设数据库（mes, hanging）不能删除', 'warning');
        return;
    }

    const confirmed = await showConfirm('确定要删除这个数据库配置吗？', '确认删除');
    if (!confirmed) return;

    fetch('/api/config/database/' + dbId, {
        method: 'DELETE'
    })
        .then(response => response.json())
        .then(data => {
            if (data.message) {
                showToast('数据库配置删除成功！', 'success');
                dbDiv.remove();
            } else {
                showToast('数据库配置删除失败: ' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            console.error('删除数据库配置失败:', error);
            showToast('数据库配置删除失败，请检查网络连接', 'error');
        });
}

function testDatabaseConnection(dbId) {
    const dbDiv = document.querySelector(`#databaseConfigsContainer > div[data-db-id="${dbId}"]`);
    if (!dbDiv) return;

    const config = {};
    dbDiv.querySelectorAll('.db-config-input, input[data-field]').forEach(input => {
        const field = input.dataset.field;
        if (field === 'port') {
            config[field] = parseInt(input.value) || 5432;
        } else if (field !== 'id') {
            config[field] = input.value;
        }
    });

    fetch('/api/config/test_database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('数据库连接测试成功！', 'success');
            } else {
                showToast('数据库连接测试失败: ' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            console.error('测试数据库连接失败:', error);
            showToast('数据库连接测试失败，请检查网络连接', 'error');
        });
}

// ========== Test Log Database Connection ==========

function testLogDatabaseConnection() {
    const btn = document.getElementById('testLogDbConnection');
    const resultSpan = document.getElementById('logDbTestResult');

    const config = {
        enabled: document.getElementById('logDbEnabled').value === 'true',
        type: document.getElementById('logDbType').value,
        host: document.getElementById('logDbHost').value,
        port: parseInt(document.getElementById('logDbPort').value) || 5432,
        user: document.getElementById('logDbUser').value,
        password: document.getElementById('logDbPassword').value,
        database: document.getElementById('logDbName').value
    };

    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin mr-1"></i>测试中...';
    resultSpan.textContent = '';

    fetch('/api/config/test_log_database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
        .then(response => response.json())
        .then(data => {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa fa-check-circle mr-1"></i>测试连接并创建表';
            if (data.success) {
                resultSpan.textContent = data.message;
                resultSpan.style.color = '#10b981';
                showToast('日志数据库连接测试成功，表已创建！', 'success');
            } else {
                resultSpan.textContent = data.error;
                resultSpan.style.color = '#ef4444';
                showToast('日志数据库连接测试失败: ' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa fa-check-circle mr-1"></i>测试连接并创建表';
            resultSpan.textContent = '测试失败，请检查网络连接';
            resultSpan.style.color = '#ef4444';
            console.error('测试日志数据库连接失败:', error);
            showToast('日志数据库连接测试失败，请检查网络连接', 'error');
        });
}

// ========== Configuration Tabs ==========

function selectConfigTab(tabName) {
    const selectedTab = document.querySelector(`.config-tab[data-config-tab="${tabName}"]`);
    if (!selectedTab || selectedTab.classList.contains('hidden')) return;
    activeConfigScope = tabName;
    document.querySelectorAll('.config-tab').forEach(tab => {
        const active = tab.dataset.configTab === tabName;
        tab.classList.toggle('border-primary', active);
        tab.classList.toggle('text-primary', active);
        tab.classList.toggle('border-transparent', !active);
        tab.classList.toggle('text-gray-500', !active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.config-tab-panel').forEach(panel => {
        panel.classList.toggle('hidden', panel.dataset.configPanel !== tabName);
    });
    const actions = document.getElementById('configFormActions');
    if (actions) actions.classList.toggle('hidden', tabName === 'custom-sql');
    if (tabName === 'custom-sql') {
        if (typeof loadSavedScripts === 'function') loadSavedScripts();
        if (typeof loadDatabaseOptions === 'function') loadDatabaseOptions();
    } else {
        loadConfig(tabName);
    }
}

async function showAuthorizedConfig() {
    let access = window.authAccess;
    if (!access && typeof loadAccess === 'function') access = await loadAccess();
    const permissions = access?.permissions || [];
    const authorizedTabs = Object.entries(configScopePermissions)
        .filter(([, permission]) => permissions.includes(permission))
        .map(([tabName]) => tabName);
    document.querySelectorAll('.config-tab').forEach(tab => {
        tab.classList.toggle('hidden', !authorizedTabs.includes(tab.dataset.configTab));
    });
    if (!authorizedTabs.length) {
        showToast('没有系统配置权限', 'warning');
        return;
    }
    selectConfigTab(authorizedTabs[0]);
}

function setupConfigTabs() {
    document.querySelectorAll('.config-tab').forEach(tab => {
        tab.setAttribute('role', 'tab');
        tab.addEventListener('click', function () {
            selectConfigTab(this.dataset.configTab);
        });
    });
}

window.selectConfigTab = selectConfigTab;
window.showAuthorizedConfig = showAuthorizedConfig;

// ========== Init on DOMContentLoaded ==========

function setupDateConfigToggle() {
    const lastNConfig = document.getElementById('lastNConfig');
    const customDateRange = document.getElementById('customDateRange');

    const updateLastNVisibility = function () {
        if (document.getElementById('dateLastNToYesterday').checked || document.getElementById('dateLastNToToday').checked) {
            lastNConfig.classList.remove('hidden');
        } else {
            lastNConfig.classList.add('hidden');
        }
    };

    const updateCustomDateVisibility = function () {
        if (document.getElementById('dateCustom').checked) {
            customDateRange.classList.remove('hidden');
        } else {
            customDateRange.classList.add('hidden');
        }
    };

    document.getElementById('dateLastNToYesterday')?.addEventListener('change', updateLastNVisibility);
    document.getElementById('dateLastNToToday')?.addEventListener('change', updateLastNVisibility);
    document.getElementById('dateCustom')?.addEventListener('change', updateCustomDateVisibility);
}

document.addEventListener('DOMContentLoaded', function () {
    setupConfigTabs();
    setupConfigFormSubmit();
    setupCancelConfigBtn();
    setupDateConfigToggle();

    document.getElementById('testLogDbConnection')?.addEventListener('click', testLogDatabaseConnection);
});