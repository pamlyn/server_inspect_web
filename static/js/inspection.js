/**
 * inspection.js — Inspection page JS for the Server Inspection System
 * Contains: runInspection(), displayResults(), renderResultContent(),
 * toggleResult(), formatOutput(), and inspection result rendering logic.
 * Depends on: app.js (showToast, setActiveButton, hideAllContent)
 */

// ========== Toggle Result (expand/collapse) ==========

function toggleResult(categoryKey) {
    const content = document.getElementById(categoryKey + '-content');
    const icon = document.getElementById(categoryKey + '-icon');
    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        icon.style.transform = 'rotate(180deg)';
    } else {
        content.classList.add('hidden');
        icon.style.transform = 'rotate(0deg)';
    }
}

// ========== Format Output ==========

function formatOutput(item) {
    if (typeof item === 'object') {
        return JSON.stringify(item, null, 2);
    }
    return item;
}

// ========== Run Inspection ==========

window.runInspection = function (type) {
    const fullInspectBtn = document.getElementById('fullInspectBtn');
    const activeBtn = type === 'full' ? fullInspectBtn : document.querySelector(`[data-type="${type}"]`);
    if (activeBtn) {
        activeBtn.classList.add('button-press');
        setTimeout(() => activeBtn.classList.remove('button-press'), 100);
    }

    // Show/hide dedup option
    const deduplicateOption = document.getElementById('deduplicateOption');
    if (deduplicateOption) {
        if (type === 'full' || type === 'slow_sql') {
            deduplicateOption.classList.remove('hidden');
        } else {
            deduplicateOption.classList.add('hidden');
        }
    }

    // Hide all content areas immediately
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');
    const configContent = document.getElementById('configContent');
    const sqlInspectContent = document.getElementById('sqlInspectContent');
    const customInspectContent = document.getElementById('customInspectContent');
    const inspectionContent = document.getElementById('inspectionContent');
    const arthasContent = document.getElementById('arthasContent');

    loading.classList.remove('hidden');
    results.classList.add('hidden');
    configContent.classList.add('hidden');
    sqlInspectContent.classList.add('hidden');
    customInspectContent.classList.add('hidden');
    if (arthasContent) arthasContent.classList.add('hidden');

    const deduplicateCheckbox = document.getElementById('deduplicateCheckbox');
    const deduplicate = deduplicateCheckbox ? deduplicateCheckbox.checked : true;

    fetch('/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, deduplicate: deduplicate })
    })
        .then(response => response.json())
        .then(data => {
            loading.classList.add('hidden');
            results.classList.remove('hidden');
            inspectionContent.classList.remove('hidden');
            configContent.classList.add('hidden');
            sqlInspectContent.classList.add('hidden');
            customInspectContent.classList.add('hidden');
            results.classList.add('fade-in');
            // 单项巡检只展示当前结果，完整巡检展示汇总+详情
            displayResults(data, type === 'full');
        })
        .catch(error => {
            loading.classList.add('hidden');
            showToast('巡检失败: ' + error.message, 'error');
        });
};

// ========== Display Results ==========

function displayResults(data, showSummary) {
    const inspectionResults = document.getElementById('inspectionResults');
    const summaryTableBody = document.getElementById('summaryTableBody');
    // 汇总表区域的父容器
    const summaryContainer = summaryTableBody ? summaryTableBody.closest('.bg-white') : null;
    inspectionResults.innerHTML = '';
    if (summaryTableBody) summaryTableBody.innerHTML = '';

    // 单项巡检隐藏汇总表，完整巡检显示汇总表
    if (summaryContainer) {
        if (showSummary) {
            summaryContainer.classList.remove('hidden');
        } else {
            summaryContainer.classList.add('hidden');
        }
    }

    // Check for error
    if (data.error) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden';
        errorDiv.innerHTML = `
            <div class="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
                <div class="flex items-center">
                    <div class="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center mr-3">
                        <i class="fa fa-exclamation-circle text-sm text-red-600"></i>
                    </div>
                    <span class="font-medium text-gray-800 text-sm">错误</span>
                </div>
            </div>
            <div class="p-4">
                <div class="bg-red-50 border-l-4 border-red-500 p-3 rounded">
                    <p class="text-red-700 text-sm">${data.error}</p>
                </div>
            </div>
        `;
        inspectionResults.appendChild(errorDiv);
        return;
    }

    let firstResult = null;
    for (const key in data) {
        if (data.hasOwnProperty(key)) {
            firstResult = data[key];
            break;
        }
    }

    const startTimeEl = document.getElementById('startTime');
    const endTimeEl = document.getElementById('endTime');
    const durationEl = document.getElementById('duration');

    if (firstResult) {
        startTimeEl.innerHTML = `<i class="fa fa-clock-o mr-1"></i>开始时间: ${firstResult.start_time || '--'}`;
        endTimeEl.innerHTML = `<i class="fa fa-clock-o mr-1"></i>结束时间: ${firstResult.end_time || '--'}`;
        durationEl.innerHTML = `<i class="fa fa-hourglass mr-1"></i>耗时: ${firstResult.duration || '--'}`;
    }

    const summaryData = [];

    for (const [category, result] of Object.entries(data)) {
        const categoryTitle = {
            'system_info': '系统信息',
            'cpu': 'CPU使用率',
            'memory': '内存使用情况',
            'swap': '交换分区使用情况',
            'disk': '磁盘使用情况',
            'disk_io': '磁盘IO情况',
            'processes': '进程状态',
            'slow_sql': '慢SQL检查',
            'database': '数据库状态',
            'network': '网络信息',
            'worker_output_with_color_size': '工人产量与报工明细稽核（含颜色尺码）',
            'worker_output_without_color_size': '工人产量与报工明细稽核（不含颜色尺码）',
            'worker_output_sfd': '工人产量与报工明细数据稽核(sfd)',
            'mes_hanging': 'MES报工明细与吊挂报工明细稽核'
        }[category] || category;

        const categoryIcon = {
            'system_info': 'fa-info-circle',
            'cpu': 'fa-microchip',
            'memory': 'fa-braille',
            'swap': 'fa-random',
            'disk': 'fa-hdd-o',
            'disk_io': 'fa-exchange',
            'processes': 'fa-tasks',
            'slow_sql': 'fa-database',
            'database': 'fa-database',
            'network': 'fa-wifi',
            'worker_output_with_color_size': 'fa-users',
            'worker_output_without_color_size': 'fa-users',
            'worker_output_sfd': 'fa-users',
            'mes_hanging': 'fa-exchange'
        }[category] || 'fa-check-circle';

        let status = '正常';
        let statusClass = 'text-green-600';
        let statusIcon = 'fa-check-circle';
        let statusBgClass = 'bg-green-100';

        if (result.criticals && result.criticals.length > 0) {
            status = '紧急';
            statusClass = 'text-red-600';
            statusIcon = 'fa-exclamation-circle';
            statusBgClass = 'bg-red-100';
        } else if (result.warnings && result.warnings.length > 0) {
            status = '警告';
            statusClass = 'text-yellow-600';
            statusIcon = 'fa-exclamation-triangle';
            statusBgClass = 'bg-yellow-100';
        }

        summaryData.push({
            category: categoryTitle,
            status: status,
            statusClass: statusClass,
            statusIcon: statusIcon,
            statusBgClass: statusBgClass,
            criticals: result.criticals ? result.criticals.length : 0,
            warnings: result.warnings ? result.warnings.length : 0,
            normals: result.normals ? result.normals.length : 0,
            result: result,
            categoryKey: category,
            categoryIcon: categoryIcon
        });
    }

    // Render summary table
    summaryData.forEach(item => {
        const row = document.createElement('tr');
        row.className = 'hover:bg-gray-50 transition-all';
        row.innerHTML = `
            <td class="px-4 py-2 whitespace-nowrap">
                <div class="flex items-center">
                    <div class="w-6 h-6 rounded-lg bg-gray-100 flex items-center justify-center mr-2">
                        <i class="fa ${item.categoryIcon} text-xs" style="color: var(--primary-color);"></i>
                    </div>
                    <span class="text-sm">${item.category}</span>
                </div>
            </td>
            <td class="px-4 py-2 text-center">
                <span class="${item.statusClass} ${item.statusBgClass} px-2 py-0.5 rounded text-xs font-medium inline-flex items-center">
                    <i class="fa ${item.statusIcon} mr-1"></i>
                    ${item.status}
                </span>
            </td>
            <td class="px-4 py-2 text-center">
                <span class="${item.criticals > 0 ? 'text-red-600 font-bold' : 'text-gray-400'}">${item.criticals}</span>
            </td>
            <td class="px-4 py-2 text-center">
                <span class="${item.warnings > 0 ? 'text-yellow-600 font-bold' : 'text-gray-400'}">${item.warnings}</span>
            </td>
            <td class="px-4 py-2 text-center">
                <span class="${item.normals > 0 ? 'text-green-600' : 'text-gray-400'}">${item.normals}</span>
            </td>
        `;
        summaryTableBody.appendChild(row);
    });

    // Render detailed results
    summaryData.forEach(item => {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden';

        resultDiv.innerHTML = `
            <div class="px-4 py-3 border-b border-gray-200 flex justify-between items-center cursor-pointer hover:bg-gray-50 transition-all" onclick="toggleResult('${item.categoryKey}')">
                <div class="flex items-center">
                    <div class="w-8 h-8 rounded-lg flex items-center justify-center mr-3" style="background: var(--primary-light);">
                        <i class="fa ${item.categoryIcon} text-sm" style="color: var(--primary-color);"></i>
                    </div>
                    <span class="font-medium text-gray-800 text-sm">${item.category}</span>
                    <span class="ml-3 ${item.statusClass} ${item.statusBgClass} px-2 py-0.5 rounded text-xs font-medium inline-flex items-center">
                        <i class="fa ${item.statusIcon} mr-1"></i>
                        ${item.status}
                    </span>
                </div>
                <i class="fa fa-chevron-down text-gray-400 text-xs transition-transform" id="${item.categoryKey}-icon"></i>
            </div>
            <div class="p-4 max-h-96 overflow-y-auto hidden" id="${item.categoryKey}-content">
                ${renderResultContent(item.result)}
            </div>
        `;

        inspectionResults.appendChild(resultDiv);
    });
}

// ========== Render Result Content ==========

function renderResultContent(result) {
    let content = '';

    if (result.info && result.info.length > 0) {
        content += `
            <div class="mb-3">
                <h4 class="font-medium text-blue-600 mb-2 flex items-center text-sm">
                    <i class="fa fa-info-circle mr-1"></i>
                    详细信息 (${result.info.length})
                </h4>
                <div class="bg-blue-50 border-l-4 border-blue-500 p-3 rounded">
                    <ul class="space-y-1">
                        ${result.info.map(item => `<li class="text-blue-700 text-sm pre-wrap">${formatOutput(item)}</li>`).join('')}
                    </ul>
                </div>
            </div>
        `;
    }

    if (result.criticals && result.criticals.length > 0) {
        content += `
            <div class="mb-3">
                <h4 class="font-medium text-red-600 mb-2 flex items-center text-sm">
                    <i class="fa fa-exclamation-circle mr-1"></i>
                    紧急 (${result.criticals.length})
                </h4>
                <div class="bg-red-50 border-l-4 border-red-500 p-3 rounded">
                    <ul class="space-y-1">
                        ${result.criticals.map(item => `<li class="text-red-700 text-sm pre-wrap">${formatOutput(item)}</li>`).join('')}
                    </ul>
                </div>
            </div>
        `;
    }

    if (result.warnings && result.warnings.length > 0) {
        content += `
            <div class="mb-3">
                <h4 class="font-medium text-yellow-600 mb-2 flex items-center text-sm">
                    <i class="fa fa-exclamation-triangle mr-1"></i>
                    警告 (${result.warnings.length})
                </h4>
                <div class="bg-yellow-50 border-l-4 border-yellow-500 p-3 rounded">
                    <ul class="space-y-1">
                        ${result.warnings.map(item => `<li class="text-yellow-700 text-sm pre-wrap">${formatOutput(item)}</li>`).join('')}
                    </ul>
                </div>
            </div>
        `;
    }

    if (result.normals && result.normals.length > 0) {
        content += `
            <div class="mb-3">
                <h4 class="font-medium text-green-600 mb-2 flex items-center text-sm">
                    <i class="fa fa-check-circle mr-1"></i>
                    正常 (${result.normals.length})
                </h4>
                <div class="bg-green-50 border-l-4 border-green-500 p-3 rounded">
                    <ul class="space-y-1">
                        ${result.normals.map(item => `<li class="text-green-700 text-sm pre-wrap">${formatOutput(item)}</li>`).join('')}
                    </ul>
                </div>
            </div>
        `;
    }

    // Slow SQL
    if (result.slow_sqls && result.slow_sqls.length > 0) {
        content += `
            <div class="mb-3">
                <h4 class="font-medium text-purple-600 mb-2 flex items-center text-sm">
                    <i class="fa fa-database mr-1"></i>
                    慢SQL (${result.slow_sqls.length})
                </h4>
                <div class="bg-purple-50 border-l-4 border-purple-500 p-3 rounded">
                    <ul class="space-y-3">
                        ${result.slow_sqls.map(item => `<li class="text-purple-700 text-sm pre-wrap code-block">${formatOutput(item)}</li>`).join('')}
                    </ul>
                </div>
            </div>
        `;
    }

    return content || '<p class="text-gray-500 text-sm">暂无数据</p>';
}

// ========== Global Exports ==========

window.toggleResult = toggleResult;
window.formatOutput = formatOutput;