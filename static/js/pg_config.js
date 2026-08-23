/*
 * PG 容器配置模块
 * 调用 /api/pg/* 接口，管理 PostgreSQL 容器日志相关参数
 */

function pgCurrentConfig() {
    return {
        container: document.getElementById('pgContainerName').value.trim(),
        user: document.getElementById('pgUserName').value.trim(),
    };
}

async function pgApi(url, options = {}) {
    const resp = await fetch(url, options);
    let data;
    try {
        data = await resp.json();
    } catch (e) {
        data = { error: '响应解析失败' };
    }
    if (!resp.ok && !data.error) {
        data.error = `请求失败 (${resp.status})`;
    }
    return data;
}

function isPgConfigVisible() {
    const content = document.getElementById('pgConfigContent');
    return content && !content.classList.contains('hidden');
}

window.loadPgConfig = async function () {
    if (!isPgConfigVisible()) return;

    // 容器/用户默认值
    const data = await pgApi('/api/pg/config');
    if (!isPgConfigVisible()) return;

    if (data.error) {
        // 无配置时用默认值
        document.getElementById('pgContainerName').value = 'mes_postgresql';
        document.getElementById('pgUserName').value = 'postgres';
    } else {
        document.getElementById('pgContainerName').value = data.container || 'mes_postgresql';
        document.getElementById('pgUserName').value = data.user || 'postgres';
    }
    await loadPgContainers();
    if (isPgConfigVisible()) await loadPgSettings();
};

async function loadPgContainers() {
    const listEl = document.getElementById('pgContainerList');
    listEl.innerHTML = '<p class="text-xs text-gray-400">加载容器列表...</p>';
    const data = await pgApi('/api/pg/containers');
    if (data.error) {
        listEl.innerHTML = `<p class="text-xs text-red-500">${data.error}</p>`;
        return;
    }
    if (!data.containers || data.containers.length === 0) {
        listEl.innerHTML = '<p class="text-xs text-gray-400">未检测到 PostgreSQL 容器（镜像/名称含 postgres 或 pgsql）</p>';
        return;
    }
    const currentName = document.getElementById('pgContainerName').value.trim();
    listEl.innerHTML = '<div class="flex flex-wrap gap-2">' + data.containers.map(c => {
        const active = c.name === currentName;
        return `<button type="button" class="pg-container-pick ${active ? 'is-selected' : ''}"
            data-name="${escapeHtml(c.name)}">
            ${escapeHtml(c.name)} <span class="pg-container-pick__meta">(${escapeHtml(c.image)})</span>
            <span class="pg-container-pick__meta">· ${escapeHtml(c.status)}</span>
        </button>`;
    }).join('') + '</div>';
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadPgSettings() {
    if (!isPgConfigVisible()) return;

    const tableEl = document.getElementById('pgSettingsTable');
    tableEl.innerHTML = '<p class="text-xs text-gray-400">加载当前参数...</p>';
    const { container, user } = pgCurrentConfig();
    const qs = new URLSearchParams({ container, user });
    const data = await pgApi('/api/pg/settings?' + qs);
    if (data.error) {
        tableEl.innerHTML = `<p class="text-xs text-red-500">${escapeHtml(data.error)}</p>`;
        return;
    }
    if (!data.settings || data.settings.length === 0) {
        tableEl.innerHTML = '<p class="text-xs text-gray-400">无参数</p>';
        return;
    }
    const rows = data.settings.map(s => {
        const isPostmaster = s.context === 'postmaster';
        const ctxBadge = isPostmaster
            ? '<span class="text-amber-600" title="需重启PG容器才生效">postmaster(需重启)</span>'
            : (s.context === 'sighup'
                ? '<span class="text-green-600" title="reload即生效">sighup</span>'
                : `<span>${escapeHtml(s.context || '')}</span>`);
        return `<tr class="border-b border-gray-100">
            <td class="px-3 py-2 text-xs text-gray-700">${escapeHtml(s.label)}<div class="text-[10px] text-gray-400">${escapeHtml(s.name)}</div></td>
            <td class="px-3 py-2 text-xs text-gray-800 font-mono">${escapeHtml(s.setting)}${s.unit ? '<span class="text-gray-400 ml-1">' + escapeHtml(s.unit) + '</span>' : ''}</td>
            <td class="px-3 py-2 text-xs">${ctxBadge}</td>
            <td class="px-3 py-2 text-xs text-gray-500">${escapeHtml(s.source || '')}</td>
            <td class="px-3 py-2 text-[10px] text-gray-400">${escapeHtml(s.help || '')}</td>
        </tr>`;
    }).join('');
    tableEl.innerHTML = `<table class="w-full text-left"><thead><tr class="border-b border-gray-200 text-[11px] text-gray-500">
        <th class="px-3 py-2">参数</th><th class="px-3 py-2">当前值</th><th class="px-3 py-2">上下文</th><th class="px-3 py-2">来源</th><th class="px-3 py-2">说明</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function showPgResult(msg, type = 'info', detail) {
    const el = document.getElementById('pgResult');
    const colors = { success: 'green', error: 'red', info: 'blue' };
    const color = colors[type] || 'blue';
    const cls = { green: 'bg-green-50 text-green-700 border-green-200', red: 'bg-red-50 text-red-700 border-red-200', blue: 'bg-blue-50 text-blue-700 border-blue-200' }[color];
    el.innerHTML = `<div class="border ${cls} rounded-lg p-3 text-xs">
        <div>${escapeHtml(msg)}</div>
        ${detail ? `<pre class="mt-2 whitespace-pre-wrap text-[11px] opacity-80">${escapeHtml(detail)}</pre>` : ''}
    </div>`;
}

async function savePgConfig() {
    const { container, user } = pgCurrentConfig();
    if (!container) { showToast('请填写容器名', 'error'); return; }
    const data = await pgApi('/api/pg/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container, user }),
    });
    if (data.error) { showToast(data.error, 'error'); return; }
    showToast('已保存默认容器配置', 'success');
    await loadPgContainers();
}

async function setSetting(name, value, desc) {
    const { container, user } = pgCurrentConfig();
    const data = await pgApi('/api/pg/setting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value, container, user, reload: true }),
    });
    if (data.error) {
        showPgResult(`设置失败：${desc || name}`, 'error', data.error);
        showToast(`${desc || name} 设置失败`, 'error');
    } else {
        let msg = `已设置 ${desc || name}`;
        if (data.reload && !data.reload.success) {
            msg += `（但重载失败：${data.reload.error}）`;
        }
        if (data.note) msg += `\n${data.note}`;
        showPgResult(msg, 'success');
        showToast(`${desc || name} 设置成功`, 'success');
    }
    await loadPgSettings();
}

async function applyPreset() {
    const confirmed = await showConfirm(
        '将关闭普通SQL执行日志、将慢查询阈值设为10秒、关闭日志收集器、限制单条日志为512MB，并重载配置。日志收集器需重启 PG 容器后才会生效。',
        '应用推荐配置',
        { confirmText: '确认应用', cancelText: '暂不应用' }
    );
    if (!confirmed) return;
    const { container, user } = pgCurrentConfig();
    const data = await pgApi('/api/pg/apply_preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container, user, reload: true }),
    });
    if (data.error) {
        showPgResult('应用推荐配置失败', 'error', data.error);
        return;
    }
    const lines = (data.settings || []).map(s => `${s.success ? '✓' : '✗'} ${s.desc} (${s.name}=${s.value})${s.error ? ' - ' + s.error : ''}`);
    if (data.reload) lines.push(`${data.reload.success ? '✓' : '✗'} 重载配置${data.reload.error ? ' - ' + data.reload.error : ''}`);
    if (data.note) lines.push('⚠ ' + data.note);
    showPgResult('应用推荐配置结果', 'success', lines.join('\n'));
    await loadPgSettings();
}

async function reloadConf() {
    const { container, user } = pgCurrentConfig();
    const data = await pgApi('/api/pg/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container, user }),
    });
    if (data.error) { showPgResult('重载失败', 'error', data.error); return; }
    showPgResult(data.message || '配置已重载（仅 sighup 级参数即时生效）', 'success');
    await loadPgSettings();
}

function bindPgEvents() {
    const saveBtn = document.getElementById('pgSaveConfigBtn');
    if (saveBtn) saveBtn.addEventListener('click', savePgConfig);
    const refreshContainersBtn = document.getElementById('pgRefreshContainersBtn');
    if (refreshContainersBtn) refreshContainersBtn.addEventListener('click', loadPgContainers);
    const refreshSettingsBtn = document.getElementById('pgRefreshSettingsBtn');
    if (refreshSettingsBtn) refreshSettingsBtn.addEventListener('click', loadPgSettings);
    const applyPresetBtn = document.getElementById('pgApplyPresetBtn');
    if (applyPresetBtn) applyPresetBtn.addEventListener('click', applyPreset);
    const reloadBtn = document.getElementById('pgReloadBtn');
    if (reloadBtn) reloadBtn.addEventListener('click', reloadConf);

    // 容器/用户输入变化时刷新容器高亮（不自动重新拉参数，避免频繁请求）
    ['pgContainerName', 'pgUserName'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', loadPgContainers);
    });

    // 容器选择按钮（事件委托）
    document.addEventListener('click', function (e) {
        const btn = e.target.closest('.pg-container-pick');
        if (!btn) return;
        document.getElementById('pgContainerName').value = btn.dataset.name;
        loadPgContainers();
    });

    // 快捷操作按钮
    document.querySelectorAll('.pg-quick-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            setSetting(this.dataset.name, this.dataset.value, this.dataset.desc);
        });
    });

    // 慢查询阈值：弹输入
    const thresholdBtn = document.getElementById('pgSetThresholdBtn');
    if (thresholdBtn) {
        thresholdBtn.addEventListener('click', async function () {
            const val = window.prompt('输入慢查询阈值（毫秒，0=记录全部，-1=关闭）：', '10000');
            if (val === null) return;
            const n = parseInt(val, 10);
            if (isNaN(n)) { showToast('请输入有效整数', 'error'); return; }
            await setSetting('log_min_duration_statement', String(n), `慢查询阈值 ${n}ms`);
        });
    }
}

document.addEventListener('DOMContentLoaded', bindPgEvents);
