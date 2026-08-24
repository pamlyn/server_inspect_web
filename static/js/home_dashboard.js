(() => {
    const STATUS_META = {
        success: ['正常', 'home-status--success'], warning: ['存在告警', 'home-status--warning'],
        critical: ['严重告警', 'home-status--critical'], error: ['巡检失败', 'home-status--critical'],
    };
    const ACTIONS = [
        { permission: 'inspection', type: 'full', icon: 'fa-refresh', title: '完整巡检', text: '立即执行全部检查' },
        { permission: 'logs', type: 'logs', icon: 'fa-history', title: '巡检日志', text: '查看近期运行记录' },
        { permission: 'sql_inspect', type: 'sql_inspect', icon: 'fa-search', title: '数据稽查', text: '执行专项一致性检查' },
        { permission: 'custom_sql', type: 'custom_inspect', icon: 'fa-code', title: '自定义 SQL', text: '运行已授权脚本' },
        { permission: 'config_basic_alert', type: 'config', icon: 'fa-cog', title: '系统配置', text: '调整巡检与告警策略' },
        { permission: 'pg_config', type: 'pg_config', icon: 'fa-database', title: 'PG 配置', text: '管理 PostgreSQL 连接' },
        { adminOnly: true, type: 'user_permission', icon: 'fa-users', title: '人员与权限', text: '管理人员、角色与授权' },
    ];

    function byId(id) { return document.getElementById(id); }
    function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
    function formatTime(value) {
        if (!value) return '暂无记录';
        const date = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function setText(id, value) { const element = byId(id); if (element) element.textContent = value; }
    function setUpdated(text) { setText('homeDashboardUpdated', text); }
    function setHealth(kind, detail) {
        const card = byId('homeHealthStatus')?.closest('.home-status-card');
        card?.classList.remove('home-status-card--success', 'home-status-card--warning', 'home-status-card--critical');
        if (kind) card?.classList.add(`home-status-card--${kind}`);
        setText('homeHealthStatus', kind === 'critical' ? '需要处理' : kind === 'warning' ? '注意观察' : kind === 'success' ? '运行正常' : '暂未获取');
        setText('homeHealthDetail', detail);
    }
    function latestMetric(samples, key) {
        for (let index = samples.length - 1; index >= 0; index -= 1) if (Number.isFinite(Number(samples[index]?.[key]))) return samples[index];
        return null;
    }
    function renderResourceChart(samples) {
        const container = byId('homeResourceChart');
        if (!container) return;
        if (!samples.length) {
            container.innerHTML = '<div class="home-empty"><i class="fa fa-line-chart"></i><span>暂无可用的资源历史数据</span></div>';
            const insights = byId('homeResourceInsights');
            if (insights) insights.innerHTML = '';
            return;
        }
        const width = 680, height = 210, padding = { top: 18, right: 12, bottom: 28, left: 34 };
        const points = key => samples.map((item, index) => ({ x: padding.left + index * (width - padding.left - padding.right) / Math.max(1, samples.length - 1), y: padding.top + (100 - Math.max(0, Math.min(100, Number(item[key]) || 0))) * (height - padding.top - padding.bottom) / 100 })).filter(point => Number.isFinite(point.y));
        const polyline = key => points(key).map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
        const ticks = [0, 50, 100].map(value => { const y = padding.top + (100 - value) * (height - padding.top - padding.bottom) / 100; return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"/><text x="2" y="${y + 4}">${value}%</text>`; }).join('');
        const first = samples[0]?.time, last = samples[samples.length - 1]?.time;
        const metricSamples = key => samples.map(sample => ({ value: Number(sample[key]), time: sample.time })).filter(sample => Number.isFinite(sample.value));
        const cpuSamples = metricSamples('cpu'), memorySamples = metricSamples('memory');
        const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        const maximumSample = values => values.length ? values.reduce((highest, item) => item.value > highest.value ? item : highest) : null;
        const minimumSample = values => values.length ? values.reduce((lowest, item) => item.value < lowest.value ? item : lowest) : null;
        const metricText = value => value === null || value === undefined ? '--' : `${value.toFixed(1)}%`;
        const insight = (title, icon, samplesForMetric, accent) => {
            const values = samplesForMetric.map(item => item.value);
            const current = samplesForMetric.at(-1), peak = maximumSample(samplesForMetric), low = minimumSample(samplesForMetric);
            const mean = average(values), spread = peak && low ? peak.value - low.value : null;
            const health = peak?.value >= 90 ? ['需要关注', 'is-critical'] : peak?.value >= 75 ? ['存在波动', 'is-warning'] : ['运行平稳', 'is-success'];
            return `<article class="home-resource-insight home-resource-insight--${accent}"><header><span class="home-resource-insight__icon"><i class="fa ${icon}"></i></span><div><p>${title} 洞察 · 近 24 小时</p><strong class="${health[1]}">${health[0]}</strong></div></header><div class="home-resource-insight__metrics"><div><span>当前</span><b>${metricText(current?.value)}</b></div><div><span>均值</span><b>${metricText(mean)}</b></div><div><span>峰值</span><b>${metricText(peak?.value)}</b></div><div><span>低值</span><b>${metricText(low?.value)}</b></div></div><footer><span>波动范围 ${metricText(spread)}</span><span>峰值于 ${escapeHtml(formatTime(peak?.time))}</span></footer></article>`;
        };
        container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="CPU 与内存使用率趋势"><g class="home-chart-grid">${ticks}</g><polyline class="home-chart-line home-chart-line--cpu" points="${polyline('cpu')}"></polyline><polyline class="home-chart-line home-chart-line--memory" points="${polyline('memory')}"></polyline><text class="home-chart-time" x="${padding.left}" y="${height - 7}">${escapeHtml(formatTime(first))}</text><text class="home-chart-time" text-anchor="end" x="${width - padding.right}" y="${height - 7}">${escapeHtml(formatTime(last))}</text></svg><div class="home-chart-legend"><span><b class="home-chart-legend__cpu"></b>CPU</span><span><b class="home-chart-legend__memory"></b>内存</span><span>${samples.length} 个样本</span><span class="home-chart-window">${escapeHtml(formatTime(first))} 至 ${escapeHtml(formatTime(last))}</span></div>`;
        const insights = byId('homeResourceInsights');
        if (insights) insights.innerHTML = `${insight('CPU', 'fa-microchip', cpuSamples, 'cpu')}${insight('内存', 'fa-braille', memorySamples, 'memory')}`;
    }
    function renderActions(permissions) {
        const container = byId('homeQuickActions');
        if (!container) return;
        const actions = ACTIONS.filter(action => action.adminOnly ? window.authAccess?.is_admin === true : permissions.includes(action.permission));
        container.innerHTML = actions.length ? actions.map(action => `<button type="button" class="home-quick-action" data-home-open="${action.type}"><i class="fa ${action.icon}"></i><span><strong>${action.title}</strong><small>${action.text}</small></span></button>`).join('') : '<div class="home-empty home-empty--compact"><i class="fa fa-lock"></i><span>当前账号暂无可执行操作</span></div>';
    }
    function renderLogs(logs) {
        const container = byId('homeRecentLogs');
        if (!container) return;
        if (!logs.length) { container.innerHTML = '<div class="home-empty home-empty--compact"><i class="fa fa-clock-o"></i><span>暂无巡检记录</span></div>'; return; }
        container.innerHTML = logs.map(log => {
            const meta = STATUS_META[log.status] || ['未知', 'home-status--unknown'];
            const source = log.source_label || log.trigger_source || '未知来源';
            const operator = log.operator || '系统';
            return `<button type="button" class="home-inspection-row" data-home-open="logs"><span class="home-inspection-row__status ${meta[1]}"><i></i>${meta[0]}</span><span><strong>${escapeHtml(log.type_label || log.inspection_type || '巡检')}</strong><small>${escapeHtml(log.target_label || log.target || '服务器')}</small></span><span><strong>${escapeHtml(source)}</strong><small>${escapeHtml(operator)}</small></span><span class="home-inspection-row__summary"><strong>${escapeHtml(log.target_label || log.target || '服务器')}</strong><small>${escapeHtml(log.summary || '无摘要信息')}</small></span><span><strong>${escapeHtml(formatTime(log.start_time))}</strong></span><span><strong>${escapeHtml(log.duration || '--')}</strong></span></button>`;
        }).join('');
    }
    function renderSevenDaySummary(summary) {
        const counts = summary.counts || {};
        const labels = [['success', '正常'], ['warning', '告警'], ['critical', '严重'], ['error', '失败']];
        setText('homeSevenDayTotal', String(summary.total ?? '--'));
        setText('homeSevenDayAbnormal', String(summary.abnormal ?? '--'));
        setText('homeSevenDayRate', `${Number(summary.abnormal_rate || 0).toFixed(1)}%`);
        const breakdown = byId('homeSevenDayBreakdown');
        if (!breakdown) return;
        if (!summary.total) { breakdown.innerHTML = '<span>近 7 天暂无巡检记录</span>'; return; }
        breakdown.innerHTML = labels.map(([status, label]) => {
            const count = Number(counts[status] || 0);
            const rate = (count * 100 / summary.total).toFixed(1);
            return `<span class="home-summary-status home-summary-status--${status}"><b>${label}</b><strong>${count}</strong><small>${rate}%</small></span>`;
        }).join('');
    }
    function showSevenDaySummaryUnavailable(message) {
        setText('homeSevenDayTotal', '--'); setText('homeSevenDayAbnormal', '--'); setText('homeSevenDayRate', '--');
        const breakdown = byId('homeSevenDayBreakdown');
        if (breakdown) breakdown.innerHTML = `<span>${escapeHtml(message)}</span>`;
    }
    async function loadSevenDaySummary() {
        const response = await fetch('/api/logs/summary?days=7');
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || '巡检统计加载失败');
        renderSevenDaySummary(data);
        return data;
    }
    async function loadResource() {
        const response = await fetch('/api/logs/resource-history?range_seconds=86400&bucket_seconds=0');
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || '资源数据加载失败');
        const samples = data.samples || [], cpu = latestMetric(samples, 'cpu'), memory = latestMetric(samples, 'memory');
        setText('homeCpuValue', cpu ? `${Number(cpu.cpu).toFixed(1)}%` : '--'); setText('homeCpuDetail', cpu ? `采样于 ${formatTime(cpu.time)}` : '暂无 CPU 样本');
        setText('homeMemoryValue', memory ? `${Number(memory.memory).toFixed(1)}%` : '--'); setText('homeMemoryDetail', memory ? `采样于 ${formatTime(memory.time)}` : '暂无内存样本');
        setText('homeResourceSource', data.source === 'continuous_database' ? '连续采集' : data.source === 'continuous_local' ? '本地采集' : '巡检记录');
        renderResourceChart(samples); return samples.length;
    }
    async function loadLogs() {
        const response = await fetch('/api/logs?page=1&page_size=5');
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || '巡检记录加载失败');
        const logs = data.logs || [], latest = logs[0], meta = STATUS_META[latest?.status] || ['暂无记录', ''];
        setText('homeLatestStatus', meta[0]); setText('homeLatestDetail', latest ? `${latest.type_label || '巡检'} · ${formatTime(latest.start_time)}` : '暂无巡检记录');
        renderLogs(logs); return latest?.status || null;
    }
    async function loadHomeDashboard() {
        const home = byId('homeContent'); if (!home || home.classList.contains('hidden')) return;
        setUpdated('正在同步数据');
        const access = window.authAccess || await window.loadAccess?.();
        const permissions = access?.permissions || [];
        if (!permissions.includes('dashboard')) return;
        renderActions(permissions);
        try {
            const response = await fetch('/api/logs/dashboard');
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || '运行总览数据加载失败');
            const samples = data.resource?.samples || [];
            const cpu = latestMetric(samples, 'cpu'), memory = latestMetric(samples, 'memory');
            setText('homeCpuValue', cpu ? `${Number(cpu.cpu).toFixed(1)}%` : '--');
            setText('homeCpuDetail', cpu ? `采样于 ${formatTime(cpu.time)}` : '暂无 CPU 样本');
            setText('homeMemoryValue', memory ? `${Number(memory.memory).toFixed(1)}%` : '--');
            setText('homeMemoryDetail', memory ? `采样于 ${formatTime(memory.time)}` : '暂无内存样本');
            setText('homeResourceSource', data.resource?.source === 'continuous_database' ? '连续采集' : data.resource?.source === 'continuous_local' ? '本地采集' : '巡检记录');
            renderResourceChart(samples);
            const logs = data.logs || {};
            const recent = logs.recent || [];
            const status = recent[0]?.status;
            const meta = STATUS_META[status] || ['暂无记录', ''];
            setText('homeLatestStatus', meta[0]);
            setText('homeLatestDetail', recent[0] ? `${recent[0].type_label || '巡检'} · ${formatTime(recent[0].start_time)}` : '暂无巡检记录');
            renderLogs(recent);
            if (logs.summary) renderSevenDaySummary(logs.summary);
            else showSevenDaySummaryUnavailable('日志库未启用或暂无可用记录');
            setHealth(status === 'critical' || status === 'error' ? 'critical' : status === 'warning' ? 'warning' : samples.length ? 'success' : '', status ? '依据最近巡检与资源数据' : '等待首条巡检记录');
            setUpdated(`更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
        } catch (error) { setHealth('', error.message); showSevenDaySummaryUnavailable(error.message); setUpdated('数据暂不可用'); }
    }
    function openHomeTarget(type) {
        if (type === 'logs' && !window.authAccess?.permissions?.includes('logs')) {
            showToast('当前账号没有巡检日志权限', 'warning');
            return;
        }
        if (type) window.openWorkspaceType?.(type);
    }
    document.addEventListener('DOMContentLoaded', () => {
        byId('refreshHomeDashboard')?.addEventListener('click', loadHomeDashboard);
        document.addEventListener('click', event => { const button = event.target.closest('[data-home-open]'); if (button) openHomeTarget(button.dataset.homeOpen); });
        window.loadHomeDashboard = loadHomeDashboard;
        document.addEventListener('authaccessloaded', () => {
            if (!byId('homeContent')?.classList.contains('hidden')) loadHomeDashboard();
        });
    });
})();
