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
let logPageSize = 20;
let logTotalPages = 1;
let logTotalCount = 0;
let logCurrentDetailId = null;
let resourceHistoryRanges = [];
let resourceHistoryRangeIndex = 0;
let resourceHistoryZoomTimer = null;
const resourceHistoryCache = new Map();
let resourceHistoryCurrentMetadata = null;

// ========== 类型/状态中文映射 ==========

const LOG_TYPE_LABELS = {
    system: '系统巡检',
    sql: 'SQL稽查',
    mes_hanging: 'MES吊挂稽核',
    custom_script: '自定义SQL',
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
    if (typeof setPageContext === 'function') {
        setPageContext('巡检日志', '筛选、导出和查看巡检运行记录', 'ACTIVITY & AUDIT', '审计工作区');
    }
    hideAllContent();
    const results = document.getElementById('results');
    const logContent = document.getElementById('logContent');
    if (results) results.classList.remove('hidden');
    if (logContent) logContent.classList.remove('hidden');
    loadResourceHistory();
    loadLogs(1);
};

// ========== 资源历史趋势 ==========

function buildResourceHistoryRanges(collectionIntervalSeconds, maxRangeSeconds) {
    const minimumSeconds = Math.max(collectionIntervalSeconds * 12, collectionIntervalSeconds);
    const multipliers = [1, 2, 5, 10, 30, 60, 120, 360, 720, 1440, 2880, 4320, 8640, 21600, 43200, 86400, 129600];
    const ranges = [...new Set(multipliers.map(multiplier => Math.min(maxRangeSeconds, minimumSeconds * multiplier)))].sort((left, right) => left - right);
    if (!ranges.includes(maxRangeSeconds)) ranges.push(maxRangeSeconds);
    return ranges.map(seconds => ({ seconds, label: formatResourceDuration(seconds) }));
}

function currentResourceHistoryRange() {
    return resourceHistoryRanges[resourceHistoryRangeIndex] || { seconds: 24 * 3600, label: '24小时' };
}

function selectDefaultResourceHistoryRange() {
    const target = 24 * 3600;
    resourceHistoryRangeIndex = resourceHistoryRanges.reduce((closestIndex, range, index) =>
        Math.abs(range.seconds - target) < Math.abs(resourceHistoryRanges[closestIndex].seconds - target) ? index : closestIndex, 0);
}

function formatResourceDuration(seconds) {
    if (seconds >= 86400) return `${Math.round(seconds / 86400)}天`;
    if (seconds >= 3600) return `${Math.round(seconds / 3600)}小时`;
    return `${Math.max(1, Math.round(seconds / 60))}分钟`;
}

function setResourceHistoryZoom(nextIndex) {
    const boundedIndex = Math.max(0, Math.min(resourceHistoryRanges.length - 1, nextIndex));
    if (boundedIndex === resourceHistoryRangeIndex) return;
    resourceHistoryRangeIndex = boundedIndex;
    const range = currentResourceHistoryRange();
    if ([...resourceHistoryCache.keys()].some(seconds => seconds >= range.seconds)) {
        renderCachedResourceHistory();
    } else {
        loadResourceHistory();
    }
}

function bindResourceHistoryZoomControls() {
    document.querySelectorAll('[data-resource-history-zoom]').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.resourceHistoryZoom;
            if (action === 'in') setResourceHistoryZoom(resourceHistoryRangeIndex - 1);
            if (action === 'out') setResourceHistoryZoom(resourceHistoryRangeIndex + 1);
            if (action === 'reset') {
                const target = 24 * 3600;
                const defaultIndex = resourceHistoryRanges.reduce((closestIndex, range, index) =>
                    Math.abs(range.seconds - target) < Math.abs(resourceHistoryRanges[closestIndex].seconds - target) ? index : closestIndex, 0);
                setResourceHistoryZoom(defaultIndex);
            }
        });
    });
    document.querySelectorAll('.resource-trend-chart').forEach(chart => {
        chart.addEventListener('wheel', event => {
            event.preventDefault();
            const nextIndex = resourceHistoryRangeIndex + (event.deltaY > 0 ? 1 : -1);
            if (nextIndex === resourceHistoryRangeIndex) return;
            clearTimeout(resourceHistoryZoomTimer);
            resourceHistoryZoomTimer = setTimeout(() => setResourceHistoryZoom(nextIndex), 110);
        }, { passive: false });
    });
}

function bindResourceHistoryPointTooltips() {
    document.querySelectorAll('.resource-trend-chart').forEach(chart => {
        const points = JSON.parse(chart.dataset.points || '[]');
        const focusLine = chart.querySelector('[data-resource-trend-focus-line]');
        const focusPoint = chart.querySelector('[data-resource-trend-focus-point]');
        const tooltip = chart.closest('.resource-trend-card')?.querySelector('[data-resource-trend-tooltip]');
        if (!points.length || !focusLine || !focusPoint || !tooltip) return;

        const hide = () => {
            focusLine.classList.add('hidden');
            focusPoint.classList.add('hidden');
            tooltip.classList.add('hidden');
        };
        chart.addEventListener('pointermove', event => {
            const rect = chart.getBoundingClientRect();
            const x = (event.clientX - rect.left) * 520 / rect.width;
            const point = points.reduce((closest, current) => Math.abs(current.x - x) < Math.abs(closest.x - x) ? current : closest);
            focusLine.setAttribute('x1', point.x);
            focusLine.setAttribute('x2', point.x);
            focusPoint.setAttribute('cx', point.x);
            focusPoint.setAttribute('cy', point.y);
            focusLine.classList.remove('hidden');
            focusPoint.classList.remove('hidden');
            tooltip.querySelector('strong').textContent = chart.dataset.title || '资源指标';
            tooltip.querySelector('span').textContent = `${formatLogTime(point.time)} · ${point.value.toFixed(1)}%`;
            tooltip.style.left = `${Math.max(12, Math.min(window.innerWidth - 12, event.clientX))}px`;
            tooltip.style.top = `${Math.max(12, event.clientY - 12)}px`;
            tooltip.classList.remove('hidden');
        });
        chart.addEventListener('pointerleave', hide);
    });
}

function loadResourceHistory() {
    const range = currentResourceHistoryRange();
    if (resourceHistoryCache.has(range.seconds)) {
        resourceHistoryCurrentMetadata = resourceHistoryCache.get(range.seconds).metadata;
        renderCachedResourceHistory();
        return;
    }
    const charts = document.getElementById('resourceHistoryCharts');
    if (charts && !resourceHistoryCurrentMetadata) {
        charts.innerHTML = '<div class="resource-history-loading"><i class="fa fa-spinner fa-spin mr-2"></i>加载历史样本...</div>';
    }
    fetch(`/api/logs/resource-history?range_seconds=${range.seconds}&bucket_seconds=0`)
        .then(response => response.json())
        .then(data => {
            if (!data.success) throw new Error(data.error || '加载失败');
            if (!resourceHistoryRanges.length) {
                resourceHistoryRanges = buildResourceHistoryRanges(data.collection_interval_seconds || 60, data.max_range_seconds || 90 * 24 * 3600);
                selectDefaultResourceHistoryRange();
            }
            resourceHistoryCache.set(data.range_seconds, { samples: data.samples || [], metadata: data });
            resourceHistoryCurrentMetadata = data;
            renderCachedResourceHistory();
        })
        .catch(error => {
            const meta = document.getElementById('resourceHistoryMeta');
            if (meta) meta.textContent = '无法加载资源历史，请确认日志库已启用。';
            if (!resourceHistoryCurrentMetadata && charts) {
                charts.innerHTML = `<div class="resource-history-empty"><i class="fa fa-line-chart"></i><span>${escapeHtml(error.message)}</span></div>`;
            }
        });
}

function renderCachedResourceHistory() {
    const range = currentResourceHistoryRange();
    const candidates = [...resourceHistoryCache.entries()].filter(([seconds]) => seconds >= range.seconds);
    if (!candidates.length) {
        loadResourceHistory();
        return;
    }
    const [cachedSeconds, cached] = candidates.sort(([left], [right]) => left - right)[0];
    const latestTime = new Date(String(cached.samples[cached.samples.length - 1]?.time || '').replace(' ', 'T')).getTime();
    const cutoff = latestTime - range.seconds * 1000;
    const samples = cachedSeconds === range.seconds
        ? cached.samples
        : cached.samples.filter(sample => new Date(String(sample.time).replace(' ', 'T')).getTime() >= cutoff);
    renderResourceHistory(samples, { ...cached.metadata, range_seconds: range.seconds, cached: cachedSeconds !== range.seconds });
}

function renderResourceHistory(samples, metadata = {}) {
    const charts = document.getElementById('resourceHistoryCharts');
    const meta = document.getElementById('resourceHistoryMeta');
    if (!charts || !meta) return;
    const cpuSamples = samples.filter(sample => Number.isFinite(sample.cpu));
    const memorySamples = samples.filter(sample => Number.isFinite(sample.memory));
    if (!cpuSamples.length && !memorySamples.length) {
        meta.textContent = '尚无连续资源样本。配置并启用日志保存数据库后，系统会按采集间隔自动记录本机 CPU 与内存。';
        charts.innerHTML = '<div class="resource-history-empty"><i class="fa fa-line-chart"></i><span>资源历史采集启动后，这里将持续展示实际 CPU 与内存波动。</span></div>';
        return;
    }
    const latestTime = samples[samples.length - 1].time || '--';
    const effectiveInterval = formatResourceDuration(metadata.effective_bucket_seconds || metadata.collection_interval_seconds || 60);
    const rawCount = metadata.raw_sample_count || samples.length;
    if (String(metadata.source || '').startsWith('continuous')) {
        const collectionInterval = metadata.collection_interval_seconds || 60;
        meta.textContent = `展示 ${samples.length} 个时间桶（原始样本 ${rawCount} 条），图表间隔 ${effectiveInterval}；采集间隔约 ${collectionInterval} 秒，最新采样：${latestTime}`;
    } else {
        meta.textContent = `展示 ${samples.length} 个时间桶（原始样本 ${rawCount} 条），图表间隔 ${effectiveInterval}；当前数据来自旧巡检记录，最新时间：${latestTime}`;
    }
    const rangeLabel = currentResourceHistoryRange().label;
    charts.innerHTML = renderTrendChart('CPU 忙碌率', 'cpu', cpuSamples, '#5b6cff', rangeLabel, effectiveInterval) + renderTrendChart('内存使用率', 'memory', memorySamples, '#0f9f75', rangeLabel, effectiveInterval);
    bindResourceHistoryZoomControls();
    bindResourceHistoryPointTooltips();
}

function renderTrendChart(title, key, samples, color, rangeLabel, effectiveInterval) {
    if (!samples.length) {
        return `<section class="resource-trend-card"><div class="resource-trend-title"><span>${title}</span><strong>暂无样本</strong></div><div class="resource-trend-no-data">该指标尚未被历史巡检采集。</div></section>`;
    }
    const width = 520;
    const height = 160;
    const padding = { top: 18, right: 14, bottom: 28, left: 34 };
    const values = samples.map(sample => Math.max(0, Math.min(100, Number(sample[key]))));
    const latest = values[values.length - 1];
    const peak = Math.max(...values);
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const timestamps = samples.map(sample => new Date(String(sample.time).replace(' ', 'T')).getTime());
    const firstTimestamp = timestamps[0];
    const lastTimestamp = timestamps[timestamps.length - 1];
    const timeSpan = Math.max(1, lastTimestamp - firstTimestamp);
    const pointData = values.map((value, index) => {
        const ratio = timestamps[index] && lastTimestamp !== firstTimestamp
            ? (timestamps[index] - firstTimestamp) / timeSpan
            : (values.length === 1 ? 1 : index / (values.length - 1));
        return {
            x: Number((padding.left + plotWidth * ratio).toFixed(1)),
            y: Number((padding.top + plotHeight - (value / 100 * plotHeight)).toFixed(1)),
            time: samples[index].time,
            value,
        };
    });
    const points = pointData.map(point => `${point.x},${point.y}`).join(' ');
    const labels = [0, 50, 100].map(value => {
        const y = padding.top + plotHeight - (value / 100 * plotHeight);
        return `<g><line x1="${padding.left}" x2="${width - padding.right}" y1="${y}" y2="${y}" class="resource-chart-grid"/><text x="2" y="${y + 4}" class="resource-chart-label">${value}%</text></g>`;
    }).join('');
    const firstTime = escapeHtml(formatLogTime(samples[0].time));
    const lastTime = escapeHtml(formatLogTime(samples[samples.length - 1].time));
    const zoomControls = `<div class="resource-trend-tools" aria-label="${title}时间范围缩放">
        <span class="resource-trend-window">${rangeLabel} · ${effectiveInterval}</span>
        <button type="button" data-resource-history-zoom="in" aria-label="放大时间范围" title="放大：查看更短时间" ${resourceHistoryRangeIndex === 0 ? 'disabled' : ''}><i class="fa fa-search-plus" aria-hidden="true"></i></button>
        <button type="button" data-resource-history-zoom="out" aria-label="缩小时间范围" title="缩小：查看更长时间" ${resourceHistoryRangeIndex === resourceHistoryRanges.length - 1 ? 'disabled' : ''}><i class="fa fa-search-minus" aria-hidden="true"></i></button>
        <button type="button" data-resource-history-zoom="reset" aria-label="还原为24小时" title="还原为24小时" ${currentResourceHistoryRange().seconds === 24 * 3600 ? 'disabled' : ''}><i class="fa fa-undo" aria-hidden="true"></i></button>
    </div>`;
    return `<section class="resource-trend-card">
        <div class="resource-trend-title"><span>${title}</span><strong style="color:${color}">${latest.toFixed(1)}%</strong></div>
        <div class="resource-trend-summary"><span>峰值 ${peak.toFixed(1)}%</span><span>${samples.length} 个样本</span>${zoomControls}</div>
        <div class="resource-trend-tooltip hidden" data-resource-trend-tooltip><strong></strong><span></span></div>
        <svg class="resource-trend-chart" data-title="${escapeHtml(title)}" data-points="${escapeHtml(JSON.stringify(pointData))}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}历史趋势图；移动鼠标查看采样时间和百分比，可使用滚轮缩放时间范围">
            ${labels}<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            <line class="resource-chart-focus hidden" data-resource-trend-focus-line y1="${padding.top}" y2="${padding.top + plotHeight}" />
            <circle class="resource-chart-focus-point hidden" data-resource-trend-focus-point r="5" fill="${color}" />
            <rect class="resource-chart-hit-area" x="${padding.left}" y="${padding.top}" width="${plotWidth}" height="${plotHeight}" fill="transparent" />
            <circle cx="${pointData[pointData.length - 1].x}" cy="${pointData[pointData.length - 1].y}" r="4" fill="${color}" />
            <text x="${padding.left}" y="${height - 7}" class="resource-chart-label">${firstTime}</text><text x="${width - padding.right}" y="${height - 7}" text-anchor="end" class="resource-chart-label">${lastTime}</text>
        </svg>
    </section>`;
}

// ========== 查询条件 ==========

function buildLogFilterParams() {
    const params = new URLSearchParams();
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
    return params;
}

// ========== 加载日志列表 ==========

function loadLogs(page) {
    logCurrentPage = page || 1;

    const params = buildLogFilterParams();
    params.set('page', logCurrentPage);
    params.set('page_size', logPageSize);

    const bodyEl = document.getElementById('logTableBody');
    bodyEl.innerHTML = '<tr><td colspan="9" class="px-4 py-8 text-center text-sm text-gray-400"><i class="fa fa-spinner fa-spin mr-2"></i>加载中...</td></tr>';

    fetch(`/api/logs?${params.toString()}`)
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                bodyEl.innerHTML = `<tr><td colspan="9" class="px-4 py-8 text-center text-sm text-gray-500">${data.error || '查询失败'}</td></tr>`;
                logTotalPages = 1;
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

function exportLogs() {
    const params = buildLogFilterParams();
    window.open(`/api/logs/export?${params.toString()}`, '_blank');
}

function printLogDetail() {
    if (!logCurrentDetailId) return;

    const title = document.getElementById('logDetailTitle').textContent || '巡检日志详情';
    const content = document.getElementById('logDetailContent').innerHTML;
    const printWindow = window.open('', '_blank', 'width=1000,height=800');
    if (!printWindow) {
        showToast('打印窗口被浏览器拦截，请允许弹窗后重试', 'warning');
        return;
    }

    printWindow.document.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1f2937; font-family: "Microsoft YaHei", "微软雅黑", sans-serif; font-size: 12px; line-height: 1.5; }
    h1 { margin: 0 0 18px; font-size: 20px; }
    h4 { margin: 0 0 10px; font-size: 14px; }
    .bg-white, .bg-gray-50 { background: #fff !important; }
    .border, .border-gray-100, .border-gray-200 { border: 1px solid #d1d5db !important; }
    .rounded, .rounded-lg { border-radius: 4px; }
    .p-2 { padding: 8px; } .p-3 { padding: 10px; } .p-4 { padding: 12px; }
    .mb-2 { margin-bottom: 8px; } .mb-3 { margin-bottom: 10px; }
    .space-y-2 > * + * { margin-top: 8px; } .space-y-4 > * + * { margin-top: 14px; }
    .grid { display: grid; } .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } .gap-3 { gap: 10px; }
    .flex { display: flex; } .items-center { align-items: center; } .items-start { align-items: flex-start; }
    .justify-between { justify-content: space-between; }
    .text-xs { font-size: 11px; } .text-sm { font-size: 12px; }
    .font-semibold, .font-medium { font-weight: 600; }
    .text-gray-400, .text-gray-500, .text-gray-600 { color: #4b5563; }
    .text-red-700 { color: #b91c1c; } .text-green-700 { color: #15803d; } .text-yellow-700 { color: #a16207; }
    .bg-red-50 { background: #fef2f2 !important; } .bg-green-50 { background: #f0fdf4 !important; } .bg-yellow-50 { background: #fefce8 !important; }
    .break-all { overflow-wrap: anywhere; word-break: break-word; }
    .overflow-x-auto { overflow: visible; }
    table { width: 100%; border-collapse: collapse; table-layout: auto; }
    th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; white-space: normal !important; }
    th { background: #f3f4f6; font-weight: 600; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .log-detail-summary, .log-detail-section { border: 1px solid #d1d5db; border-radius: 6px; margin-bottom: 12px; }
    .log-detail-summary { padding: 12px; } .log-detail-summary__topline { display:flex; justify-content:space-between; gap:10px; } .log-detail-summary__text { margin:9px 0 0; font-size:13px; font-weight:600; }
    .log-detail-section__heading { display:flex; gap:7px; align-items:center; padding:9px 11px; border-bottom:1px solid #d1d5db; background:#f3f4f6; }.log-detail-section__heading h4 { margin:0; }
    .log-detail-meta-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }.log-detail-meta-item { padding:9px 11px; border-right:1px solid #d1d5db; border-bottom:1px solid #d1d5db; }.log-detail-meta-item span, .log-detail-keyvalue > span { display:block; color:#4b5563; font-size:10px; }.log-detail-meta-item strong { display:block; margin-top:3px; overflow-wrap:anywhere; }
    .log-detail-keyvalues, .log-detail-messages { padding:10px 11px; }.log-detail-keyvalue { display:grid; grid-template-columns:110px minmax(0,1fr); gap:9px; padding:7px 0; border-bottom:1px dashed #d1d5db; }.log-detail-keyvalue:last-child { border-bottom:0; }.log-detail-keyvalue strong { overflow-wrap:anywhere; }.log-detail-keyvalue .is-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .log-detail-message { display:flex; gap:7px; margin-bottom:7px; padding:8px; border:1px solid #d1d5db; border-radius:4px; }.log-detail-message:last-child { margin-bottom:0; }.log-detail-table-wrap { overflow:visible; }.log-detail-table { width:100%; border-collapse:collapse; }.log-detail-table th, .log-detail-table td { padding:6px 8px; border:1px solid #d1d5db; text-align:left; vertical-align:top; overflow-wrap:anywhere; }.log-detail-table th { background:#f3f4f6; }.log-detail-code { margin:0; padding:10px; background:#f3f4f6; color:#1f2937; font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere; }.log-detail-notice { margin:8px 11px; color:#4b5563; font-size:11px; }
    .fa { display:none; }
    @media print { .log-detail-meta-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
</head>
<body><h1>${escapeHtml(title)}</h1>${content}</body>
</html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    printWindow.onafterprint = () => printWindow.close();
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
        const target = log.target_label || log.target || '-';
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
    const jumpInput = document.getElementById('logJumpInput');
    const jumpBtn = document.getElementById('logJumpBtn');

    pageInfo.textContent = `共 ${total} 条记录`;
    pageNum.textContent = `${page} / ${logTotalPages}`;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= logTotalPages;

    // 跳转页输入框：同步当前页码与上限；总页数≤1 时禁用跳转
    if (jumpInput) {
        jumpInput.max = logTotalPages;
        jumpInput.value = page;
    }
    if (jumpBtn) jumpBtn.disabled = logTotalPages <= 1;
}

// ========== 日志详情 ==========

window.openLogDetail = function (logId) {
    const drawer = document.getElementById('logDetailDrawer');
    const content = document.getElementById('logDetailContent');
    const title = document.getElementById('logDetailTitle');
    const detailPrintBtn = document.getElementById('logDetailPrintBtn');
    drawer.classList.remove('hidden');
    logCurrentDetailId = null;
    if (detailPrintBtn) detailPrintBtn.classList.add('hidden');
    title.textContent = '日志详情';
    content.innerHTML = '<div class="text-center text-gray-400 py-8"><i class="fa fa-spinner fa-spin mr-2"></i>加载中...</div>';

    fetch(`/api/logs/${logId}`)
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                content.innerHTML = `<div class="text-center text-red-500 py-8">${data.error || '加载失败'}</div>`;
                return;
            }
            logCurrentDetailId = logId;
            if (detailPrintBtn) detailPrintBtn.classList.remove('hidden');
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
    const typeLabel = parsed.type_label || '巡检日志';
    const statusClass = LOG_STATUS_STYLES[log.status] || 'bg-gray-100 text-gray-700';
    title.textContent = `${typeLabel}详情`;

    let html = `<section class="log-detail-summary">
        <div class="log-detail-summary__topline">
            <span class="log-detail-summary__type"><i class="fa fa-clipboard" aria-hidden="true"></i>${escapeHtml(typeLabel)}</span>
            <span class="log-detail-summary__status ${statusClass}">${escapeHtml(parsed.status_label || LOG_STATUS_LABELS[log.status] || '未知')}</span>
        </div>
        <p class="log-detail-summary__text">${escapeHtml(parsed.summary_text || '本次巡检未生成摘要信息')}</p>
    </section>`;

    if ((parsed.meta || []).length) {
        html += '<section class="log-detail-section log-detail-section--meta"><div class="log-detail-section__heading"><i class="fa fa-info-circle" aria-hidden="true"></i><h4>基本信息</h4></div><div class="log-detail-meta-grid">';
        parsed.meta.forEach(meta => {
            html += `<div class="log-detail-meta-item"><span>${escapeHtml(meta.label)}</span><strong>${escapeHtml(String(meta.value ?? '-'))}</strong></div>`;
        });
        html += '</div></section>';
    }

    (parsed.sections || []).forEach(section => {
        html += renderSection(section);
    });
    content.innerHTML = html;
}

function renderSection(section) {
    let html = `<section class="log-detail-section log-detail-section--${escapeHtml(section.type || 'content')}">
        <div class="log-detail-section__heading"><i class="fa fa-folder-open-o" aria-hidden="true"></i><h4>${escapeHtml(section.title)}</h4></div>`;

    if (section.type === 'keyvalue') {
        html += '<div class="log-detail-keyvalues">';
        (section.items || []).forEach(item => {
            html += `<div class="log-detail-keyvalue${item.highlight ? ' is-highlighted' : ''}"><span>${escapeHtml(item.label)}</span><strong class="${item.mono ? 'is-mono' : ''}">${escapeHtml(String(item.value))}</strong></div>`;
        });
        html += '</div>';
    } else if (section.type === 'messages') {
        html += '<div class="log-detail-messages">';
        (section.items || []).forEach(item => {
            const level = ['criticals', 'warnings', 'normals'].includes(item.level) ? item.level : 'info';
            const icon = level === 'criticals' ? 'fa-times-circle' : level === 'warnings' ? 'fa-exclamation-circle' : level === 'normals' ? 'fa-check-circle' : 'fa-info-circle';
            html += `<div class="log-detail-message is-${level}"><i class="fa ${icon}" aria-hidden="true"></i><span>${escapeHtml(item.text)}</span></div>`;
        });
        html += '</div>';
    } else if (section.type === 'table') {
        const cols = section.columns || [];
        const rows = section.rows || [];
        html += '<div class="log-detail-table-wrap"><table class="log-detail-table"><thead><tr>';
        cols.forEach(column => { html += `<th>${escapeHtml(String(column))}</th>`; });
        html += '</tr></thead><tbody>';
        if (!rows.length) {
            html += `<tr><td colspan="${cols.length}" class="log-detail-table__empty">无数据</td></tr>`;
        } else {
            rows.forEach(row => {
                html += '<tr>';
                cols.forEach((column, index) => {
                    let value = Array.isArray(row) ? row[index] : (row[column] !== undefined ? row[column] : '');
                    html += `<td>${escapeHtml(String(value ?? ''))}</td>`;
                });
                html += '</tr>';
            });
        }
        html += '</tbody></table></div>';
        if (section.truncated) html += '<p class="log-detail-notice"><i class="fa fa-info-circle" aria-hidden="true"></i>数据较多，仅展示部分记录，完整数据请查看原始日志。</p>';
    } else if (section.type === 'raw') {
        html += `<pre class="log-detail-code">${escapeHtml(section.text || '')}</pre>`;
        if (section.truncated) html += '<p class="log-detail-notice"><i class="fa fa-info-circle" aria-hidden="true"></i>内容较长，已截断展示。</p>';
    }
    return html + '</section>';
}

function closeLogDetail() {
    logCurrentDetailId = null;
    document.getElementById('logDetailDrawer').classList.add('hidden');
    const detailPrintBtn = document.getElementById('logDetailPrintBtn');
    if (detailPrintBtn) detailPrintBtn.classList.add('hidden');
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
    const exportBtn = document.getElementById('logExportBtn');
    const prevBtn = document.getElementById('logPrevBtn');
    const nextBtn = document.getElementById('logNextBtn');
    const pageSizeSelect = document.getElementById('logPageSizeSelect');
    const jumpInput = document.getElementById('logJumpInput');
    const jumpBtn = document.getElementById('logJumpBtn');
    const detailCloseBtn = document.getElementById('logDetailCloseBtn');
    const detailPrintBtn = document.getElementById('logDetailPrintBtn');
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
    if (exportBtn) exportBtn.addEventListener('click', exportLogs);
    if (detailPrintBtn) detailPrintBtn.addEventListener('click', printLogDetail);
    if (prevBtn) prevBtn.addEventListener('click', () => { if (logCurrentPage > 1) loadLogs(logCurrentPage - 1); });
    if (nextBtn) nextBtn.addEventListener('click', () => { if (logCurrentPage < logTotalPages) loadLogs(logCurrentPage + 1); });

    // 每页条数：切换后重置到第 1 页（后端 page_size 上限 200，下拉已约束）
    if (pageSizeSelect) pageSizeSelect.addEventListener('change', () => {
        logPageSize = parseInt(pageSizeSelect.value, 10) || 20;
        loadLogs(1);
    });
    // 跳转页码：越界提示；回车等同点击跳转
    if (jumpBtn) jumpBtn.addEventListener('click', () => {
        const target = parseInt(jumpInput && jumpInput.value, 10);
        if (isNaN(target) || target < 1 || target > logTotalPages) {
            showToast(`请输入 1~${logTotalPages} 之间的页码`, 'warning');
            return;
        }
        if (target !== logCurrentPage) loadLogs(target);
    });
    if (jumpInput) jumpInput.addEventListener('keypress', e => {
        if (e.key === 'Enter' && jumpBtn && !jumpBtn.disabled) jumpBtn.click();
    });

    if (detailCloseBtn) detailCloseBtn.addEventListener('click', closeLogDetail);
    if (detailOverlay) detailOverlay.addEventListener('click', closeLogDetail);
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
            closeLogDetail();
            document.getElementById('logClearModal').classList.add('hidden');
        }
    });
});
