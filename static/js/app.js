/**
 * app.js — Shared utilities for the Server Inspection System
 * Contains: toast/confirm dialogs, theme management,
 * button state management, page navigation, and general DOMContentLoaded setup.
 * This file should be loaded FIRST before all other module JS files.
 */

// ========== Tailwind Configuration (兼容本地CSS模式) ==========
// 本地CSS模式下不需要tailwind.config，定义空对象避免报错
if (typeof tailwind === 'undefined') {
    window.tailwind = { config: {} };
}

// ========== Toast Notification ==========

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `flex items-center px-4 py-3 rounded-lg shadow-lg backdrop-blur-sm transform transition-all duration-300 fade-in min-w-[280px] max-w-[400px] ${type === 'success' ? 'bg-green-50 border border-green-200' :
        type === 'warning' ? 'bg-yellow-50 border border-yellow-200' :
            type === 'error' ? 'bg-red-50 border border-red-200' :
                'bg-blue-50 border border-blue-200'
        }`;

    const icon = document.createElement('i');
    icon.className = `mr-3 text-lg ${type === 'success' ? 'text-green-500' :
        type === 'warning' ? 'text-yellow-500' :
            type === 'error' ? 'text-red-500' :
                'text-blue-500'
        }`;
    icon.className += ` fa ${type === 'success' ? 'fa-check-circle' :
        type === 'warning' ? 'fa-exclamation-circle' :
            type === 'error' ? 'fa-times-circle' :
                'fa-info-circle'
        }`;

    const text = document.createElement('span');
    text.className = `${type === 'success' ? 'text-green-800' :
        type === 'warning' ? 'text-yellow-800' :
            type === 'error' ? 'text-red-800' :
                'text-blue-800'
        } text-sm font-medium`;
    text.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ml-auto text-gray-400 hover:text-gray-600 transition-colors';
    closeBtn.innerHTML = '<i class="fa fa-times"></i>';
    closeBtn.onclick = () => toast.remove();

    toast.appendChild(icon);
    toast.appendChild(text);
    toast.appendChild(closeBtn);
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ========== Confirm Dialog ==========

function showConfirm(message, title = '确认') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 fade-in';
        overlay.onclick = () => resolve(false);

        const dialog = document.createElement('div');
        dialog.className = 'bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden fade-in';
        dialog.onclick = (e) => e.stopPropagation();

        const header = document.createElement('div');
        header.className = 'px-6 py-4 border-b border-gray-100 bg-gray-50';
        header.innerHTML = `<h3 class="text-lg font-semibold text-gray-800">${title}</h3>`;

        const body = document.createElement('div');
        body.className = 'px-6 py-5';
        body.innerHTML = `<p class="text-gray-600 leading-relaxed">${message}</p>`;

        const footer = document.createElement('div');
        footer.className = 'px-6 py-4 bg-gray-50 flex justify-end gap-3';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'px-5 py-2.5 text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all text-sm font-medium';
        cancelBtn.textContent = '取消';
        cancelBtn.onclick = () => {
            overlay.remove();
            resolve(false);
        };

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'px-5 py-2.5 text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-all text-sm font-medium shadow-sm';
        confirmBtn.textContent = '确定';
        confirmBtn.onclick = () => {
            overlay.remove();
            resolve(true);
        };

        footer.appendChild(cancelBtn);
        footer.appendChild(confirmBtn);
        dialog.appendChild(header);
        dialog.appendChild(body);
        dialog.appendChild(footer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

// ========== Theme Management ==========

function setTheme(themeName) {
    document.body.className = document.body.className.replace(/theme-\w+/, themeName);
    localStorage.setItem('theme', themeName);
}

// ========== Button State Management ==========

function setActiveButton(activeBtn) {
    // Remove active state from all buttons
    document.querySelectorAll('.inspect-btn').forEach(btn => {
        btn.classList.remove('bg-primary-light');
        const iconDiv = btn.querySelector('div');
        const icon = btn.querySelector('i');
        if (iconDiv) {
            iconDiv.style.background = '';
            iconDiv.classList.add('bg-gray-100');
        }
        if (icon) icon.style.color = '';
    });

    if (activeBtn && activeBtn.id !== 'configBtn') {
        activeBtn.classList.add('bg-primary-light');
        const iconDiv = activeBtn.querySelector('div');
        const icon = activeBtn.querySelector('i');
        if (iconDiv) {
            iconDiv.classList.remove('bg-gray-100');
            iconDiv.style.background = 'var(--primary-light)';
        }
        if (icon) icon.style.color = 'var(--primary-color)';
    }
}

// ========== Page Navigation ==========

function hideAllContent() {
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');
    const configContent = document.getElementById('configContent');
    const inspectionContent = document.getElementById('inspectionContent');
    const sqlInspectContent = document.getElementById('sqlInspectContent');
    const customInspectContent = document.getElementById('customInspectContent');
    const logContent = document.getElementById('logContent');
    const arthasContent = document.getElementById('arthasContent');
    const pgConfigContent = document.getElementById('pgConfigContent');

    if (loading) loading.classList.add('hidden');
    if (results) results.classList.add('hidden');
    if (configContent) configContent.classList.add('hidden');
    if (inspectionContent) inspectionContent.classList.add('hidden');
    if (sqlInspectContent) sqlInspectContent.classList.add('hidden');
    if (customInspectContent) customInspectContent.classList.add('hidden');
    if (logContent) logContent.classList.add('hidden');
    if (arthasContent) arthasContent.classList.add('hidden');
    if (pgConfigContent) pgConfigContent.classList.add('hidden');
}

// ========== DOMContentLoaded Setup ==========

// Replace native alert with custom toast.
// NOTE: window.confirm is intentionally NOT overridden. showConfirm() is async
// (Promise-based) and cannot return a value synchronously, so overriding
// window.confirm would silently always return false. Use `await showConfirm(...)`
// in async handlers instead.
document.addEventListener('DOMContentLoaded', function () {
    window.alert = function (message) {
        showToast(message, 'info');
    };
});

// Load saved theme on page load
document.addEventListener('DOMContentLoaded', function () {
    const savedTheme = localStorage.getItem('theme') || 'theme-blue';
    setTheme(savedTheme);
});

// Main page initialization: navigation buttons, scheduler config, date config, etc.
document.addEventListener('DOMContentLoaded', function () {
    const fullInspectBtn = document.getElementById('fullInspectBtn');
    const inspectBtns = document.querySelectorAll('.inspect-btn');
    const configBtn = document.getElementById('configBtn');

    // Default: show config page and set config button active
    window.showConfig();
    if (configBtn) {
        setActiveButton(configBtn);
    }

    // Schedule type toggle (interval/fixed/cron)
    const scheduleType = document.getElementById('scheduleType');
    if (scheduleType) {
        scheduleType.addEventListener('change', function () {
            const intervalConfig = document.getElementById('intervalConfig');
            const fixedConfig = document.getElementById('fixedConfig');
            const cronConfig = document.getElementById('cronConfig');

            intervalConfig.classList.add('hidden');
            fixedConfig.classList.add('hidden');
            cronConfig.classList.add('hidden');

            if (this.value === 'interval') {
                intervalConfig.classList.remove('hidden');
            } else if (this.value === 'fixed') {
                fixedConfig.classList.remove('hidden');
            } else if (this.value === 'custom') {
                cronConfig.classList.remove('hidden');
            }
        });
    }

    // Data inspection date config — custom date range toggle
    const dateCustomCheckbox = document.getElementById('dateCustom');
    const customDateRange = document.getElementById('customDateRange');
    if (dateCustomCheckbox && customDateRange) {
        dateCustomCheckbox.addEventListener('change', function () {
            if (this.checked) {
                customDateRange.classList.remove('hidden');
            } else {
                customDateRange.classList.add('hidden');
            }
        });
    }

    // Data inspection date config — custom date range validation
    const customStartDate = document.getElementById('customStartDate');
    const customEndDate = document.getElementById('customEndDate');
    if (customStartDate && customEndDate) {
        function validateConfigDateRange() {
            const startDate = customStartDate.value;
            const endDate = customEndDate.value;

            if (startDate && endDate) {
                const start = new Date(startDate);
                const end = new Date(endDate);

                if (start.getMonth() !== end.getMonth() || start.getFullYear() !== end.getFullYear()) {
                    showToast('开始日期和结束日期必须在同一个月', 'warning');
                    customEndDate.value = '';
                }
            }
        }

        customStartDate.addEventListener('change', validateConfigDateRange);
        customEndDate.addEventListener('change', validateConfigDateRange);
    }

    // Full inspection button
    if (fullInspectBtn) {
        fullInspectBtn.addEventListener('click', function () {
            window.runInspection('full');
            setActiveButton(this);
        });
    }

    // Individual inspect buttons (sidebar navigation)
    inspectBtns.forEach(btn => {
        // fullInspectBtn 同时带 .inspect-btn 类，已由上方专用监听器处理；
        // 此处若再绑定会一次点击触发两次 runInspection，产生两条完整巡检日志
        if (btn.id === 'fullInspectBtn') return;
        btn.addEventListener('click', function () {
            const type = this.getAttribute('data-type');
            if (type === 'config') {
                window.showConfig();
            } else if (type === 'sql_inspect') {
                window.showSqlInspect();
            } else if (type === 'custom_inspect') {
                window.showCustomInspect();
            } else if (type === 'logs') {
                window.showLogs();
            } else if (type === 'arthas') {
                window.showArthas();
            } else if (type === 'pg_config') {
                window.showPgConfig();
            } else {
                window.runInspection(type);
            }
            setActiveButton(this);
        });
    });

    // Clear logs button
    const clearLogsBtn = document.getElementById('clearLogsBtn');
    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', async function () {
            const confirmed = await showConfirm('确定要清理慢SQL日志吗？', '确认清理');
            if (confirmed) {
                fetch('/api/clear_slow_sql_logs', { method: 'POST' })
                    .then(response => response.json())
                    .then(data => {
                        showToast(data.message || '慢SQL日志清理完成', 'success');
                    })
                    .catch(error => {
                        showToast('清理慢SQL日志失败: ' + error.message, 'error');
                    });
            }
        });
    }
});

// ========== Global Exports ==========

// These functions are exposed as window.* globals so other modules can call them.
// They are assigned here as placeholders and will be overwritten by their
// respective module JS files when those files load.
window.showConfig = function () {
    hideAllContent();
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');
    const configContent = document.getElementById('configContent');
    loading.classList.add('hidden');
    results.classList.remove('hidden');
    configContent.classList.remove('hidden');
    if (typeof loadConfig === 'function') loadConfig();
    if (typeof loadSavedScripts === 'function') loadSavedScripts();
};

window.showSqlInspect = function () {
    hideAllContent();
    const results = document.getElementById('results');
    const sqlInspectContent = document.getElementById('sqlInspectContent');
    results.classList.remove('hidden');
    sqlInspectContent.classList.remove('hidden');
    // Hide slow SQL dedup option
    const deduplicateOption = document.getElementById('deduplicateOption');
    if (deduplicateOption) {
        deduplicateOption.classList.add('hidden');
    }
};

window.showCustomInspect = function () {
    hideAllContent();
    const results = document.getElementById('results');
    const customInspectContent = document.getElementById('customInspectContent');
    results.classList.remove('hidden');
    customInspectContent.classList.remove('hidden');
    if (typeof loadCustomScripts === 'function') loadCustomScripts();
};

window.showArthas = function () {
    hideAllContent();
    const arthasContent = document.getElementById('arthasContent');
    if (arthasContent) arthasContent.classList.remove('hidden');
};

window.showPgConfig = function () {
    hideAllContent();
    const results = document.getElementById('results');
    const pgConfigContent = document.getElementById('pgConfigContent');
    if (results) results.classList.remove('hidden');
    if (pgConfigContent) pgConfigContent.classList.remove('hidden');
    if (typeof loadPgConfig === 'function') loadPgConfig();
};

window.showLogs = function () {
    hideAllContent();
    const results = document.getElementById('results');
    const logContent = document.getElementById('logContent');
    if (results) results.classList.remove('hidden');
    if (logContent) logContent.classList.remove('hidden');
};

window.setActiveButton = setActiveButton;
window.showToast = showToast;
window.showConfirm = showConfirm;
window.setTheme = setTheme;
window.hideAllContent = hideAllContent;