/**
 * 看板独立页（/dashboard/<id>）。
 *
 * 只负责取数 + 调用 custom_dashboard.js 暴露的 DashboardRender 渲染，
 * 图表/表格/指标的绘制逻辑不在这里重复实现。
 */
(function () {
    const root = document.getElementById('standaloneRoot');
    if (!root || !window.DashboardRender) return;

    const { blockShell, renderBlockBody, escapeHtml, bindTableScroll, bindMarquee } = window.DashboardRender;
    const dashboardId = root.dataset.dashboardId;
    const refreshSeconds = Number(root.dataset.refresh) || 0;
    const grid = document.getElementById('standaloneGrid');
    const stamp = document.getElementById('standaloneStamp');

    let dashboard = null;
    let timer = null;

    function el(id) { return document.getElementById(id); }

    function notice(text) {
        grid.innerHTML = `<div class="dash-stage-notice" style="grid-column:span 12;">
            <i class="fa fa-exclamation-triangle"></i><span>${escapeHtml(text)}</span></div>`;
    }

    function render(payloadMap) {
        if (!dashboard) return;
        const blocks = dashboard.blocks || [];
        if (!blocks.length) {
            notice('这个看板还没有内容块，回到主界面点「编辑」加一块。');
            return;
        }
        grid.innerHTML = blocks.map(block => blockShell(block, payloadMap ? payloadMap[block.id] : null)).join('');
        // innerHTML 重写会丢掉旧监听，所以每次渲染后都要重新绑一遍滚动加载。
        bindTableScroll(grid); bindMarquee(grid);
    }

    async function loadConfig() {
        const response = await fetch(`/api/custom_dashboards/${encodeURIComponent(dashboardId)}`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '看板加载失败');
        dashboard = data.dashboard;
        render(null);
    }

    async function execute() {
        if (!dashboard) return;
        try {
            const response = await fetch(`/api/custom_dashboards/${encodeURIComponent(dashboardId)}/execute`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            const data = await response.json();
            if (!data.success) { notice(data.error || '看板执行失败'); return; }
            const map = {};
            (data.results || []).forEach(item => { map[item.block_id] = item; });
            render(map);
            if (stamp) stamp.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
        } catch (error) {
            notice(`看板执行失败: ${error.message || error}`);
        }
    }

    async function reloadBlock(blockId) {
        const body = document.querySelector(`[data-block-body="${blockId}"]`);
        const block = (dashboard.blocks || []).find(item => item.id === blockId);
        if (!body || !block) return;
        body.innerHTML = '<div class="dash-block-loading"><i class="fa fa-spinner fa-spin"></i>加载中…</div>';
        try {
            const response = await fetch(
                `/api/custom_dashboards/${encodeURIComponent(dashboardId)}/blocks/${encodeURIComponent(blockId)}/execute`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            body.innerHTML = renderBlockBody(block, await response.json());
            bindTableScroll(body); bindMarquee(body);
        } catch (error) {
            body.innerHTML = `<div class="dash-block-error"><i class="fa fa-exclamation-triangle"></i><span>${escapeHtml(error.message || error)}</span></div>`;
        }
    }

    function flash(button, text) {
        const label = button.querySelector('span');
        if (!label) return;
        const original = label.textContent;
        label.textContent = text;
        setTimeout(() => { label.textContent = original; }, 1600);
    }

    function bind() {
        grid.addEventListener('click', event => {
            const button = event.target.closest('[data-reload-block]');
            if (button) reloadBlock(button.dataset.reloadBlock);
        });
        el('standaloneRefresh')?.addEventListener('click', execute);

        el('standaloneCopy')?.addEventListener('click', async event => {
            const target = event.currentTarget;
            try {
                await navigator.clipboard.writeText(window.location.href);
                flash(target, '已复制');
            } catch (error) {
                // 非 HTTPS 或旧浏览器下 clipboard 不可用，退回选中地址让人手动复制。
                window.prompt('复制这个看板的地址：', window.location.href);
            }
        });

        el('standaloneFull')?.addEventListener('click', () => {
            if (document.fullscreenElement) document.exitFullscreen();
            else root.requestFullscreen?.();
        });

        // 页面被切到后台时暂停轮询，回到前台立即补一次，避免离屏时白跑查询。
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) { if (timer) { clearInterval(timer); timer = null; } }
            else if (refreshSeconds >= 30 && !timer) { execute(); schedule(); }
        });
    }

    function schedule() {
        if (refreshSeconds < 30) return;
        timer = setInterval(() => { if (!document.hidden) execute(); }, refreshSeconds * 1000);
        const note = el('standaloneRefreshNote');
        if (note) note.textContent = `每 ${refreshSeconds} 秒自动刷新`;
    }

    bind();
    loadConfig().then(execute).catch(error => notice(error.message || String(error)));
    schedule();
})();
