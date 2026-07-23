/**
 * log_view.js - 巡检日志查看页面
 * 依赖: app.js (showToast, showConfirm, hideAllContent)
 *
 * 功能：
 * - 分页查询巡检日志（支持多条件筛选）
 * - 查看日志详情（解析后非开发人员友好的内容）
 * - 清理历史日志
 */

// ========== 模块状态 ==========

let logCurrentPage = 1;
const logPageSize = 20;
let logTotalPages = 1;
let logTotalCount = 0;

// ========== 类型/状态中文映射 ==========

const LOG_TYPE_LABELS = {
    system: '系统巡检',
    sql: 'SQL稽查',
    mes_hanging: 'MES吊挂稽核',
    custom_script: '自定义稽核',
};

const LOG_SOURCE_LABELS = {
    manual: '手动',
    scheduled: '定时巡检',
    daily: '日常巡检',
    real_time: '实时监控',
};

const LOG_STATUS_STYLES = {
    success: 'bg-green-100 text-green-700',
    warning: 'bg-yellow-100 text-yellow-700',
    critical: 'bg-red-100 text-red-700',
    error: 'bg-red-100 text-red-700',
};

const LOG_STATUS_LABELS = {
    success: '正常',
    warning: '告警',
    critical: '严重',
    error: '失败',
};

// ========== 页面切换 ==========

window.showLogs = function () {
    hideAllContent();
    const results = document.getElementById('results');
    const logContent = document.getElementById('logContent');
    if (results) results.classList.remove('hidden');
    if (logContent) logContent.classList.remove('hidden');
    loadLogs(1);
};

// ========== 加载日志列表 ==========

function loadLogs(page) {
    logCurrentPage = page || 1;

    const params = new URLSearchParams();
    params.set('page', logCurrentPage);
    params.set('page_size', logPageSize);

    const type = document.getElementById('logFilterType').value;
    const source = document.getElementById('logFilterSource').value;
    const status = document.getElementById('logFilterStatus').value;
    const operator = document.getElementById('logFilterOperator').value.trim();
    const keyword = document.getElementById('logFilterKeyword').value.trim();
    const start = document.getElementById('logFilterStart').value;
    const end = document.getElementById('logFilterEnd').value;

    if (type) params.set('inspection_type', type);
    if (source) params.set('trigger_source', source);
    if (status) params.set('status', status);
    if (operator) params.set('operator', operator);
    if (keyword) params.set('keyword', keyword);
    if (start) params.set('start_time', start.replace('T', ' ') + ':00');
    if (end) params.set('end_time', end.replace('T', ' ') + ':00');

    const bodyEl = document.getElementById('logTableBody');
    bodyEl.innerHTML = '<tr><td colspan="9" class="px-4 py-8 text-center text-sm text-gray-400"><i class="fa fa-spinner fa-spin mr-2"></i>加载中...</td></tr>';

    fetch(`/api/logs?${params.toString()}`)
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                bodyEl.innerHTML = `<tr><td colspan="9" class="px-4 py-8 text-center text-sm text-gray-500">${data.error || '查询失败'}</td></tr>`;
                updatePagination(0, 1);
                return;
            }
            renderLogList(data.logs || []);
            logTotalCount = data.total || 0;
            logTotalPages = Math.max(1, Math.ceil(logTotalCount / logPageSize));
            updatePagination(logTotalCount, logCurrentPage);
        })
        .catch(err => {
            console.error('加载日志失败:', err);
            bodyEl.innerHTML = `<tr><td colspan="9" class="px-4 py-8 text-center text-sm text-red-500">加载失败，请检查网络连接</td></tr>`;
        });
}

// ========== 渲染日志列表 ==========

function renderLogList(logs) {
    const bodyEl = document.getElementById('logTableBody');
    if (logs.length === 0) {
        bodyEl.innerHTML = '<tr><td colspan="9" class="px-4 py-8 text-center text-sm text-gray-500">暂无日志记录</td></tr>';
        return;
    }

    let html = '';
    logs.forEach(log => {
        const time = formatLogTime(log.start_time || log.created_at);
        const typeLabel = LOG_TYPE_LABELS[log.inspection_type] || log.inspection_type || '-';
        const sourceLabel = LOG_SOURCE_LABELS[log.trigger_source] || log.trigger_source || '-';
        const statusLabel = LOG_STATUS_LABELS[log.status] || log.status || '-';
        const statusCls = LOG_STATUS_STYLES[log.status] || 'bg-gray-100 text-gray-700';
        const target = log.target || '-';
        const summary = log.summary || '';
        const operator = log.operator || '系统';
        const recordCount = log.record_count !== null && log.record_count !== undefined ? log.record_count : '-';
        const duration = log.duration || '-';

        html += `<tr class="hover:bg-gray-50 cursor-pointer" onclick="window.openLogDetail(${log.id})">
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${time}</td>
            <td class="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">${typeLabel}</td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${sourceLabel}</td>
            <td class="px-4 py-3 text-sm whitespace-nowrap">
                <span class="px-2 py-1 rounded-full text-xs font-medium ${statusCls}">${statusLabel}</span>
            </td>
            <td class="px-4 py-3 text-sm text-gray-700">
                <div class="font-medium">${escapeHtml(target)}</div>
                ${summary ? `<div class="text-xs text-gray-500 mt-1">${escapeHtml(summary)}</div>` : ''}
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${escapeHtml(operator)}</td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${recordCount}</td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${duration}</td>
            <td class="px-4 py-3 text-sm whitespace-nowrap">
                <button class="text-primary hover:underline" onclick="event.stopPropagation(); window.openLogDetail(${log.id})">查看</button>
            </td>
        </tr>`;
    });
    bodyEl.innerHTML = html;
}

// ========== 分页控件 ==========

function updatePagination(total, page) {
    const pageInfo = document.getElementById('logPageInfo');
    const pageNum = document.getElementById('logPageNum');
    const prevBtn = document.getElementById('logPrevBtn');
    const nextBtn = document.getElementById('logNextBtn');

    pageInfo.textContent = `共 ${total} 条记录`;
    pageNum.textContent = `${page} / ${logTotalPages}`;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= logTotalPages;
}

// ========== 日志详情 ==========

window.openLogDetail = function (logId) {
    const drawer = document.getElementById('logDetailDrawer');
    const content = document.getElementById('logDetailContent');
    const title = document.getElementById('logDetailTitle');
    drawer.classList.remove('hidden');
    title.textContent = '日志详情';
    content.innerHTML = '<div class="text-center text-gray-400 py-8"><i class="fa fa-spinner fa-spin mr-2"></i>加载中...</div>';

    fetch(`/api/logs/${logId}`)
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                content.innerHTML = `<div class="text-center text-red-500 py-8">${data.error || '加载失败'}</div>`;
                return;
            }
            renderLogDetail(data.log, data.parsed);
        })
        .catch(err => {
            console.error('加载日志详情失败:', err);
            content.innerHTML = '<div class="text-center text-red-500 py-8">加载失败，请检查网络连接</div>';
        });
};

function renderLogDetail(log, parsed) {
    const content = document.getElementById('logDetailContent');
    const title = document.getElementById('logDetailTitle');
    title.textContent = parsed.type_label + ' 详情';

    let html = '';

    // 摘要卡片
    html += `<div class="bg-gray-50 rounded-lg p-4 border border-gray-200">
        <div class="flex items-center justify-between mb-2">
            <span class="text-sm font-semibold text-gray-800">${escapeHtml(parsed.summary_text || '无摘要')}</span>
            <span class="px-2 py-1 rounded-full text-xs font-medium ${LOG_STATUS_STYLES[log.status] || 'bg-gray-100 text-gray-700'}">${parsed.status_label}</span>
        </div>
    </div>`;

    // 元信息
    html += '<div class="bg-white border border-gray-200 rounded-lg p-4"><h4 class="text-sm font-semibold text-gray-700 mb-3">基本信息</h4><div class="grid grid-cols-2 gap-3">';
    parsed.meta.forEach(m => {
        html += `<div><span class="text-xs text-gray-500 block">${m.label}</span><span class="text-sm text-gray-800 break-all">${escapeHtml(String(m.value))}</span></div>`;
    });
    html += '</div></div>';

    // 各分区
    (parsed.sections || []).forEach(section => {
        html += renderSection(section);
    });

    content.innerHTML = html;
}

function renderSection(section) {
    let html = `<div class="bg-white border border-gray-200 rounded-lg p-4">
        <h4 class="text-sm font-semibold text-gray-700 mb-3 flex items-center">
            <i class="fa fa-folder-open-o mr-2" style="color: var(--primary-color);"></i>${escapeHtml(section.title)}
        </h4>`;

    if (section.type === 'keyvalue') {
        html += '<div class="space-y-2">';
        (section.items || []).forEach(item => {
            const highlight = item.highlight ? 'bg-red-50 text-red-700 font-medium' : 'text-gray-800';
            html += `<div class="flex">
                <span class="text-xs text-gray-500 w-24 flex-shrink-0 pt-1">${escapeHtml(item.label)}</span>
                <span class="text-sm ${highlight} ${item.mono ? 'font-mono bg-gray-50 px-2 py-1 rounded' : ''} break-all flex-1">${escapeHtml(String(item.value))}</span>
            </div>`;
        });
        html += '</div>';
    } else if (section.type === 'messages') {
        html += '<div class="space-y-2">';
        (section.items || []).forEach(item => {
            const cls = item.level === 'criticals' ? 'border-red-200 bg-red-50' :
                item.level === 'warnings' ? 'border-yellow-200 bg-yellow-50' :
                    item.level === 'normals' ? 'border-green-200 bg-green-50' :
                        'border-gray-200 bg-gray-50';
            const icon = item.level === 'criticals' ? 'fa-times-circle text-red-500' :
                item.level === 'warnings' ? 'fa-exclamation-circle text-yellow-500' :
                    item.level === 'normals' ? 'fa-check-circle text-green-500' :
                        'fa-info-circle text-gray-400';
            html += `<div class="flex items-start p-2 border rounded ${cls}">
                <i class="fa ${icon} mt-0.5 mr-2"></i>
                <span class="text-sm text-gray-700 break-all flex-1">${escapeHtml(item.text)}</span>
            </div>`;
        });
        html += '</div>';
    } else if (section.type === 'table') {
        const cols = section.columns || [];
        const rows = section.rows || [];
        html += '<div class="overflow-x-auto"><table class="min-w-full divide-y divide-gray-200 text-xs"><thead class="bg-gray-50"><tr>';
        cols.forEach(c => {
            html += `<th class="px-3 py-2 text-left font-medium text-gray-500 uppercase">${escapeHtml(String(c))}</th>`;
        });
        html += '</tr></thead><tbody class="bg-white divide-y divide-gray-100">';
        if (rows.length === 0) {
            html += `<tr><td colspan="${cols.length}" class="px-3 py-3 text-center text-gray-400">无数据</td></tr>`;
        } else {
            rows.forEach(row => {
                html += '<tr>';
                cols.forEach((c, i) => {
                    let val = Array.isArray(row) ? row[i] : (row[c] !== undefined ? row[c] : '');
                    if (val === null || val === undefined) val = '';
                    html += `<td class="px-3 py-2 text-gray-700 whitespace-nowrap break-all">${escapeHtml(String(val))}</td>`;
                });
                html += '</tr>';
            });
        }
        html += '</tbody></table></div>';
        if (section.truncated) {
            html += '<p class="text-xs text-gray-400 mt-2">注：数据较多，仅展示部分记录，完整数据请查看原始日志</p>';
        }
    } else if (section.type === 'raw') {
        html += `<pre class="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-3 overflow-x-auto whitespace-pre-wrap">${escapeHtml(section.text || '')}</pre>`;
        if (section.truncated) {
            html += '<p class="text-xs text-gray-400 mt-2">注：内容较长，已截断展示</p>';
        }
    }
    html += '</div>';
    return html;
}

// ========== 清理日志 ==========

function openClearModal() {
    document.getElementById('logClearModal').classList.remove('hidden');
}

function closeClearModal() {
    document.getElementById('logClearModal').classList.add('hidden');
}

function confirmClearLogs() {
    const mode = document.querySelector('input[name="logClearMode"]:checked').value;
    const body = {};
    if (mode === 'keep_days') {
        const days = parseInt(document.getElementById('logClearKeepDays').value) || 30;
        body.keep_days = days;
    } else {
        const date = document.getElementById('logClearBeforeDate').value;
        if (!date) {
            showToast('请选择清理日期', 'warning');
            return;
        }
        body.before_date = date + ' 00:00:00';
    }

    fetch('/api/logs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast(data.message || '清理完成', 'success');
                closeClearModal();
                loadLogs(1);
            } else {
                showToast(data.error || '清理失败', 'error');
            }
        })
        .catch(err => {
            console.error('清理日志失败:', err);
            showToast('清理失败，请检查网络连接', 'error');
        });
}

// ========== 工具函数 ==========

function formatLogTime(timeStr) {
    if (!timeStr) return '-';
    return String(timeStr).replace('T', ' ').substring(0, 19);
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ========== 事件绑定 ==========

document.addEventListener('DOMContentLoaded', function () {
    const searchBtn = document.getElementById('logSearchBtn');
    const resetBtn = document.getElementById('logResetBtn');
    const clearBtn = document.getElementById('logClearBtn');
    const prevBtn = document.getElementById('logPrevBtn');
    const nextBtn = document.getElementById('logNextBtn');
    const detailCloseBtn = document.getElementById('logDetailCloseBtn');
    const detailOverlay = document.getElementById('logDetailOverlay');
    const clearCancelBtn = document.getElementById('logClearCancelBtn');
    const clearConfirmBtn = document.getElementById('logClearConfirmBtn');

    if (searchBtn) searchBtn.addEventListener('click', () => loadLogs(1));
    if (resetBtn) resetBtn.addEventListener('click', () => {
        document.getElementById('logFilterType').value = '';
        document.getElementById('logFilterSource').value = '';
        document.getElementById('logFilterStatus').value = '';
        document.getElementById('logFilterOperator').value = '';
        document.getElementById('logFilterKeyword').value = '';
        document.getElementById('logFilterStart').value = '';
        document.getElementById('logFilterEnd').value = '';
        loadLogs(1);
    });
    if (clearBtn) clearBtn.addEventListener('click', openClearModal);
    if (prevBtn) prevBtn.addEventListener('click', () => { if (logCurrentPage > 1) loadLogs(logCurrentPage - 1); });
    if (nextBtn) nextBtn.addEventListener('click', () => { if (logCurrentPage < logTotalPages) loadLogs(logCurrentPage + 1); });

    if (detailCloseBtn) detailCloseBtn.addEventListener('click', () => {
        document.getElementById('logDetailDrawer').classList.add('hidden');
    });
    if (detailOverlay) detailOverlay.addEventListener('click', () => {
        document.getElementById('logDetailDrawer').classList.add('hidden');
    });
    if (clearCancelBtn) clearCancelBtn.addEventListener('click', closeClearModal);
    if (clearConfirmBtn) clearConfirmBtn.addEventListener('click', confirmClearLogs);

    // 关键词回车查询
    const keywordInput = document.getElementById('logFilterKeyword');
    if (keywordInput) keywordInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') loadLogs(1);
    });

    // ESC 关闭抽屉/弹窗
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.getElementById('logDetailDrawer').classList.add('hidden');
            document.getElementById('logClearModal').classList.add('hidden');
        }
    });
});
