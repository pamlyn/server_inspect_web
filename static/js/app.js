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

function showConfirm(message, title = '确认', options = {}) {
    return new Promise((resolve) => {
        const variant = options.variant === 'danger' ? 'danger' : 'primary';
        let settled = false;
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        const dialog = document.createElement('section');
        dialog.className = `confirm-dialog confirm-dialog--${variant}`;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const settle = value => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKeydown);
            overlay.remove();
            resolve(value);
        };
        const onKeydown = event => {
            if (event.key === 'Escape') settle(false);
        };

        const header = document.createElement('div');
        header.className = 'confirm-dialog__header';
        const icon = document.createElement('span');
        icon.className = 'confirm-dialog__icon';
        icon.innerHTML = `<i class="fa ${variant === 'danger' ? 'fa-exclamation-triangle' : 'fa-sliders'}"></i>`;
        const heading = document.createElement('h3');
        heading.className = 'confirm-dialog__title';
        heading.textContent = title;
        header.append(icon, heading);

        const body = document.createElement('div');
        body.className = 'confirm-dialog__body';
        const text = document.createElement('p');
        text.textContent = message;
        body.appendChild(text);

        const footer = document.createElement('div');
        footer.className = 'confirm-dialog__footer';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'confirm-dialog__button confirm-dialog__button--cancel';
        cancelBtn.textContent = options.cancelText || '取消';
        cancelBtn.onclick = () => settle(false);
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'confirm-dialog__button confirm-dialog__button--confirm';
        confirmBtn.textContent = options.confirmText || '确定';
        confirmBtn.onclick = () => settle(true);
        footer.append(cancelBtn, confirmBtn);
        dialog.append(header, body, footer);
        overlay.appendChild(dialog);
        overlay.onclick = event => { if (event.target === overlay) settle(false); };
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKeydown);
        setTimeout(() => (variant === 'danger' ? cancelBtn : confirmBtn).focus(), 0);
    });
}

// ========== Theme Management ==========

const WORKSPACE_PREFERENCE_KEY = 'serverInspectWorkspacePreferences';
const DEFAULT_WORKSPACE_PREFERENCES = { layout: 'sidebar', style: 'mist', accent: 'blue' };
const VALID_WORKSPACE_LAYOUTS = ['sidebar', 'topnav', 'sidebar-tabs'];
const workspaceTabs = new Map();
let activeWorkspaceTab = null;
let workspaceTabMenuOpen = false;
let workspaceTabMenuPosition = null;

function workspacePreferences() {
    try {
        const preferences = { ...DEFAULT_WORKSPACE_PREFERENCES, ...JSON.parse(localStorage.getItem(WORKSPACE_PREFERENCE_KEY) || '{}') };
        return VALID_WORKSPACE_LAYOUTS.includes(preferences.layout)
            ? preferences
            : { ...preferences, layout: 'sidebar' };
    } catch (_) {
        return { ...DEFAULT_WORKSPACE_PREFERENCES };
    }
}

function applyWorkspacePreferences(preferences = workspacePreferences()) {
    const body = document.getElementById('appBody');
    if (!body) return;
    body.classList.remove('layout-sidebar', 'layout-topnav', 'layout-sidebar-tabs', 'style-mist', 'style-midnight', 'style-warm', 'accent-blue', 'accent-green', 'accent-purple', 'accent-orange', 'accent-red', 'accent-cyan');
    body.classList.add(`layout-${preferences.layout}`, `style-${preferences.style}`, `accent-${preferences.accent}`);
    document.getElementById('workspaceTabs')?.classList.toggle('hidden', preferences.layout !== 'sidebar-tabs');
    if (preferences.layout !== 'sidebar-tabs') {
        workspaceTabMenuOpen = false;
        workspaceTabMenuPosition = null;
    }
    renderWorkspaceTabs();
    document.querySelectorAll('[data-layout]').forEach(button => button.classList.toggle('is-active', button.dataset.layout === preferences.layout));
    document.querySelectorAll('[data-style]').forEach(button => button.classList.toggle('is-active', button.dataset.style === preferences.style));
    document.querySelectorAll('[data-accent]').forEach(button => button.classList.toggle('is-active', button.dataset.accent === preferences.accent));
}

function saveWorkspacePreferences(update) {
    const preferences = workspacePreferences();
    if (Object.prototype.hasOwnProperty.call(update, 'layout') && !VALID_WORKSPACE_LAYOUTS.includes(update.layout)) return;
    Object.assign(preferences, update);
    localStorage.setItem(WORKSPACE_PREFERENCE_KEY, JSON.stringify(preferences));
    applyWorkspacePreferences(preferences);
}

function setLayoutMode(layout) { saveWorkspacePreferences({ layout }); }
function setVisualStyle(style) { saveWorkspacePreferences({ style }); }
function setAccentTheme(accent) { saveWorkspacePreferences({ accent }); }
function resetWorkspacePreferences() {
    localStorage.removeItem(WORKSPACE_PREFERENCE_KEY);
    applyWorkspacePreferences(DEFAULT_WORKSPACE_PREFERENCES);
}

// 兼容旧的内联调用方式。
function setTheme(themeName) {
    setAccentTheme(String(themeName || 'theme-blue').replace('theme-', ''));
}

function setPageContext(title, description = '', eyebrow = 'OPERATIONS CONSOLE', status = '实时监控已连接') {
    const titleEl = document.getElementById('appPageTitle');
    const descriptionEl = document.getElementById('appPageDescription');
    const eyebrowEl = document.getElementById('appPageEyebrow');
    const statusEl = document.getElementById('appPageStatus');
    if (titleEl) titleEl.textContent = title;
    if (descriptionEl) descriptionEl.textContent = description;
    if (eyebrowEl) eyebrowEl.textContent = eyebrow;
    if (statusEl) statusEl.textContent = status;
}

function isSidebarTabsLayout() {
    return document.body.classList.contains('layout-sidebar-tabs');
}

function workspaceTabMeta(button, type) {
    return {
        type,
        label: button?.textContent.trim().replace(/\s+/g, ' ') || type,
        icon: button?.querySelector('i')?.className || 'fa fa-file-o',
    };
}

function workspaceEscapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderWorkspaceTabs() {
    const container = document.getElementById('workspaceTabs');
    if (!container || !isSidebarTabsLayout()) return;
    if (!workspaceTabs.size) {
        container.innerHTML = '<span class="workspace-tabs__empty">从左侧菜单打开工作页</span>';
        return;
    }
    const tabs = [...workspaceTabs.values()];
    const activeIndex = tabs.findIndex(tab => tab.type === activeWorkspaceTab);
    const hasRightTabs = activeIndex >= 0 && activeIndex < tabs.length - 1;
    const tabHtml = tabs.map(tab => `<button type="button" class="workspace-tab ${tab.type === activeWorkspaceTab ? 'is-active' : ''}" data-workspace-tab="${tab.type}"><i class="${tab.icon}"></i><span>${workspaceEscapeHtml(tab.label)}</span><b data-workspace-tab-close="${tab.type}" aria-label="关闭 ${workspaceEscapeHtml(tab.label)}"><i class="fa fa-times"></i></b></button>`).join('');
    const menuStyle = workspaceTabMenuPosition
        ? `style="top:${workspaceTabMenuPosition.top}px;left:${workspaceTabMenuPosition.left}px"`
        : '';
    container.innerHTML = `${tabHtml}<div class="workspace-tab-actions"><button type="button" class="workspace-tab-actions__trigger ${workspaceTabMenuOpen ? 'is-open' : ''}" data-workspace-tab-menu aria-expanded="${workspaceTabMenuOpen}" aria-label="页签关闭操作"><i class="fa fa-chevron-down"></i></button></div>${workspaceTabMenuOpen ? `<div class="workspace-tab-actions__menu is-open" ${menuStyle} role="menu"><button type="button" data-workspace-tab-action="current" ${activeIndex < 0 ? 'disabled' : ''}>关闭当前页签</button><button type="button" data-workspace-tab-action="others" ${tabs.length < 2 || activeIndex < 0 ? 'disabled' : ''}>关闭其他页签</button><button type="button" data-workspace-tab-action="right" ${hasRightTabs ? '' : 'disabled'}>关闭右侧页签</button><button type="button" data-workspace-tab-action="all" ${tabs.length ? '' : 'disabled'}>全部关闭</button></div>` : ''}`;
    bindWorkspaceTabControls(container);
}

function bindWorkspaceTabControls(container) {
    const trigger = container.querySelector('[data-workspace-tab-menu]');
    if (trigger) {
        trigger.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            workspaceTabMenuOpen = !workspaceTabMenuOpen;
            if (workspaceTabMenuOpen) {
                const rect = trigger.getBoundingClientRect();
                workspaceTabMenuPosition = {
                    top: Math.min(window.innerHeight - 190, rect.bottom + 7),
                    left: Math.max(8, rect.right - 148),
                };
            } else {
                workspaceTabMenuPosition = null;
            }
            renderWorkspaceTabs();
        };
    }
    container.querySelectorAll('[data-workspace-tab-action]').forEach(button => {
        button.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            closeWorkspaceTabs(button.dataset.workspaceTabAction);
        };
    });
}

function registerWorkspaceTab(button, type) {
    if (!isSidebarTabsLayout()) return;
    if (!workspaceTabs.has(type)) workspaceTabs.set(type, workspaceTabMeta(button, type));
    activeWorkspaceTab = type;
    renderWorkspaceTabs();
}

function closeWorkspaceTab(type) {
    if (document.body.classList.contains('inspection-running')) return;
    workspaceTabMenuOpen = false;
    workspaceTabMenuPosition = null;
    const tabs = [...workspaceTabs.keys()];
    const index = tabs.indexOf(type);
    const wasActive = activeWorkspaceTab === type;
    workspaceTabs.delete(type);
    if (!wasActive) return renderWorkspaceTabs();
    const nextType = tabs[index + 1] || tabs[index - 1];
    if (nextType) activateWorkspaceTab(nextType);
    else { activeWorkspaceTab = null; hideAllContent(); document.getElementById('homeContent')?.classList.remove('hidden'); setActiveButton(null); renderWorkspaceTabs(); }
}

function closeWorkspaceTabs(action) {
    if (document.body.classList.contains('inspection-running') || !workspaceTabs.size) return;
    const types = [...workspaceTabs.keys()];
    const activeIndex = types.indexOf(activeWorkspaceTab);
    workspaceTabMenuOpen = false;
    workspaceTabMenuPosition = null;
    if (action === 'current' && activeWorkspaceTab) return closeWorkspaceTab(activeWorkspaceTab);
    if (action === 'others' && activeWorkspaceTab) {
        for (const type of types) if (type !== activeWorkspaceTab) workspaceTabs.delete(type);
        return renderWorkspaceTabs();
    }
    if (action === 'right' && activeIndex >= 0) {
        for (const type of types.slice(activeIndex + 1)) workspaceTabs.delete(type);
        return renderWorkspaceTabs();
    }
    if (action === 'all') {
        workspaceTabs.clear();
        activeWorkspaceTab = null;
        hideAllContent();
        document.getElementById('homeContent')?.classList.remove('hidden');
        setActiveButton(null);
        renderWorkspaceTabs();
    }
}

function navigationButtonForType(type) {
    return type === 'full'
        ? document.getElementById('fullInspectBtn')
        : document.querySelector(`.inspect-btn[data-type="${type}"]`);
}

function openWorkspaceType(type, button = navigationButtonForType(type)) {
    if (document.body.classList.contains('inspection-running')) return;
    registerWorkspaceTab(button, type);
    if (type === 'full') window.runInspection('full');
    else if (type === 'config') window.showConfig();
    else if (type === 'sql_inspect') window.showSqlInspect();
    else if (type === 'custom_inspect') window.showCustomInspect();
    else if (type === 'logs') window.showLogs();
    else if (type === 'arthas') window.showArthas();
    else if (type === 'user_permission') window.showUserPermission();
    else if (type === 'pg_config') window.showPgConfig();
    else window.runInspection(type);
    setActiveButton(button);
}

function activateWorkspaceTab(type) {
    const button = navigationButtonForType(type);
    if (!workspaceTabs.has(type) || !button) return;
    openWorkspaceType(type, button);
}

function setInspectionNavigationLocked(locked) {
    document.body.classList.toggle('inspection-running', locked);
    document.querySelectorAll('.inspect-btn, #clearLogsBtn, .workspace-tab').forEach(control => {
        if (locked) {
            control.dataset.inspectionWasDisabled = control.disabled ? 'true' : 'false';
            control.disabled = true;
            control.setAttribute('aria-disabled', 'true');
        } else {
            if (control.dataset.inspectionWasDisabled === 'false') control.disabled = false;
            control.removeAttribute('aria-disabled');
            delete control.dataset.inspectionWasDisabled;
        }
    });
}

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

    if (activeBtn) {
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
    const userPermissionContent = document.getElementById('userPermissionContent');
    const homeContent = document.getElementById('homeContent');

    if (loading) loading.classList.add('hidden');
    if (results) results.classList.add('hidden');
    if (homeContent) homeContent.classList.add('hidden');
    if (configContent) configContent.classList.add('hidden');
    if (inspectionContent) inspectionContent.classList.add('hidden');
    if (sqlInspectContent) sqlInspectContent.classList.add('hidden');
    if (customInspectContent) customInspectContent.classList.add('hidden');
    if (logContent) logContent.classList.add('hidden');
    if (arthasContent) arthasContent.classList.add('hidden');
    if (pgConfigContent) pgConfigContent.classList.add('hidden');
    if (userPermissionContent) userPermissionContent.classList.add('hidden');
}

// ========== Unified Select Controls ==========

function enhanceSelectControl(select) {
    if (!select || select.closest('.select-control')) return;

    const compact = select.classList.contains('px-2') || select.classList.contains('py-1');
    const wrapper = document.createElement('span');
    wrapper.className = `select-control${select.classList.contains('w-full') ? ' select-control--full' : ''}${compact ? ' select-control--compact' : ''}`;
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    select.classList.add('select-control__native');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'select-control__toggle';
    toggle.tabIndex = -1;
    toggle.setAttribute('aria-hidden', 'true');
    toggle.innerHTML = '<i class="fa fa-chevron-down" aria-hidden="true"></i>';
    toggle.addEventListener('mousedown', event => event.preventDefault());
    toggle.addEventListener('click', () => {
        if (select.disabled) return;
        select.focus({ preventScroll: true });
        try {
            if (typeof select.showPicker === 'function') select.showPicker();
            else select.click();
        } catch (_) {
            select.click();
        }
    });
    wrapper.appendChild(toggle);
}

function enhanceSelectControls(root = document) {
    if (root instanceof HTMLSelectElement) enhanceSelectControl(root);
    root.querySelectorAll?.('select').forEach(enhanceSelectControl);
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

    enhanceSelectControls();
    const selectObserver = new MutationObserver(records => {
        records.forEach(record => {
            record.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) enhanceSelectControls(node);
            });
        });
    });
    selectObserver.observe(document.body, { childList: true, subtree: true });
});

// Load saved workspace preferences on page load
document.addEventListener('DOMContentLoaded', function () {
    applyWorkspacePreferences();
});

// Main page initialization: navigation buttons, scheduler config, date config, etc.
document.addEventListener('DOMContentLoaded', function () {
    const fullInspectBtn = document.getElementById('fullInspectBtn');
    const inspectBtns = document.querySelectorAll('.inspect-btn');

    // Default: show neutral welcome page. Feature pages open only from an authorized menu click.
    const homeContent = document.getElementById('homeContent');
    if (homeContent) homeContent.classList.remove('hidden');
    setActiveButton(null);
    setPageContext('服务器巡检中心', '选择已授权的功能开始工作', 'OPERATIONS CONSOLE', '实时监控已连接');

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
            openWorkspaceType('full', this);
        });
    }

    // Individual inspect buttons (sidebar navigation)
    inspectBtns.forEach(btn => {
        // fullInspectBtn 同时带 .inspect-btn 类，已由上方专用监听器处理；
        // 此处若再绑定会一次点击触发两次 runInspection，产生两条完整巡检日志
        if (btn.id === 'fullInspectBtn') return;
        btn.addEventListener('click', function () {
            openWorkspaceType(this.getAttribute('data-type'), this);
        });
    });

    const workspaceTabsEl = document.getElementById('workspaceTabs');
    if (workspaceTabsEl) {
        workspaceTabsEl.addEventListener('click', event => {
            if (document.body.classList.contains('inspection-running')) return;
            const close = event.target.closest('[data-workspace-tab-close]');
            if (close) return closeWorkspaceTab(close.dataset.workspaceTabClose);
            const tab = event.target.closest('[data-workspace-tab]');
            if (tab) activateWorkspaceTab(tab.dataset.workspaceTab);
        });
        document.addEventListener('click', event => {
            if (workspaceTabMenuOpen && !workspaceTabsEl.contains(event.target)) {
                workspaceTabMenuOpen = false;
                workspaceTabMenuPosition = null;
                renderWorkspaceTabs();
            }
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && workspaceTabMenuOpen) {
                workspaceTabMenuOpen = false;
                workspaceTabMenuPosition = null;
                renderWorkspaceTabs();
            }
        });
    }

    // Clear logs button
    const clearLogsBtn = document.getElementById('clearLogsBtn');
    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', async function () {
            const confirmed = await showConfirm('确定要清理慢SQL日志吗？', '确认清理');
            if (confirmed) {
                fetch('/api/clear_slow_sql_logs', { method: 'POST' })
                    .then(response => response.json())
                    .then(data => {
                        if (data.success) {
                            const failed = (data.results || []).filter(r => !r.success);
                            if (failed.length > 0) {
                                const detail = failed.map(r => `${r.container}(${r.message})`).join(' | ');
                                showToast('部分容器清理失败: ' + detail, 'warning');
                            } else {
                                showToast('慢SQL日志清理完成', 'success');
                            }
                        } else {
                            showToast(data.message || '清理慢SQL日志失败', 'error');
                        }
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
    setPageContext('系统配置', '按权限管理巡检、告警、通知和数据连接配置', 'SYSTEM SETTINGS', '配置工作区');
    hideAllContent();
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');
    const configContent = document.getElementById('configContent');
    loading.classList.add('hidden');
    results.classList.remove('hidden');
    configContent.classList.remove('hidden');
    if (typeof showAuthorizedConfig === 'function') showAuthorizedConfig();
};

window.showSqlInspect = function () {
    setPageContext('数据稽查', '构建并执行专项数据一致性查询', 'DATA VALIDATION', '查询工作区');
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
    setPageContext('自定义SQL', '从已授权的脚本库执行预设查询', 'SAVED QUERIES', '脚本工作区');
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
    setPageContext('PG配置', '维护 PostgreSQL 容器参数与运行状态', 'DATABASE OPERATIONS', '容器配置');
    hideAllContent();
    const results = document.getElementById('results');
    const pgConfigContent = document.getElementById('pgConfigContent');
    if (results) results.classList.remove('hidden');
    if (pgConfigContent) pgConfigContent.classList.remove('hidden');
    if (typeof loadPgConfig === 'function') loadPgConfig();
};

window.showLogs = function () {
    setPageContext('巡检日志', '筛选、导出和查看巡检运行记录', 'ACTIVITY & AUDIT', '审计工作区');
    hideAllContent();
    const results = document.getElementById('results');
    const logContent = document.getElementById('logContent');
    if (results) results.classList.remove('hidden');
    if (logContent) logContent.classList.remove('hidden');
};

window.setActiveButton = setActiveButton;
window.setInspectionNavigationLocked = setInspectionNavigationLocked;
window.showToast = showToast;
window.showConfirm = showConfirm;
window.setTheme = setTheme;
window.setLayoutMode = setLayoutMode;
window.setVisualStyle = setVisualStyle;
window.setAccentTheme = setAccentTheme;
window.resetWorkspacePreferences = resetWorkspacePreferences;
window.applyWorkspacePreferences = applyWorkspacePreferences;
window.hideAllContent = hideAllContent;