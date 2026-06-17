/**
 * config.js — Config page JS for the Server Inspection System
 * Contains: loadConfig(), saveConfig(), reloadConfig(), scheduler config UI logic,
 * config form handling, date config validation, and cancel button logic.
 * Depends on: app.js (showToast, showConfirm)
 */

// ========== Load Configuration ==========

function loadConfig() {
    fetch('/api/config')
        .then(response => response.json())
        .then(data => {
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
            document.getElementById('dingtalkSecret').value = data.dingtalk?.secret || '';

            // Database config
            const databaseConfig = data.databaseConfig || {};
            const mesConfig = databaseConfig.mes || {};
            const hangingConfig = databaseConfig.hanging || {};

            document.getElementById('mesDatabaseType').value = mesConfig.type || 'postgresql';
            document.getElementById('mesHost').value = mesConfig.host || 'localhost';
            document.getElementById('mesPort').value = mesConfig.port || (mesConfig.type === 'postgresql' ? 5432 : 3306);
            document.getElementById('mesUser').value = mesConfig.user || (mesConfig.type === 'postgresql' ? 'postgres' : 'root');
            document.getElementById('mesPassword').value = mesConfig.password || 'password';
            document.getElementById('mesDatabase').value = mesConfig.database || 'mes';

            document.getElementById('hangingDatabaseType').value = hangingConfig.type || 'mysql';
            document.getElementById('hangingHost').value = hangingConfig.host || 'localhost';
            document.getElementById('hangingPort').value = hangingConfig.port || (hangingConfig.type === 'postgresql' ? 5432 : 3306);
            document.getElementById('hangingUser').value = hangingConfig.user || (hangingConfig.type === 'postgresql' ? 'postgres' : 'root');
            document.getElementById('hangingPassword').value = hangingConfig.password || 'password';
            document.getElementById('hangingDatabase').value = hangingConfig.database || 'hanging';

            // Data inspection date config
            const dateConfig = data.inspectionDateConfig || {};
            const dateOptions = dateConfig.options || {};
            document.getElementById('dateYesterday').checked = dateOptions.yesterday || false;
            document.getElementById('dateToday').checked = dateOptions.today || false;
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

            // Set custom date range values
            const customRange = dateConfig.custom_date_range || {};
            document.getElementById('customStartDate').value = customRange.start_date || '';
            document.getElementById('customEndDate').value = customRange.end_date || '';
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
                    secret: document.getElementById('dingtalkSecret').value,
                    show_details: document.getElementById('dingtalkShowDetails').value === 'true'
                },
                databaseConfig: {
                    mes: {
                        type: document.getElementById('mesDatabaseType').value,
                        host: document.getElementById('mesHost').value,
                        port: parseInt(document.getElementById('mesPort').value),
                        user: document.getElementById('mesUser').value,
                        password: document.getElementById('mesPassword').value,
                        database: document.getElementById('mesDatabase').value
                    },
                    hanging: {
                        type: document.getElementById('hangingDatabaseType').value,
                        host: document.getElementById('hangingHost').value,
                        port: parseInt(document.getElementById('hangingPort').value),
                        user: document.getElementById('hangingUser').value,
                        password: document.getElementById('hangingPassword').value,
                        database: document.getElementById('hangingDatabase').value
                    }
                },
                inspectionDateConfig: {
                    enabled: true,
                    options: {
                        yesterday: document.getElementById('dateYesterday').checked,
                        today: document.getElementById('dateToday').checked,
                        current_month_to_yesterday: document.getElementById('dateCurrentMonthToYesterday').checked,
                        current_month_to_today: document.getElementById('dateCurrentMonthToToday').checked,
                        custom: document.getElementById('dateCustom').checked
                    },
                    custom_date_range: {
                        start_date: document.getElementById('customStartDate').value,
                        end_date: document.getElementById('customEndDate').value
                    }
                }
            };

            fetch('/api/config', {
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

// ========== Init on DOMContentLoaded ==========

document.addEventListener('DOMContentLoaded', function () {
    setupConfigFormSubmit();
    setupCancelConfigBtn();
});