/**
 * custom_inspect.js — Custom scripts page JS for the Server Inspection System
 * Contains: showCustomInspect(), loadCustomScripts(), loadSavedScripts(),
 * custom script CRUD operations (save, edit, delete, test), script execution,
 * variable rendering, rules config rendering, script search/select dropdown,
 * export custom script results, date utility functions, and record status evaluation.
 * Depends on: app.js (showToast, showConfirm, hideAllContent)
 */

// ========== Module-level state variables ==========

let currentSelectedScriptName = '';
let currentRules = [];
let currentCrossDbConfig = { compare_type: 'full_outer', dimension_columns: [], compare_columns: [] };
let customScriptColumns = [];
let customScriptRows = [];
let allCustomScripts = [];
let selectedScriptId = null;
let currentFilteredScripts = [];
let highlightedIndex = -1;
let currentVariables = [];
let databaseOptions = [];

function getScriptCategory(script) {
    return (script?.category || '').trim() || '未分类';
}

function escapeCustomHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getFilteredScripts() {
    const category = document.getElementById('customScriptCategoryFilter')?.value || '';
    const searchText = document.getElementById('customScriptSearch')?.value.trim().toLowerCase() || '';
    return allCustomScripts.filter(script =>
        (!category || getScriptCategory(script) === category) &&
        (!searchText || script.name.toLowerCase().includes(searchText))
    );
}

function renderCategoryFilter() {
    const filter = document.getElementById('customScriptCategoryFilter');
    if (!filter) return;
    const selectedCategory = filter.value;
    const categories = [...new Set(allCustomScripts.map(getScriptCategory))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    filter.innerHTML = '<option value="">全部分类</option>';
    categories.forEach(category => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        filter.appendChild(option);
    });
    filter.value = categories.includes(selectedCategory) ? selectedCategory : '';
}

function renderCategoryOptions(scripts) {
    const options = document.getElementById('customScriptCategoryOptions');
    if (!options) return;
    const categories = [...new Set((scripts || []).map(getScriptCategory))]
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    options.innerHTML = '';
    categories.forEach(category => {
        const option = document.createElement('option');
        option.value = category;
        options.appendChild(option);
    });
}

function refreshScriptOptions() {
    renderScriptOptions(getFilteredScripts());
}

function clearSelectedScript() {
    selectedScriptId = null;
    currentSelectedScriptName = '';
    highlightedIndex = -1;
    customScriptColumns = [];
    customScriptRows = [];

    document.getElementById('customScriptSelect').value = '';
    document.getElementById('customScriptSearch').value = '';
    document.getElementById('selectedScriptInfo').classList.add('hidden');
    document.getElementById('scriptParamsConfig').classList.add('hidden');
    document.getElementById('scriptRulesConfig').classList.add('hidden');
    document.getElementById('executeCustomScriptBtn').disabled = true;
    document.getElementById('exportCustomScriptBtn').classList.add('hidden');
    document.getElementById('customSqlHeaderColorWrap').classList.add('hidden');
    document.getElementById('customScriptResult').classList.add('hidden');
    document.getElementById('customScriptResultHeader').innerHTML = '';
    document.getElementById('customScriptResultBody').innerHTML = '';
}

// ========== Date utility functions (exposed globally for template onclick handlers) ==========

window.getTodayDate = function () {
    return new Date().toISOString().split('T')[0];
};
window.getYesterdayDate = function () {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
};
window.getMonthFirstDate = function () {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().split('T')[0];
};
window.getTodayStartTime = function () {
    return window.getTodayDate() + ' 00:00:00';
};
window.getTodayEndTime = function () {
    return window.getTodayDate() + ' 23:59:59';
};
window.getYesterdayStartTime = function () {
    return window.getYesterdayDate() + ' 00:00:00';
};
window.getYesterdayEndTime = function () {
    return window.getYesterdayDate() + ' 23:59:59';
};
window.getMonthFirstStartTime = function () {
    return window.getMonthFirstDate() + ' 00:00:00';
};

// 计算年月/周期变量的值，与后端 resolve_period_value 逻辑保持一致
// periodType: current_month / current_year / last_month / last_year
// periodFormat: yyyy / yyyy-MM / yyyy-M / yyyy_MM / yyyy_M
window.computePeriodValue = function (periodType, periodFormat) {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth() + 1;

    if (periodType === 'last_year') {
        year = year - 1;
    } else if (periodType === 'last_month') {
        if (month === 1) {
            year = year - 1;
            month = 12;
        } else {
            month = month - 1;
        }
    }

    const fmt = periodFormat || 'yyyy-MM';
    if (fmt === 'yyyy') {
        return `${year}`;
    } else if (fmt === 'yyyy-MM') {
        return `${year}-${String(month).padStart(2, '0')}`;
    } else if (fmt === 'yyyy-M') {
        return `${year}-${month}`;
    } else if (fmt === 'yyyy_MM') {
        return `${year}_${String(month).padStart(2, '0')}`;
    } else if (fmt === 'yyyy_M') {
        return `${year}_${month}`;
    }
    return `${year}-${String(month).padStart(2, '0')}`;
};

// 年月/周期变量的下拉选项（配置与执行界面共用）
window.PERIOD_TYPE_OPTIONS = [
    { value: 'current_month', label: '当前月' },
    { value: 'current_year', label: '当前年' },
    { value: 'last_month', label: '上个月' },
    { value: 'last_year', label: '去年' }
];
window.PERIOD_FORMAT_OPTIONS = [
    { value: 'yyyy', label: 'yyyy' },
    { value: 'yyyy-MM', label: 'yyyy-MM' },
    { value: 'yyyy-M', label: 'yyyy-M' },
    { value: 'yyyy_MM', label: 'yyyy_MM' },
    { value: 'yyyy_M', label: 'yyyy_M' }
];

// ========== showCustomInspect — overwrite the app.js placeholder ==========

window.showCustomInspect = function () {
    if (typeof setPageContext === 'function') {
        setPageContext('自定义SQL', '从已授权的脚本库执行预设查询', 'SAVED QUERIES', '脚本工作区');
    }
    hideAllContent();
    const results = document.getElementById('results');
    const customInspectContent = document.getElementById('customInspectContent');
    results.classList.remove('hidden');
    customInspectContent.classList.remove('hidden');
    loadDatabaseOptions();
    loadCustomScripts();
};

// ========== Clear script form ==========

function clearScriptForm() {
    document.getElementById('customScriptId').value = '';
    document.getElementById('customScriptName').value = '';
    document.getElementById('customScriptCategory').value = '';
    document.getElementById('customScriptMode').value = 'single_db';
    document.getElementById('customScriptContent').value = '';
    document.getElementById('customScriptSourceSql').value = '';
    document.getElementById('customScriptTargetSql').value = '';
    document.getElementById('customScriptScheduled').checked = false;
    document.getElementById('customScriptDaily').checked = false;
    document.getElementById('customScriptRealTime').checked = false;
    document.getElementById('scriptFormTitle').textContent = '自定义SQL脚本配置';
    const cancelEditScriptBtn = document.getElementById('cancelEditScriptBtn');
    cancelEditScriptBtn.classList.add('hidden');

    const singleDbConfig = document.getElementById('singleDbConfig');
    const crossDbConfig = document.getElementById('crossDbConfig');
    const customScriptContent = document.getElementById('customScriptContent');
    singleDbConfig.classList.remove('hidden');
    crossDbConfig.classList.add('hidden');
    customScriptContent.parentElement.classList.remove('hidden');

    // 重置跨库配置区块的显隐（单库时隐藏规则+跨库配置，跨库时相反）
    toggleCrossDbSections('single_db');

    currentVariables = [];
    renderVariables();

    currentRules = [];
    renderRulesConfig();

    currentCrossDbConfig = { compare_type: 'full_outer', dimension_columns: [], compare_columns: [] };
    renderCrossDbConfig();
}

// ========== 跨库配置区块显隐切换 ==========

function toggleCrossDbSections(mode) {
    // 跨库配置区块（custom_script.html 中的 #crossDbCompareConfig）
    const crossDbCompareConfig = document.getElementById('crossDbCompareConfig');
    // 规则配置区块（仅单库适用）
    const ruleConfigWrap = document.getElementById('ruleConfigWrap');
    if (crossDbCompareConfig) {
        crossDbCompareConfig.classList.toggle('hidden', mode !== 'cross_db');
    }
    if (ruleConfigWrap) {
        ruleConfigWrap.classList.toggle('hidden', mode === 'cross_db');
    }
}

function loadDatabaseOptions() {
    fetch('/api/config/database-options')
        .then(response => response.json().then(data => ({ response, data })))
        .then(({ response, data }) => {
            if (!response.ok) throw new Error(data.error || '加载数据库选项失败');
            databaseOptions = data.databases || [];

            const databaseSelect = document.getElementById('customScriptDatabase');
            const sourceDbSelect = document.getElementById('customScriptSourceDb');
            const targetDbSelect = document.getElementById('customScriptTargetDb');

            if (databaseOptions.length === 0) {
                databaseOptions = ['mes', 'hanging'];
            }

            function populateSelect(selectElement) {
                if (!selectElement) return;
                selectElement.innerHTML = '';
                databaseOptions.forEach(dbId => {
                    const option = document.createElement('option');
                    option.value = dbId;
                    option.textContent = dbId;
                    selectElement.appendChild(option);
                });
            }

            populateSelect(databaseSelect);
            populateSelect(sourceDbSelect);
            populateSelect(targetDbSelect);
        })
        .catch(error => {
            console.error('加载数据库配置失败:', error);
            databaseOptions = ['mes', 'hanging'];
        });
}

// ========== Evaluate record status based on rules ==========

function evaluateRecordStatus(row, columns, rules) {
    if (!rules || rules.length === 0) {
        return '正常';
    }

    const abnormalRules = [];
    const normalRules = [];

    rules.forEach(rule => {
        if (rule.result === '异常') {
            abnormalRules.push(rule);
        } else {
            normalRules.push(rule);
        }
    });

    // Check abnormal rules: any match = abnormal
    for (const rule of abnormalRules) {
        if (checkRuleMatch(row, columns, rule)) {
            return '异常';
        }
    }

    // Check normal rules: any match = normal
    for (const rule of normalRules) {
        if (checkRuleMatch(row, columns, rule)) {
            return '正常';
        }
    }

    // Default: normal
    return '正常';
}

function checkRuleMatch(row, columns, rule) {
    const { column, operator, value } = rule;
    let cellValue = '';

    const colIndex = columns.indexOf(column);
    if (colIndex !== -1) {
        if (Array.isArray(row)) {
            cellValue = row[colIndex];
        } else {
            cellValue = row[column];
        }
    } else {
        return false;
    }

    switch (operator) {
        case '=':
            return cellValue == value;
        case '>':
            return !isNaN(parseFloat(cellValue)) && !isNaN(parseFloat(value)) && parseFloat(cellValue) > parseFloat(value);
        case '<':
            return !isNaN(parseFloat(cellValue)) && !isNaN(parseFloat(value)) && parseFloat(cellValue) < parseFloat(value);
        case '>=':
            return !isNaN(parseFloat(cellValue)) && !isNaN(parseFloat(value)) && parseFloat(cellValue) >= parseFloat(value);
        case '<=':
            return !isNaN(parseFloat(cellValue)) && !isNaN(parseFloat(value)) && parseFloat(cellValue) <= parseFloat(value);
        case '!=':
            return cellValue != value;
        case 'is null':
            return cellValue === null || cellValue === undefined || cellValue === '';
        case 'is not null':
            return cellValue !== null && cellValue !== undefined && cellValue !== '';
        default:
            return false;
    }
}

// ========== Render variables list ==========

function renderVariables() {
    const variablesList = document.getElementById('variablesList');
    const availableVariablesHint = document.getElementById('availableVariablesHint');

    if (!variablesList) return;

    variablesList.innerHTML = '';

    if (currentVariables.length === 0) {
        variablesList.innerHTML = '<p class="text-gray-500 text-xs">暂无变量，点击"添加变量"开始配置</p>';
        availableVariablesHint.textContent = '可用变量: -';
        return;
    }

    const varNames = currentVariables.map(v => `#{${v.name}}`).join(', ');
    availableVariablesHint.textContent = `可用变量: ${varNames}`;

    currentVariables.forEach((variable, index) => {
        const varDiv = document.createElement('div');
        varDiv.className = 'flex items-center space-x-2 p-2 bg-white border rounded-lg';

        let defaultValueInputHtml = '';
        const today = window.getTodayDate();
        const yesterday = window.getYesterdayDate();
        const monthFirst = window.getMonthFirstDate();
        const todayStart = window.getTodayStartTime();
        const todayEnd = window.getTodayEndTime();
        const yesterdayStart = window.getYesterdayStartTime();
        const yesterdayEnd = window.getYesterdayEndTime();
        const monthFirstStart = window.getMonthFirstStartTime();
        const defaultValue = variable.default_value || '';

        if (variable.type === 'date') {
            let selectedPreset = '';
            let hiddenClass = '';
            let lastNDaysValue = variable.last_n_days || 7;
            if (variable.date_range_type === 'last_n_days' ||
                variable.date_range_type === 'last_n_to_yesterday' ||
                variable.date_range_type === 'last_n_to_today') {
                selectedPreset = 'lastNDays';
                hiddenClass = 'hidden';
            } else if (variable.date_range_type === 'today') {
                selectedPreset = 'today';
                hiddenClass = 'hidden';
            } else if (variable.date_range_type === 'yesterday') {
                selectedPreset = 'yesterday';
                hiddenClass = 'hidden';
            } else if (defaultValue === today) {
                selectedPreset = 'today';
                hiddenClass = 'hidden';
            } else if (defaultValue === yesterday) {
                selectedPreset = 'yesterday';
                hiddenClass = 'hidden';
            } else if (defaultValue === monthFirst) {
                selectedPreset = 'monthFirst';
                hiddenClass = 'hidden';
            }
            const lastNDaysDivClass = selectedPreset === 'lastNDays' ? '' : 'hidden';

            defaultValueInputHtml = `
                <div class="space-y-1">
                    <select class="w-full px-2 py-1 text-sm border rounded" onchange="window.handleVariableDatePresetChange(${index}, this.value)">
                        <option value="" ${selectedPreset === '' ? 'selected' : ''}>选择预设...</option>
                        <option value="today" ${selectedPreset === 'today' ? 'selected' : ''}>今天 (${today})</option>
                        <option value="yesterday" ${selectedPreset === 'yesterday' ? 'selected' : ''}>昨天 (${yesterday})</option>
                        <option value="lastNDays" ${selectedPreset === 'lastNDays' ? 'selected' : ''}>最近N天</option>
                        <option value="monthFirst" ${selectedPreset === 'monthFirst' ? 'selected' : ''}>当前月第一天 (${monthFirst})</option>
                        <option value="custom">自定义日期</option>
                    </select>
                    <input type="date" class="w-full px-2 py-1 text-sm border rounded ${hiddenClass}" placeholder="默认值" value="${defaultValue}" data-index="${index}" data-field="default_value">
                    <div id="lastNDaysDiv_${index}" class="${lastNDaysDivClass}">
                        <input type="number" min="1" max="365" value="${lastNDaysValue}" class="w-20 px-2 py-1 text-sm border rounded" placeholder="天数" onchange="window.handleVariableLastNDaysChange(${index}, this.value)">
                        <span class="text-xs text-gray-500 ml-1">天</span>
                    </div>
                </div>
            `;
        } else if (variable.type === 'time') {
            let selectedPreset = '';
            let hiddenClass = '';
            if (defaultValue === todayStart) {
                selectedPreset = 'todayStart';
                hiddenClass = 'hidden';
            } else if (defaultValue === todayEnd) {
                selectedPreset = 'todayEnd';
                hiddenClass = 'hidden';
            } else if (defaultValue === yesterdayStart) {
                selectedPreset = 'yesterdayStart';
                hiddenClass = 'hidden';
            } else if (defaultValue === yesterdayEnd) {
                selectedPreset = 'yesterdayEnd';
                hiddenClass = 'hidden';
            } else if (defaultValue === monthFirstStart) {
                selectedPreset = 'monthFirstStart';
                hiddenClass = 'hidden';
            }

            defaultValueInputHtml = `
                <div class="space-y-1">
                    <select class="w-full px-2 py-1 text-sm border rounded" onchange="window.handleVariableTimePresetChange(${index}, this.value)">
                        <option value="" ${selectedPreset === '' ? 'selected' : ''}>选择预设...</option>
                        <option value="todayStart" ${selectedPreset === 'todayStart' ? 'selected' : ''}>今天开始时间 (${todayStart})</option>
                        <option value="todayEnd" ${selectedPreset === 'todayEnd' ? 'selected' : ''}>今天结束时间 (${todayEnd})</option>
                        <option value="yesterdayStart" ${selectedPreset === 'yesterdayStart' ? 'selected' : ''}>昨天开始时间 (${yesterdayStart})</option>
                        <option value="yesterdayEnd" ${selectedPreset === 'yesterdayEnd' ? 'selected' : ''}>昨天结束时间 (${yesterdayEnd})</option>
                        <option value="monthFirstStart" ${selectedPreset === 'monthFirstStart' ? 'selected' : ''}>当前月第一天开始时间 (${monthFirstStart})</option>
                        <option value="custom">自定义时间</option>
                    </select>
                    <input type="text" class="w-full px-2 py-1 text-sm border rounded ${hiddenClass}" placeholder="默认值 (YYYY-MM-DD HH:mm:ss)" value="${defaultValue}" data-index="${index}" data-field="default_value">
                </div>
            `;
        } else if (variable.type === 'period') {
            const periodType = variable.period_type || 'current_month';
            const periodFormat = variable.period_format || 'yyyy_MM';
            const periodPreview = window.computePeriodValue(periodType, periodFormat);
            const typeOpts = window.PERIOD_TYPE_OPTIONS.map(o =>
                `<option value="${o.value}" ${periodType === o.value ? 'selected' : ''}>${o.label}</option>`).join('');
            const fmtOpts = window.PERIOD_FORMAT_OPTIONS.map(o =>
                `<option value="${o.value}" ${periodFormat === o.value ? 'selected' : ''}>${o.label}</option>`).join('');
            defaultValueInputHtml = `
                <div class="space-y-1">
                    <div class="grid grid-cols-2 gap-1">
                        <select class="w-full px-2 py-1 text-sm border rounded" data-index="${index}" data-field="period_type" onchange="window.handleVariablePeriodChange(${index})">${typeOpts}</select>
                        <select class="w-full px-2 py-1 text-sm border rounded" data-index="${index}" data-field="period_format" onchange="window.handleVariablePeriodChange(${index})">${fmtOpts}</select>
                    </div>
                    <span class="text-xs text-gray-500" id="periodPreview_${index}">解析值: ${periodPreview}</span>
                </div>
            `;
        } else if (variable.type === 'collection') {
            const collectionItemType = variable.collection_item_type || 'text';
            defaultValueInputHtml = `
                <div class="space-y-1">
                    <select class="w-full px-2 py-1 text-sm border rounded" data-index="${index}" data-field="collection_item_type">
                        <option value="text" ${collectionItemType === 'text' ? 'selected' : ''}>文本元素</option>
                        <option value="number" ${collectionItemType === 'number' ? 'selected' : ''}>数字元素</option>
                    </select>
                    <textarea class="w-full px-2 py-1 text-sm border rounded" rows="2" placeholder="默认集合值：逗号或换行分隔" data-index="${index}" data-field="default_value">${escapeCustomHtml(defaultValue)}</textarea>
                </div>
            `;
        } else if (variable.type === 'number') {
            defaultValueInputHtml = `<input type="number" step="any" class="w-full px-2 py-1 text-sm border rounded" placeholder="默认值" value="${escapeCustomHtml(defaultValue)}" data-index="${index}" data-field="default_value">`;
        } else {
            defaultValueInputHtml = `<input type="text" class="w-full px-2 py-1 text-sm border rounded" placeholder="默认值" value="${defaultValue}" data-index="${index}" data-field="default_value">`;
        }

        varDiv.innerHTML = `
            <div class="flex-1 grid grid-cols-1 md:grid-cols-4 gap-2">
                <div>
                    <input type="text" class="w-full px-2 py-1 text-sm border rounded" placeholder="变量名" value="${variable.name}" data-index="${index}" data-field="name">
                </div>
                <div>
                    <select class="w-full px-2 py-1 text-sm border rounded" data-index="${index}" data-field="type" onchange="window.handleVariableTypeChange(${index})"><option value="text" ${variable.type === 'text' ? 'selected' : ''}>文本</option>
                        <option value="date" ${variable.type === 'date' ? 'selected' : ''}>日期</option>
                        <option value="time" ${variable.type === 'time' ? 'selected' : ''}>时间</option>
                        <option value="number" ${variable.type === 'number' ? 'selected' : ''}>数字</option>
                        <option value="collection" ${variable.type === 'collection' ? 'selected' : ''}>集合</option>
                        <option value="period" ${variable.type === 'period' ? 'selected' : ''}>年月</option>
                    </select>
                </div>
                <div id="defaultValueDiv_${index}">
                    ${defaultValueInputHtml}
                </div>
                <div>
                    <input type="text" class="w-full px-2 py-1 text-sm border rounded" placeholder="变量描述（可选）" value="${escapeCustomHtml(variable.description)}" data-index="${index}" data-field="description">
                </div>
            </div>
            <button type="button" class="px-2 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600 transition-all" onclick="removeVariable(${index})">
                <i class="fa fa-trash"></i>
            </button>
        `;
        variablesList.appendChild(varDiv);
    });

    // Add change event listeners
    variablesList.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('change', function () {
            const index = parseInt(this.dataset.index);
            const field = this.dataset.field;
            if (currentVariables[index]) {
                currentVariables[index][field] = this.value;

                const varNames = currentVariables.map(v => `#{${v.name}}`).join(', ');
                availableVariablesHint.textContent = `可用变量: ${varNames}`;
            }
        });
    });
}

// ========== Variable manipulation (global for onclick) ==========

window.addVariable = function () {
    const newVar = {
        name: `var${currentVariables.length + 1}`,
        type: 'text',
        default_value: '',
        description: ''
    };
    currentVariables.push(newVar);
    renderVariables();
};

window.removeVariable = async function (index) {
    const confirmed = await showConfirm('确定要删除这个变量吗？', '确认删除');
    if (confirmed) {
        currentVariables.splice(index, 1);
        renderVariables();
    }
};

window.handleVariableTypeChange = function (index) {
    const select = document.querySelector(`[data-index="${index}"][data-field="type"]`);
    if (select) {
        const newType = select.value;
        currentVariables[index].type = newType;
        if (newType === 'date') {
            currentVariables[index].default_value = window.getTodayDate();
        } else if (newType === 'time') {
            currentVariables[index].default_value = window.getTodayStartTime();
        } else if (newType === 'number') {
            currentVariables[index].default_value = '';
        } else if (newType === 'collection') {
            currentVariables[index].default_value = '';
            currentVariables[index].collection_item_type = currentVariables[index].collection_item_type || 'text';
        } else if (newType === 'period') {
            currentVariables[index].default_value = '';
            if (!currentVariables[index].period_type) currentVariables[index].period_type = 'current_month';
            if (!currentVariables[index].period_format) currentVariables[index].period_format = 'yyyy_MM';
        } else {
            currentVariables[index].default_value = '';
        }
        renderVariables();
    }
};

window.handleVariablePeriodChange = function (index) {
    const typeSel = document.querySelector(`[data-index="${index}"][data-field="period_type"]`);
    const fmtSel = document.querySelector(`[data-index="${index}"][data-field="period_format"]`);
    const preview = document.getElementById(`periodPreview_${index}`);
    if (typeSel && fmtSel && preview) {
        preview.textContent = '解析值: ' + window.computePeriodValue(typeSel.value, fmtSel.value);
    }
};

window.handleVariableDatePresetChange = function (index, preset) {
    const input = document.querySelector(`[data-index="${index}"][data-field="default_value"]`);
    const lastNDaysDiv = document.getElementById(`lastNDaysDiv_${index}`);

    if (lastNDaysDiv) {
        lastNDaysDiv.classList.add('hidden');
    }

    if (preset === 'custom') {
        if (input) input.classList.remove('hidden');
        delete currentVariables[index].date_range_type;
        delete currentVariables[index].last_n_days;
    } else if (preset === 'lastNDays') {
        if (input) input.classList.add('hidden');
        currentVariables[index].date_range_type = 'last_n_days';
        currentVariables[index].last_n_days = currentVariables[index].last_n_days || 7;
        currentVariables[index].default_value = '';
        if (lastNDaysDiv) lastNDaysDiv.classList.remove('hidden');
    } else if (preset === 'today') {
        if (input) input.classList.add('hidden');
        // 动态“今天”：运行时解析，不把字面量写进 default_value，避免定时任务取到保存当天的快照
        currentVariables[index].date_range_type = 'today';
        currentVariables[index].default_value = '';
        delete currentVariables[index].last_n_days;
    } else if (preset === 'yesterday') {
        if (input) input.classList.add('hidden');
        // 动态“昨天”：运行时解析，保证每天通知的 endDate 始终为最新昨天
        currentVariables[index].date_range_type = 'yesterday';
        currentVariables[index].default_value = '';
        delete currentVariables[index].last_n_days;
    } else if (preset) {
        let value;
        if (preset === 'monthFirst') {
            value = window.getMonthFirstDate();
        }

        if (input) {
            input.value = value;
            input.classList.add('hidden');
        }
        currentVariables[index].default_value = value;
        delete currentVariables[index].date_range_type;
        delete currentVariables[index].last_n_days;
    }
};

window.handleVariableLastNDaysChange = function (index, value) {
    currentVariables[index].last_n_days = parseInt(value) || 7;
};

window.handleVariableTimePresetChange = function (index, preset) {
    const input = document.querySelector(`[data-index="${index}"][data-field="default_value"]`);

    if (preset === 'custom') {
        if (input) input.classList.remove('hidden');
    } else if (preset) {
        let value;
        if (preset === 'todayStart') {
            value = window.getTodayStartTime();
        } else if (preset === 'todayEnd') {
            value = window.getTodayEndTime();
        } else if (preset === 'yesterdayStart') {
            value = window.getYesterdayStartTime();
        } else if (preset === 'yesterdayEnd') {
            value = window.getYesterdayEndTime();
        } else if (preset === 'monthFirstStart') {
            value = window.getMonthFirstStartTime();
        }

        if (input) {
            input.value = value;
            input.classList.add('hidden');
        }
        currentVariables[index].default_value = value;
    }
};

// ========== Render dynamic params inputs for script execution ==========

function renderParamsInputs(variables) {
    const paramsList = document.getElementById('dynamicParamsList');
    const availableVarsHint = document.getElementById('scriptAvailableVariables');

    if (!paramsList) return;

    paramsList.innerHTML = '';

    if (!variables || variables.length === 0) {
        availableVarsHint.textContent = '可用变量: -';
        return;
    }

    const varNames = variables.map(v => `#{${v.name}}`).join(', ');
    availableVarsHint.textContent = `可用变量: ${varNames}`;

    variables.forEach((variable) => {
        const paramDiv = document.createElement('div');
        let inputHtml = '';

        if (variable.type === 'date') {
            const today = window.getTodayDate();
            const yesterday = window.getYesterdayDate();
            const monthFirst = window.getMonthFirstDate();
            const lastNDays = variable.last_n_days || 7;

            let defaultValue = variable.default_value || today;
            let selectedPreset = 'custom';
            let hiddenClass = '';

            if (variable.date_range_type === 'last_n_days' ||
                variable.date_range_type === 'last_n_to_yesterday' ||
                variable.date_range_type === 'last_n_to_today') {
                const d = new Date();
                d.setDate(d.getDate() - lastNDays + 1);
                defaultValue = d.toISOString().split('T')[0];
                selectedPreset = 'lastNDays';
                hiddenClass = 'hidden';
            } else if (variable.date_range_type === 'today') {
                defaultValue = window.getTodayDate();
                selectedPreset = 'today';
                hiddenClass = 'hidden';
            } else if (variable.date_range_type === 'yesterday') {
                defaultValue = window.getYesterdayDate();
                selectedPreset = 'yesterday';
                hiddenClass = 'hidden';
            } else if (defaultValue === today) {
                selectedPreset = 'today';
                hiddenClass = 'hidden';
            } else if (defaultValue === yesterday) {
                selectedPreset = 'yesterday';
                hiddenClass = 'hidden';
            } else if (defaultValue === monthFirst) {
                selectedPreset = 'monthFirst';
                hiddenClass = 'hidden';
            }
            const lastNDaysDivClass = selectedPreset === 'lastNDays' ? '' : 'hidden';

            inputHtml = `
                <div class="space-y-2">
                    <select class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all" style="--tw-ring-color: var(--primary-color);" id="preset_${variable.name}" onchange="window.handleDatePresetChange('${variable.name}')">
                        <option value="today" ${selectedPreset === 'today' ? 'selected' : ''}>今天 (${today})</option>
                        <option value="yesterday" ${selectedPreset === 'yesterday' ? 'selected' : ''}>昨天 (${yesterday})</option>
                        <option value="lastNDays" ${selectedPreset === 'lastNDays' ? 'selected' : ''}>最近N天</option>
                        <option value="monthFirst" ${selectedPreset === 'monthFirst' ? 'selected' : ''}>当前月第一天 (${monthFirst})</option>
                        <option value="custom" ${selectedPreset === 'custom' ? 'selected' : ''}>自定义日期</option>
                    </select>
                    <input type="date" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all ${hiddenClass}" style="--tw-ring-color: var(--primary-color);" id="param_${variable.name}" value="${defaultValue}">
                    <div id="lastNDaysDiv_param_${variable.name}" class="${lastNDaysDivClass}">
                        <input type="number" min="1" max="365" value="${lastNDays}" class="w-20 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all" style="--tw-ring-color: var(--primary-color);" id="lastNDays_${variable.name}" onchange="window.handleParamLastNDaysChange('${variable.name}', this.value)">
                        <span class="text-xs text-gray-500 ml-1">天</span>
                    </div>
                </div>
            `;
        } else if (variable.type === 'time') {
            const todayStart = window.getTodayStartTime();
            const todayEnd = window.getTodayEndTime();
            const yesterdayStart = window.getYesterdayStartTime();
            const yesterdayEnd = window.getYesterdayEndTime();
            const monthFirstStart = window.getMonthFirstStartTime();
            const defaultValue = variable.default_value || todayStart;

            let selectedPreset = 'custom';
            let hiddenClass = '';
            if (defaultValue === todayStart) {
                selectedPreset = 'todayStart';
                hiddenClass = 'hidden';
            } else if (defaultValue === todayEnd) {
                selectedPreset = 'todayEnd';
                hiddenClass = 'hidden';
            } else if (defaultValue === yesterdayStart) {
                selectedPreset = 'yesterdayStart';
                hiddenClass = 'hidden';
            } else if (defaultValue === yesterdayEnd) {
                selectedPreset = 'yesterdayEnd';
                hiddenClass = 'hidden';
            } else if (defaultValue === monthFirstStart) {
                selectedPreset = 'monthFirstStart';
                hiddenClass = 'hidden';
            }

            inputHtml = `
                <div class="space-y-2">
                    <select class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all" style="--tw-ring-color: var(--primary-color);" id="preset_${variable.name}" onchange="window.handleTimePresetChange('${variable.name}')">
                        <option value="todayStart" ${selectedPreset === 'todayStart' ? 'selected' : ''}>今天开始时间 (${todayStart})</option>
                        <option value="todayEnd" ${selectedPreset === 'todayEnd' ? 'selected' : ''}>今天结束时间 (${todayEnd})</option>
                        <option value="yesterdayStart" ${selectedPreset === 'yesterdayStart' ? 'selected' : ''}>昨天开始时间 (${yesterdayStart})</option>
                        <option value="yesterdayEnd" ${selectedPreset === 'yesterdayEnd' ? 'selected' : ''}>昨天结束时间 (${yesterdayEnd})</option>
                        <option value="monthFirstStart" ${selectedPreset === 'monthFirstStart' ? 'selected' : ''}>当前月第一天开始时间 (${monthFirstStart})</option>
                        <option value="custom" ${selectedPreset === 'custom' ? 'selected' : ''}>自定义时间</option>
                    </select>
                    <input type="text" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all ${hiddenClass}" style="--tw-ring-color: var(--primary-color);" id="param_${variable.name}" value="${defaultValue}" placeholder="格式: YYYY-MM-DD HH:mm:ss">
                </div>
            `;
        } else if (variable.type === 'period') {
            const periodType = variable.period_type || 'current_month';
            const periodFormat = variable.period_format || 'yyyy_MM';
            const periodPreview = window.computePeriodValue(periodType, periodFormat);
            const typeOpts = window.PERIOD_TYPE_OPTIONS.map(o =>
                `<option value="${o.value}" ${periodType === o.value ? 'selected' : ''}>${o.label}</option>`).join('');
            const fmtOpts = window.PERIOD_FORMAT_OPTIONS.map(o =>
                `<option value="${o.value}" ${periodFormat === o.value ? 'selected' : ''}>${o.label}</option>`).join('');
            inputHtml = `
                <div class="space-y-2">
                    <div class="grid grid-cols-2 gap-2">
                        <select class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all" style="--tw-ring-color: var(--primary-color);" id="periodType_${variable.name}" onchange="window.handleParamPeriodChange('${variable.name}')">${typeOpts}</select>
                        <select class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all" style="--tw-ring-color: var(--primary-color);" id="periodFormat_${variable.name}" onchange="window.handleParamPeriodChange('${variable.name}')">${fmtOpts}</select>
                    </div>
                    <span class="text-xs text-gray-500" id="periodPreview_param_${variable.name}">解析值: ${periodPreview}</span>
                </div>
            `;
        } else if (variable.type === 'collection') {
            const collectionItemType = variable.collection_item_type || 'text';
            inputHtml = `
                <div class="space-y-1">
                    <textarea class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all" style="--tw-ring-color: var(--primary-color);" id="param_${variable.name}" rows="3" placeholder="多个值用逗号、中文逗号或换行分隔">${escapeCustomHtml(variable.default_value || '')}</textarea>
                    <span class="text-xs text-gray-500">集合元素类型：${collectionItemType === 'number' ? '数字' : '文本'}</span>
                </div>
            `;
        } else if (variable.type === 'number') {
            inputHtml = `<input type="number" step="any" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all" style="--tw-ring-color: var(--accent);" id="param_${variable.name}" value="${escapeCustomHtml(variable.default_value || '')}" placeholder="请输入数字">`;
        } else {
            inputHtml = `<input type="text" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all" style="--tw-ring-color: var(--accent);" id="param_${variable.name}" value="${escapeCustomHtml(variable.default_value || '')}" placeholder="请输入文本">`;
        }

        paramDiv.innerHTML = `
            <label class="block text-xs font-medium text-gray-600 mb-1">${escapeCustomHtml(variable.name)}${variable.description ? `（${escapeCustomHtml(variable.description)}）` : ''}</label>
            ${inputHtml}
        `;
        paramsList.appendChild(paramDiv);
    });

    // Keep the SQL preview in sync while text, numeric, and collection parameters are edited.
    document.querySelectorAll('[id^="param_"]').forEach(input => {
        input.addEventListener('input', updateSqlContent);
        input.addEventListener('change', updateSqlContent);
    });

    document.querySelectorAll('[id^="preset_"]').forEach(select => {
        select.addEventListener('change', updateSqlContent);
    });
}

// ========== Date/time preset change handlers (global for onchange) ==========

window.handleDatePresetChange = function (varName) {
    const presetSelect = document.getElementById(`preset_${varName}`);
    const dateInput = document.getElementById(`param_${varName}`);
    const lastNDaysDiv = document.getElementById(`lastNDaysDiv_param_${varName}`);

    if (lastNDaysDiv) {
        lastNDaysDiv.classList.add('hidden');
    }

    if (presetSelect.value === 'custom') {
        dateInput.classList.remove('hidden');
    } else if (presetSelect.value === 'lastNDays') {
        dateInput.classList.add('hidden');
        const lastNDaysInput = document.getElementById(`lastNDays_${varName}`);
        const days = parseInt(lastNDaysInput?.value) || 7;
        const d = new Date();
        d.setDate(d.getDate() - days + 1);
        dateInput.value = d.toISOString().split('T')[0];
        if (lastNDaysDiv) lastNDaysDiv.classList.remove('hidden');
        updateSqlContent();
    } else {
        dateInput.classList.add('hidden');
        let value;
        if (presetSelect.value === 'today') {
            value = window.getTodayDate();
        } else if (presetSelect.value === 'yesterday') {
            value = window.getYesterdayDate();
        } else if (presetSelect.value === 'monthFirst') {
            value = window.getMonthFirstDate();
        }
        dateInput.value = value;
        updateSqlContent();
    }
};

window.handleParamLastNDaysChange = function (varName, value) {
    const presetSelect = document.getElementById(`preset_${varName}`);
    if (presetSelect && presetSelect.value === 'lastNDays') {
        window.handleDatePresetChange(varName);
    }
};

window.handleParamPeriodChange = function (varName) {
    const typeSel = document.getElementById(`periodType_${varName}`);
    const fmtSel = document.getElementById(`periodFormat_${varName}`);
    const preview = document.getElementById(`periodPreview_param_${varName}`);
    if (typeSel && fmtSel && preview) {
        preview.textContent = '解析值: ' + window.computePeriodValue(typeSel.value, fmtSel.value);
    }
    updateSqlContent();
};

window.handleTimePresetChange = function (varName) {
    const presetSelect = document.getElementById(`preset_${varName}`);
    const timeInput = document.getElementById(`param_${varName}`);

    if (presetSelect.value === 'custom') {
        timeInput.classList.remove('hidden');
    } else {
        timeInput.classList.add('hidden');
        let value;
        if (presetSelect.value === 'todayStart') {
            value = window.getTodayStartTime();
        } else if (presetSelect.value === 'todayEnd') {
            value = window.getTodayEndTime();
        } else if (presetSelect.value === 'yesterdayStart') {
            value = window.getYesterdayStartTime();
        } else if (presetSelect.value === 'yesterdayEnd') {
            value = window.getYesterdayEndTime();
        } else if (presetSelect.value === 'monthFirstStart') {
            value = window.getMonthFirstStartTime();
        }
        timeInput.value = value;
        updateSqlContent();
    }
};

// ========== Get current param values ==========

function getParamsValues(variables) {
    const params = {};
    if (!variables) return params;

    variables.forEach((variable) => {
        if (variable.type === 'period') {
            const typeSel = document.getElementById(`periodType_${variable.name}`);
            const fmtSel = document.getElementById(`periodFormat_${variable.name}`);
            const pt = typeSel ? typeSel.value : (variable.period_type || 'current_month');
            const pf = fmtSel ? fmtSel.value : (variable.period_format || 'yyyy_MM');
            params[variable.name] = window.computePeriodValue(pt, pf);
            return;
        }
        const input = document.getElementById(`param_${variable.name}`);
        if (input) {
            params[variable.name] = input.value;
        } else {
            params[variable.name] = variable.default_value || '';
        }
    });
    return params;
}

// ========== Generate SQL content by replacing param placeholders ==========

function formatCollectionParam(value, itemType) {
    const values = String(value ?? '')
        .replace(/，/g, ',')
        .split(/[\n,]/)
        .map(item => item.trim())
        .filter(Boolean);
    if (values.length === 0) return 'NULL';
    if (itemType === 'number') {
        return values.map(item => Number(item)).join(', ');
    }
    return values.map(item => `'${item.replace(/'/g, "''")}'`).join(', ');
}

function generateSqlContent(scriptContent, params, variables = []) {
    if (!scriptContent) return '';
    let sqlContent = scriptContent;
    const variablesByName = new Map((variables || []).map(variable => [variable.name, variable]));
    for (const [key, value] of Object.entries(params)) {
        const placeholder = `#{${key}}`;
        const variable = variablesByName.get(key);
        const formattedValue = variable?.type === 'collection'
            ? formatCollectionParam(value, variable.collection_item_type || 'text')
            : value;
        sqlContent = sqlContent.replace(new RegExp(placeholder, 'g'), formattedValue);
    }
    return sqlContent;
}

// ========== Update SQL content display ==========

function updateSqlContent() {
    const scriptId = document.getElementById('customScriptSelect').value;
    if (!scriptId) return;

    const currentScript = allCustomScripts.find(s => s.id === scriptId);
    if (!currentScript) return;

    const params = getParamsValues(currentScript.variables);
    const sqlContent = generateSqlContent(currentScript.content, params, currentScript.variables);
    document.getElementById('selectedScriptSqlContent').textContent = sqlContent;
}

// ========== Render script dropdown options ==========

function renderScriptOptions(scripts) {
    currentFilteredScripts = scripts;
    highlightedIndex = -1;
    const dropdownOptions = document.getElementById('customScriptDropdownOptions');
    dropdownOptions.innerHTML = '';

    if (scripts && scripts.length > 0) {
        scripts.forEach((script, index) => {
            const option = document.createElement('div');
            option.className = 'px-3 py-2 text-sm cursor-pointer hover:bg-gray-100 flex items-center justify-between';
            const name = document.createElement('span');
            name.textContent = script.name;
            const category = document.createElement('span');
            category.className = 'text-xs text-gray-500 ml-3';
            category.textContent = getScriptCategory(script);
            option.appendChild(name);
            option.appendChild(category);
            option.dataset.id = script.id;
            option.dataset.index = index;
            option.addEventListener('click', function () {
                selectScript(script);
            });
            dropdownOptions.appendChild(option);
        });
    } else {
        const option = document.createElement('div');
        option.className = 'px-3 py-2 text-sm text-gray-500';
        option.textContent = '没有匹配的脚本';
        dropdownOptions.appendChild(option);
    }
}

// ========== Highlight dropdown option ==========

function highlightOption(index) {
    const dropdownOptions = document.getElementById('customScriptDropdownOptions');
    const options = dropdownOptions.querySelectorAll('div');

    options.forEach((option, i) => {
        if (option.dataset.index !== undefined) {
            if (i === index) {
                option.classList.add('bg-gray-100');
            } else {
                option.classList.remove('bg-gray-100');
            }
        }
    });

    if (options[index]) {
        options[index].scrollIntoView({ block: 'nearest' });
    }
}

// ========== Select a script ==========

function selectScript(script) {
    selectedScriptId = script.id;
    currentSelectedScriptName = script.name;
    document.getElementById('customScriptSelect').value = script.id;
    document.getElementById('customScriptSearch').value = script.name;

    // Close dropdown
    document.getElementById('customScriptDropdown').classList.add('hidden');

    // Show script info
    const scriptInfo = document.getElementById('selectedScriptInfo');
    const paramsConfig = document.getElementById('scriptParamsConfig');
    const rulesConfig = document.getElementById('scriptRulesConfig');
    const executeBtn = document.getElementById('executeCustomScriptBtn');
    const exportBtn = document.getElementById('exportCustomScriptBtn');

    document.getElementById('selectedScriptName').textContent = script.name;
    document.getElementById('selectedScriptDatabase').textContent =
        script.database === 'mes' ? 'MES数据库' : '吊挂中间库';
    document.getElementById('selectedScriptContent').textContent = script.content;
    scriptInfo.classList.remove('hidden');
    paramsConfig.classList.remove('hidden');
    rulesConfig.classList.remove('hidden');

    // Generate param inputs from variables config
    renderParamsInputs(script.variables);
    // Render rules list
    renderRulesList(script.rules || []);
    // Update SQL content
    updateSqlContent();

    executeBtn.disabled = false;
}

// ========== Load custom scripts (for execution dropdown) ==========

function loadCustomScripts() {
    fetch('/api/custom_scripts')
        .then(response => response.json())
        .then(data => {
            allCustomScripts = data.scripts || [];
            renderCategoryFilter();
            renderCategoryOptions(allCustomScripts);
            refreshScriptOptions();
            if (allCustomScripts.length === 0) {
                const dropdownOptions = document.getElementById('customScriptDropdownOptions');
                if (dropdownOptions) dropdownOptions.innerHTML = '<div class="px-3 py-2 text-sm text-gray-500">当前角色未获授权任何自定义SQL</div>';
            }
        })
        .catch(error => {
            console.error('加载脚本列表失败:', error);
        });
}

// ========== Load saved scripts (for saved list in config) ==========

function loadSavedScripts() {
    const savedScriptsList = document.getElementById('savedScriptsList');
    if (!savedScriptsList) return;
    fetch('/api/custom_scripts')
        .then(response => response.json())
        .then(data => {
            renderCategoryOptions(data.scripts || []);
            savedScriptsList.innerHTML = '';
            if (data.scripts && data.scripts.length > 0) {
                const scriptsByCategory = new Map();
                [...data.scripts]
                    .sort((a, b) => getScriptCategory(a).localeCompare(getScriptCategory(b), 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'))
                    .forEach(script => {
                        const category = getScriptCategory(script);
                        if (!scriptsByCategory.has(category)) scriptsByCategory.set(category, []);
                        scriptsByCategory.get(category).push(script);
                    });
                scriptsByCategory.forEach((scripts, category) => {
                    const categorySection = document.createElement('div');
                    categorySection.className = 'border border-gray-200 rounded-lg overflow-hidden';
                    const categoryToggle = document.createElement('button');
                    categoryToggle.type = 'button';
                    categoryToggle.className = 'w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-all';
                    categoryToggle.innerHTML = `<span>${category}<span class="ml-2 text-xs font-normal text-gray-400">${scripts.length} 个脚本</span></span><i class="fa fa-chevron-right text-xs text-gray-400 transition-transform"></i>`;
                    const categoryScripts = document.createElement('div');
                    categoryScripts.className = 'hidden space-y-2 p-2 border-t border-gray-100';
                    categoryToggle.addEventListener('click', function () {
                        const expanded = categoryScripts.classList.toggle('hidden');
                        const icon = categoryToggle.querySelector('i');
                        icon.classList.toggle('rotate-90', !expanded);
                        categoryToggle.setAttribute('aria-expanded', String(!expanded));
                    });
                    categoryToggle.setAttribute('aria-expanded', 'false');
                    categorySection.appendChild(categoryToggle);
                    categorySection.appendChild(categoryScripts);
                    savedScriptsList.appendChild(categorySection);
                    scripts.forEach(function (script) {
                    const currentScriptId = script.id;

                    const scriptItem = document.createElement('div');
                    scriptItem.className = 'p-2 border rounded-lg';
                    scriptItem.dataset.scriptId = currentScriptId;

                    const infoDiv = document.createElement('div');

                    const nameDiv = document.createElement('div');
                    nameDiv.className = 'font-medium text-sm';
                    nameDiv.textContent = script.name;
                    infoDiv.appendChild(nameDiv);

                    const categoryDiv = document.createElement('div');
                    categoryDiv.className = 'text-xs text-primary mb-1';
                    categoryDiv.textContent = getScriptCategory(script);
                    infoDiv.appendChild(categoryDiv);

                    const dbDiv = document.createElement('div');
                    dbDiv.className = 'text-xs text-gray-500 mb-1';
                    dbDiv.textContent = script.database || (script.mode === 'cross_db' ? '跨库对比' : '未配置');
                    infoDiv.appendChild(dbDiv);

                    const tagsDiv = document.createElement('div');
                    tagsDiv.className = 'flex items-center';
                    const labelSpan = document.createElement('span');
                    labelSpan.className = 'text-xs text-gray-400 mr-2';
                    labelSpan.textContent = '执行：';
                    tagsDiv.appendChild(labelSpan);

                    if (script.scheduled) tagsDiv.appendChild(createTag('定时', 'blue'));
                    if (script.daily) tagsDiv.appendChild(createTag('日常', 'green'));
                    if (script.realtime) tagsDiv.appendChild(createTag('实时', 'purple'));
                    if (!script.scheduled && !script.daily && !script.realtime) {
                        tagsDiv.appendChild(createTag('无', 'gray'));
                    }
                    infoDiv.appendChild(tagsDiv);

                    const btnDiv = document.createElement('div');
                    btnDiv.className = 'flex space-x-2';

                    const editBtn = document.createElement('button');
                    editBtn.type = 'button';
                    editBtn.className = 'text-xs px-2 py-1 bg-primary text-white rounded hover:bg-opacity-90 transition-all';
                    editBtn.textContent = '编辑';
                    editBtn.addEventListener('click', function () {
                        window.editScript(currentScriptId);
                    });

                    const deleteBtn = document.createElement('button');
                    deleteBtn.type = 'button';
                    deleteBtn.className = 'text-xs px-2 py-1 bg-red-500 text-white rounded hover:bg-opacity-90 transition-all';
                    deleteBtn.textContent = '删除';
                    deleteBtn.addEventListener('click', async function () {
                        const confirmed = await showConfirm('删除后无法恢复，确定要删除这个脚本吗？', '删除SQL脚本', { variant: 'danger', confirmText: '删除脚本' });
                        if (!confirmed) return;
                        fetch('/api/custom_scripts/' + currentScriptId, {
                            method: 'DELETE',
                            headers: {
                                'Content-Type': 'application/json'
                            }
                        })
                            .then(function (response) {
                                return response.json();
                            })
                            .then(function (result) {
                                if (result.message) {
                                    showToast('脚本删除成功！', 'success');
                                    loadSavedScripts();
                                } else {
                                    showToast('脚本删除失败: ' + (result.error || '未知错误'), 'error');
                                }
                            })
                            .catch(function (error) {
                                console.error('删除脚本失败:', error);
                                showToast('脚本删除失败，请检查网络连接', 'error');
                            });
                    });

                    btnDiv.appendChild(editBtn);
                    btnDiv.appendChild(deleteBtn);

                    const wrapper = document.createElement('div');
                    wrapper.className = 'flex justify-between items-center';
                    wrapper.appendChild(infoDiv);
                    wrapper.appendChild(btnDiv);

                    scriptItem.appendChild(wrapper);
                    categoryScripts.appendChild(scriptItem);
                    });
                });
            } else {
                savedScriptsList.innerHTML = '<p class="text-gray-500 text-sm">暂无已保存的脚本</p>';
            }
        })
        .catch(error => {
            console.error('加载脚本失败:', error);
        });
}

// 创建执行类型标签
function createTag(text, color) {
    const tag = document.createElement('span');
    const colorMap = {
        blue: 'bg-blue-100 text-blue-600',
        green: 'bg-green-100 text-green-600',
        purple: 'bg-purple-100 text-purple-600',
        gray: 'bg-gray-100 text-gray-600'
    };
    tag.className = 'inline-block px-2 py-0.5 rounded text-xs mr-1 ' + (colorMap[color] || colorMap.gray);
    tag.textContent = text;
    return tag;
}

// ========== Edit script (global for onclick) ==========

window.editScript = function (scriptId) {
    fetch(`/api/custom_scripts/${scriptId}`)
        .then(response => response.json())
        .then(data => {
            if (data.script) {
                const script = data.script;
                document.getElementById('customScriptId').value = script.id;
                document.getElementById('customScriptName').value = script.name;
                document.getElementById('customScriptCategory').value = getScriptCategory(script) === '未分类' ? '' : getScriptCategory(script);
                document.getElementById('customScriptMode').value = script.mode || 'single_db';
                document.getElementById('customScriptScheduled').checked = script.scheduled || false;
                document.getElementById('customScriptDaily').checked = script.daily || false;
                document.getElementById('customScriptRealTime').checked = script.realtime || false;
                document.getElementById('scriptFormTitle').textContent = '编辑SQL脚本';
                document.getElementById('cancelEditScriptBtn').classList.remove('hidden');

                const mode = script.mode || 'single_db';
                const singleDbConfig = document.getElementById('singleDbConfig');
                const crossDbConfig = document.getElementById('crossDbConfig');
                const customScriptContent = document.getElementById('customScriptContent');

                if (mode === 'single_db') {
                    document.getElementById('customScriptDatabase').value = script.database;
                    document.getElementById('customScriptContent').value = script.content;
                    singleDbConfig.classList.remove('hidden');
                    crossDbConfig.classList.add('hidden');
                    customScriptContent.parentElement.classList.remove('hidden');
                } else {
                    document.getElementById('customScriptSourceDb').value = script.source_db;
                    document.getElementById('customScriptTargetDb').value = script.target_db;
                    document.getElementById('customScriptSourceSql').value = script.source_sql;
                    document.getElementById('customScriptTargetSql').value = script.target_sql;
                    singleDbConfig.classList.add('hidden');
                    crossDbConfig.classList.remove('hidden');
                    customScriptContent.parentElement.classList.add('hidden');
                }
                toggleCrossDbSections(mode);

                // Load variables
                currentVariables = data.script.variables || [];
                renderVariables();

                // Load rules
                currentRules = data.script.rules || [];
                renderRulesConfig();

                // Load cross-db config
                currentCrossDbConfig = data.script.cross_db_config ||
                    { compare_type: 'full_outer', dimension_columns: [], compare_columns: [] };
                renderCrossDbConfig();
            }
        })
        .catch(error => {
            console.error('加载脚本失败:', error);
        });
};

// ========== Delete script (global for onclick) ==========

window.deleteScript = async function (scriptId) {
    const confirmed = await showConfirm('删除后无法恢复，确定要删除这个脚本吗？', '删除SQL脚本', { variant: 'danger', confirmText: '删除脚本' });
    if (!confirmed) return;
    fetch(`/api/custom_scripts/${scriptId}`, {
        method: 'DELETE'
    })
        .then(response => response.json())
        .then(data => {
            if (data.message) {
                showToast('脚本删除成功！', 'success');
                loadSavedScripts();
            } else {
                showToast('脚本删除失败: ' + (data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            console.error('删除脚本失败:', error);
            showToast('脚本删除失败，请检查网络连接', 'error');
        });
};

// ========== Show test script result ==========

function showTestScriptResult(result, rules, mode) {
    const resultDiv = document.getElementById('testScriptResult');
    const headerEl = document.getElementById('testScriptResultHeader');
    const bodyEl = document.getElementById('testScriptResultBody');
    const countEl = document.getElementById('testScriptResultCount');

    headerEl.innerHTML = '';
    bodyEl.innerHTML = '';

    const isCrossDb = mode === 'cross_db' || (result && result.summary !== undefined);

    // 跨库对比：展示 summary 统计
    if (isCrossDb && result && result.summary) {
        const s = result.summary;
        const consistent = s.consistent || 0;
        const inconsistent = s.inconsistent || 0;
        const onlySource = s.only_source || 0;
        const onlyTarget = s.only_target || 0;
        countEl.innerHTML = `<span class="font-medium">共 ${s.total || 0} 条</span> ·
            <span class="text-green-600">一致 ${consistent}</span> ·
            <span class="text-red-600">不一致 ${inconsistent}</span> ·
            <span class="text-orange-600">仅源库 ${onlySource}</span> ·
            <span class="text-orange-600">仅目标库 ${onlyTarget}</span>`;
    } else if (!result || !result.columns || !result.rows || result.rows.length === 0) {
        bodyEl.innerHTML = '<tr><td colspan="100" class="px-4 py-8 text-center text-sm text-gray-500">查询结果为空</td></tr>';
        countEl.textContent = '共 0 条记录';
        resultDiv.classList.remove('hidden');
        return;
    } else {
        countEl.textContent = `共 ${result.rows.length} 条记录`;
    }

    const columns = result.columns;
    const rows = result.rows || [];

    // 跨库模式下「状态」列已包含在 columns 中，按其值着色
    const statusColIndex = isCrossDb ? columns.indexOf('状态') : -1;

    // Render header
    let headerHtml = '<tr>';
    columns.forEach(col => {
        headerHtml += `<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wider whitespace-nowrap">${col}</th>`;
    });
    if (!isCrossDb && rules && rules.length > 0) {
        headerHtml += '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wider whitespace-nowrap">状态</th>';
    }
    headerHtml += '</tr>';
    headerEl.innerHTML = headerHtml;

    // Render body
    let bodyHtml = '';
    rows.forEach((row, index) => {
        let rowStatus = '';
        let rowBgClass = index % 2 === 0 ? 'bg-white' : 'bg-gray-50';

        if (isCrossDb && statusColIndex >= 0) {
            const rawStatus = Array.isArray(row) ? row[statusColIndex] : row['状态'];
            rowStatus = String(rawStatus || '');
            rowBgClass = crossDbStatusBg(rowStatus);
        } else if (!isCrossDb && rules && rules.length > 0) {
            rowStatus = evaluateRecordStatus(row, columns, rules);
            rowBgClass = rowStatus === '异常' ? 'bg-red-50' : rowStatus === '正常' ? 'bg-green-50' : rowBgClass;
        }

        bodyHtml += `<tr class="${rowBgClass} hover:bg-gray-100 transition-colors">`;
        columns.forEach((col, colIndex) => {
            let cellValue = '';
            if (Array.isArray(row)) {
                cellValue = row[colIndex] !== null && row[colIndex] !== undefined ? row[colIndex] : '';
            } else {
                cellValue = row[col] !== null && row[col] !== undefined ? row[col] : '';
            }
            // 跨库模式下「状态」列渲染为徽章
            if (isCrossDb && col === '状态') {
                bodyHtml += `<td class="px-4 py-3 text-sm whitespace-nowrap">${crossDbStatusBadge(cellValue)}</td>`;
            } else {
                bodyHtml += `<td class="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">${cellValue}</td>`;
            }
        });
        if (!isCrossDb && rules && rules.length > 0) {
            const statusBadgeClass = rowStatus === '异常'
                ? 'bg-red-100 text-red-600'
                : rowStatus === '正常'
                    ? 'bg-green-100 text-green-600'
                    : 'bg-gray-100 text-gray-600';
            bodyHtml += `<td class="px-4 py-3 text-sm whitespace-nowrap">
                <span class="px-2 py-1 rounded-full text-xs font-medium ${statusBadgeClass}">${rowStatus}</span>
            </td>`;
        }
        bodyHtml += '</tr>';
    });
    bodyEl.innerHTML = bodyHtml;

    resultDiv.classList.remove('hidden');
}

// ========== Cross-db status styling helpers ==========

function crossDbStatusBg(status) {
    if (status === '不一致') return 'bg-red-50';
    if (status === '仅源库存在' || status === '仅目标库存在') return 'bg-orange-50';
    if (status === '一致') return 'bg-green-50';
    return '';
}

function crossDbStatusBadge(status) {
    let cls = 'bg-gray-100 text-gray-600';
    if (status === '不一致') cls = 'bg-red-100 text-red-600';
    else if (status === '仅源库存在' || status === '仅目标库存在') cls = 'bg-orange-100 text-orange-600';
    else if (status === '一致') cls = 'bg-green-100 text-green-600';
    return `<span class="px-2 py-1 rounded-full text-xs font-medium ${cls}">${status}</span>`;
}

// ========== Render custom script result ==========

function renderCustomScriptResult(columns, rows, mode, summary, isConsistent) {
    const headerEl = document.getElementById('customScriptResultHeader');
    const bodyEl = document.getElementById('customScriptResultBody');

    const currentScript = allCustomScripts.find(s => s.id === selectedScriptId);
    const rules = currentScript ? currentScript.rules : [];
    const isCrossDb = mode === 'cross_db' || (summary !== undefined);
    const statusColIndex = isCrossDb ? columns.indexOf('状态') : -1;

    // 跨库模式展示一致性结论
    const resultHeader = document.getElementById('customScriptResult')?.querySelector('h3');
    if (isCrossDb && resultHeader && summary) {
        const s = summary;
        const conclusion = isConsistent
            ? `<span class="text-green-600"><i class="fa fa-check-circle mr-1"></i>跨库对比一致</span>`
            : `<span class="text-red-600"><i class="fa fa-exclamation-circle mr-1"></i>跨库对比存在差异</span>`;
        resultHeader.innerHTML = `SQL结果 · ${conclusion}
            <span class="text-xs font-normal text-gray-500 ml-2">
            一致 ${s.consistent || 0} / 不一致 ${s.inconsistent || 0} / 仅源库 ${s.only_source || 0} / 仅目标库 ${s.only_target || 0}</span>`;
    }

    // Render header
    let headerHtml = '<tr>';
    columns.forEach(col => {
        headerHtml += `<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wider whitespace-nowrap">${col}</th>`;
    });
    if (!isCrossDb) {
        headerHtml += '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wider whitespace-nowrap">状态</th>';
    }
    headerHtml += '</tr>';
    headerEl.innerHTML = headerHtml;

    // Render body
    let bodyHtml = '';
    if (rows.length === 0) {
        bodyHtml = `<tr><td colspan="${columns.length + (isCrossDb ? 0 : 1)}" class="px-4 py-4 text-center text-sm text-gray-500">暂无数据</td></tr>`;
    } else {
        rows.forEach(row => {
            let status = '';
            let statusClass = 'hover:bg-gray-50';
            let statusTextClass = 'text-gray-700';

            if (isCrossDb && statusColIndex >= 0) {
                status = String((Array.isArray(row) ? row[statusColIndex] : row['状态']) || '');
                statusClass = crossDbStatusBg(status);
            } else {
                status = evaluateRecordStatus(row, columns, rules);
                statusClass = status === '正常' ? 'bg-green-50' : 'bg-red-50';
                statusTextClass = status === '正常' ? 'text-green-700' : 'text-red-700';
            }

            bodyHtml += `<tr class="hover:bg-gray-50 ${statusClass}">`;
            columns.forEach((col, colIndex) => {
                let value = '';
                if (Array.isArray(row)) {
                    value = row[colIndex];
                } else {
                    value = row[col];
                }
                if (value === null || value === undefined) {
                    value = '';
                } else if (typeof value === 'number') {
                    if (Number.isInteger(value) && Math.abs(value).toString().length > 12) {
                        value = value.toString();
                    }
                }
                if (isCrossDb && col === '状态') {
                    bodyHtml += `<td class="px-4 py-2 text-sm whitespace-nowrap">${crossDbStatusBadge(value)}</td>`;
                } else {
                    bodyHtml += `<td class="px-4 py-2 text-sm text-gray-900 whitespace-normal break-words max-w-md">${value}</td>`;
                }
            });
            if (!isCrossDb) {
                bodyHtml += `<td class="px-4 py-2 text-sm ${statusTextClass} whitespace-nowrap font-medium">${status}</td>`;
            }
            bodyHtml += '</tr>';
        });
    }
    bodyEl.innerHTML = bodyHtml;
}

// ========== Render rules list (for selected script execution) ==========

function renderRulesList(rules) {
    const rulesList = document.getElementById('rulesList');
    rulesList.innerHTML = '';

    if (rules.length === 0) {
        rulesList.innerHTML = '<p class="text-xs text-gray-500">暂无规则配置</p>';
        return;
    }

    rules.forEach((rule, index) => {
        const ruleDiv = document.createElement('div');
        ruleDiv.className = 'bg-white border border-gray-200 rounded-lg p-3';
        ruleDiv.innerHTML = `
            <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-medium text-gray-700">规则 ${index + 1}</span>
                <button type="button" class="delete-rule-btn text-xs text-red-500 hover:text-red-700" data-index="${index}">
                    <i class="fa fa-trash mr-1"></i>删除
                </button>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-5 gap-2">
                <div>
                    <label class="block text-xs text-gray-500 mb-1">目标列</label>
                    <input type="text" class="rule-column w-full px-2 py-1 text-xs border border-gray-200 rounded" value="${rule.column}" placeholder="例如：报工次数">
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">操作符</label>
                    <select class="rule-operator w-full px-2 py-1 text-xs border border-gray-200 rounded">
                        <option value="=" ${rule.operator === '=' ? 'selected' : ''}>等于</option>
                        <option value=">" ${rule.operator === '>' ? 'selected' : ''}>大于</option>
                        <option value="<" ${rule.operator === '<' ? 'selected' : ''}>小于</option>
                        <option value=">=" ${rule.operator === '>=' ? 'selected' : ''}>大于等于</option>
                        <option value="<=" ${rule.operator === '<=' ? 'selected' : ''}>小于等于</option>
                        <option value="!=" ${rule.operator === '!=' ? 'selected' : ''}>不等于</option>
                        <option value="is null" ${rule.operator === 'is null' ? 'selected' : ''}>是null</option>
                        <option value="is not null" ${rule.operator === 'is not null' ? 'selected' : ''}>不是null</option>
                    </select>
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">参考值</label>
                    <input type="text" class="rule-value w-full px-2 py-1 text-xs border border-gray-200 rounded" value="${rule.value}" placeholder="例如：1">
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">结果</label>
                    <select class="rule-result w-full px-2 py-1 text-xs border border-gray-200 rounded">
                        <option value="正常" ${rule.result === '正常' ? 'selected' : ''}>正常</option>
                        <option value="异常" ${rule.result === '异常' ? 'selected' : ''}>异常</option>
                    </select>
                </div>
            </div>
        `;
        rulesList.appendChild(ruleDiv);
    });

    // Delete rule button click events
    document.querySelectorAll('.delete-rule-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const index = parseInt(this.getAttribute('data-index'));
            const currentScript = allCustomScripts.find(s => s.id === selectedScriptId);
            if (currentScript) {
                currentScript.rules.splice(index, 1);
                renderRulesList(currentScript.rules);
            }
        });
    });

    // Rule input change events
    document.querySelectorAll('.rule-column, .rule-operator, .rule-value, .rule-result').forEach(input => {
        input.addEventListener('change', function () {
            const ruleDiv = this.closest('.bg-white.border.border-gray-200.rounded-lg.p-3');
            const rules = ruleDiv.parentElement.querySelectorAll('.bg-white.border.border-gray-200.rounded-lg.p-3');
            const index = Array.from(rules).indexOf(ruleDiv);

            const currentScript = allCustomScripts.find(s => s.id === selectedScriptId);
            if (currentScript && currentScript.rules[index]) {
                if (this.classList.contains('rule-column')) {
                    currentScript.rules[index].column = this.value;
                } else if (this.classList.contains('rule-operator')) {
                    currentScript.rules[index].operator = this.value;
                } else if (this.classList.contains('rule-value')) {
                    currentScript.rules[index].value = this.value;
                } else if (this.classList.contains('rule-result')) {
                    currentScript.rules[index].result = this.value;
                }
            }
        });
    });
}

// ========== Render rules config (for script editing form) ==========

function renderRulesConfig() {
    const rulesList = document.getElementById('rulesListConfig');

    if (!rulesList) return;

    rulesList.innerHTML = '';

    if (currentRules.length === 0) {
        rulesList.innerHTML = '<p class="text-gray-500 text-xs">暂无规则，点击"添加规则"开始配置</p>';
        return;
    }

    currentRules.forEach((rule, index) => {
        const ruleDiv = document.createElement('div');
        ruleDiv.className = 'flex items-center space-x-2 p-2 bg-white border rounded-lg';

        ruleDiv.innerHTML = `
            <div class="flex-1">
                <div class="grid grid-cols-1 md:grid-cols-5 gap-2">
                    <div>
                        <label class="block text-xs text-gray-500 mb-1">目标列</label>
                        <input type="text" placeholder="例如：报工次数" value="${rule.column || ''}" data-index="${index}" data-field="column" class="w-full px-2 py-1 text-sm border rounded">
                    </div>
                    <div>
                        <label class="block text-xs text-gray-500 mb-1">操作符</label>
                        <select data-index="${index}" data-field="operator" class="w-full px-2 py-1 text-sm border rounded">
                            <option value="=" ${rule.operator === '=' ? 'selected' : ''}>等于</option>
                            <option value=">" ${rule.operator === '>' ? 'selected' : ''}>大于</option>
                            <option value="<" ${rule.operator === '<' ? 'selected' : ''}>小于</option>
                            <option value=">=" ${rule.operator === '>=' ? 'selected' : ''}>大于等于</option>
                            <option value="<=" ${rule.operator === '<=' ? 'selected' : ''}>小于等于</option>
                            <option value="!=" ${rule.operator === '!=' ? 'selected' : ''}>不等于</option>
                            <option value="is null" ${rule.operator === 'is null' ? 'selected' : ''}>是null</option>
                            <option value="is not null" ${rule.operator === 'is not null' ? 'selected' : ''}>不是null</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs text-gray-500 mb-1">参考值</label>
                        <input type="text" placeholder="例如：1" value="${rule.value || ''}" data-index="${index}" data-field="value" class="w-full px-2 py-1 text-sm border rounded">
                    </div>
                    <div>
                        <label class="block text-xs text-gray-500 mb-1">结果</label>
                        <select data-index="${index}" data-field="result" class="w-full px-2 py-1 text-sm border rounded">
                            <option value="正常" ${rule.result === '正常' ? 'selected' : ''}>正常</option>
                            <option value="异常" ${rule.result === '异常' ? 'selected' : ''}>异常</option>
                        </select>
                    </div>
                    <div class="rule-abnormal-description ${rule.result === '异常' ? '' : 'hidden'}">
                        <label class="block text-xs text-gray-500 mb-1">异常描述</label>
                        <input type="text" placeholder="例如：报工次数超过允许范围" value="${escapeCustomHtml(rule.abnormal_description || '')}" data-index="${index}" data-field="abnormal_description" class="w-full px-2 py-1 text-sm border rounded">
                    </div>
                </div>
            </div>
            <button type="button" class="p-1 text-red-500 hover:bg-red-50 rounded" onclick="window.removeRule(${index})"><i class="fa fa-trash"></i></button>
        `;

        rulesList.appendChild(ruleDiv);
    });

    // Bind input change events
    rulesList.querySelectorAll('input, select').forEach(input => {
        input.addEventListener('change', function () {
            const index = parseInt(this.dataset.index);
            const field = this.dataset.field;
            const value = this.value;
            if (currentRules[index]) {
                currentRules[index][field] = value;
                if (field === 'result') {
                    const descriptionWrap = this.closest('.flex-1')?.querySelector('.rule-abnormal-description');
                    if (descriptionWrap) descriptionWrap.classList.toggle('hidden', value !== '异常');
                }
            }
        });
    });
}

// ========== Delete rule (global for onclick) ==========

window.removeRule = function (index) {
    if (currentRules[index]) {
        currentRules.splice(index, 1);
        renderRulesConfig();
    }
};

// ========== Cross-db compare config rendering (for script editing form) ==========

function renderCrossDbConfig() {
    const container = document.getElementById('crossDbCompareFields');
    if (!container) return;

    const cfg = currentCrossDbConfig || {};
    if (!cfg.compare_type) cfg.compare_type = 'full_outer';
    if (!Array.isArray(cfg.dimension_columns)) cfg.dimension_columns = [];
    if (!Array.isArray(cfg.compare_columns)) cfg.compare_columns = [];
    if (cfg.scalar_tolerance === undefined || cfg.scalar_tolerance === null) cfg.scalar_tolerance = 0;

    container.innerHTML = `
        <div class="mb-3">
            <label class="block text-xs text-gray-500 mb-1">对比类型</label>
            <select id="crossDbCompareType" class="w-full px-2 py-1 text-sm border rounded">
                <option value="full_outer" ${cfg.compare_type === 'full_outer' ? 'selected' : ''}>全外连接（不一致 + 仅单库数据）</option>
                <option value="diff_only" ${cfg.compare_type === 'diff_only' ? 'selected' : ''}>仅不一致数据</option>
                <option value="missing_only" ${cfg.compare_type === 'missing_only' ? 'selected' : ''}>仅单库缺失数据</option>
                <option value="scalar" ${cfg.compare_type === 'scalar' ? 'selected' : ''}>标量对比（两库各查一个数值比对，如总记录数）</option>
            </select>
        </div>
        <div id="crossDbScalarConfig" class="mb-3 ${cfg.compare_type === 'scalar' ? '' : 'hidden'}">
            <label class="block text-xs text-gray-500 mb-1">容差（两库数值差值在容差内视为一致，0 表示必须相等）</label>
            <input type="number" step="any" id="crossDbScalarTolerance" value="${cfg.scalar_tolerance || 0}"
                class="w-32 px-2 py-1 text-sm border rounded">
            <p class="text-xs text-gray-400 mt-1">用法：两库 SQL 各返回一行一个数值（如 <code>SELECT COUNT(*)</code>），直接比对是否一致</p>
        </div>
        <div id="crossDbJoinConfig" class="${cfg.compare_type === 'scalar' ? 'hidden' : ''}">
            <div class="mb-3">
                <label class="block text-xs text-gray-500 mb-1">维度列（多列用逗号分隔，两库 SQL 都需 SELECT 这些列）</label>
                <input type="text" id="crossDbDimensionColumns" placeholder="例如：produce_order_code, work_procedure_code"
                    value="${(cfg.dimension_columns || []).join(', ')}"
                    class="w-full px-2 py-1 text-sm border rounded">
                <p class="text-xs text-gray-400 mt-1">用于两库数据对齐，相同维度的数据会逐行比较</p>
            </div>
            <div>
                <div class="flex items-center justify-between mb-2">
                    <label class="block text-xs text-gray-500">对比列（需比较是否一致的数值列，可配置容差）</label>
                    <button type="button" id="addCompareColumnBtn"
                        class="px-2 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600 transition-all">
                        <i class="fa fa-plus mr-1"></i>添加对比列
                    </button>
                </div>
                <div id="compareColumnsList" class="space-y-2"></div>
                <p class="text-xs text-gray-400 mt-1">容差：两库数值差值在容差内视为一致（避免浮点误差），如填 0.01 则相差 0.01 以内算一致</p>
            </div>
        </div>
    `;

    // 渲染对比列
    const listEl = document.getElementById('compareColumnsList');
    listEl.innerHTML = '';
    if (cfg.compare_columns.length === 0) {
        listEl.innerHTML = '<p class="text-xs text-gray-500">暂无对比列，仅对比维度是否存在（用于查找单库缺失数据）</p>';
    } else {
        cfg.compare_columns.forEach((col, index) => {
            const row = document.createElement('div');
            row.className = 'flex items-center space-x-2';
            row.innerHTML = `
                <input type="text" placeholder="列名，例如：total_count" value="${col.name || ''}"
                    data-index="${index}" data-field="name"
                    class="flex-1 px-2 py-1 text-sm border rounded crossdb-compare-input">
                <input type="number" step="any" placeholder="容差" value="${col.tolerance !== undefined ? col.tolerance : 0}"
                    data-index="${index}" data-field="tolerance"
                    class="w-24 px-2 py-1 text-sm border rounded crossdb-compare-input">
                <button type="button" class="p-1 text-red-500 hover:bg-red-50 rounded" onclick="window.removeCompareColumn(${index})"><i class="fa fa-trash"></i></button>
            `;
            listEl.appendChild(row);
        });
    }

    // 绑定事件
    const compareTypeEl = document.getElementById('crossDbCompareType');
    if (compareTypeEl) {
        compareTypeEl.addEventListener('change', function () {
            currentCrossDbConfig.compare_type = this.value;
            // 切换 标量/行级 配置区显隐
            const scalar = this.value === 'scalar';
            const scalarCfg = document.getElementById('crossDbScalarConfig');
            const joinCfg = document.getElementById('crossDbJoinConfig');
            if (scalarCfg) scalarCfg.classList.toggle('hidden', !scalar);
            if (joinCfg) joinCfg.classList.toggle('hidden', scalar);
        });
    }
    const scalarTolEl = document.getElementById('crossDbScalarTolerance');
    if (scalarTolEl) {
        scalarTolEl.addEventListener('change', function () {
            currentCrossDbConfig.scalar_tolerance = parseFloat(this.value) || 0;
        });
    }
    const dimEl = document.getElementById('crossDbDimensionColumns');
    if (dimEl) {
        dimEl.addEventListener('change', function () {
            currentCrossDbConfig.dimension_columns = this.value
                .split(',').map(s => s.trim()).filter(Boolean);
        });
    }
    const addBtn = document.getElementById('addCompareColumnBtn');
    if (addBtn) {
        addBtn.addEventListener('click', function () {
            currentCrossDbConfig.compare_columns.push({ name: '', tolerance: 0 });
            renderCrossDbConfig();
        });
    }
    listEl.querySelectorAll('.crossdb-compare-input').forEach(input => {
        input.addEventListener('change', function () {
            const index = parseInt(this.dataset.index);
            const field = this.dataset.field;
            if (currentCrossDbConfig.compare_columns[index]) {
                if (field === 'tolerance') {
                    currentCrossDbConfig.compare_columns[index].tolerance = parseFloat(this.value) || 0;
                } else {
                    currentCrossDbConfig.compare_columns[index][field] = this.value.trim();
                }
            }
        });
    });
}

window.removeCompareColumn = function (index) {
    if (currentCrossDbConfig.compare_columns[index]) {
        currentCrossDbConfig.compare_columns.splice(index, 1);
        renderCrossDbConfig();
    }
};

function collectCrossDbConfig() {
    // 确保从 DOM 收集最新值（input change 已同步到 currentCrossDbConfig，这里做一次清洗）
    const cfg = currentCrossDbConfig || {};
    cfg.compare_type = cfg.compare_type || 'full_outer';
    if (cfg.compare_type === 'scalar') {
        // 标量对比：只需容差，清掉行级配置
        const tolEl = document.getElementById('crossDbScalarTolerance');
        cfg.scalar_tolerance = tolEl ? (parseFloat(tolEl.value) || 0) : (cfg.scalar_tolerance || 0);
        cfg.dimension_columns = [];
        cfg.compare_columns = [];
        return cfg;
    }
    if (typeof cfg.dimension_columns === 'string') {
        cfg.dimension_columns = cfg.dimension_columns.split(',').map(s => s.trim()).filter(Boolean);
    }
    cfg.dimension_columns = (cfg.dimension_columns || []).filter(Boolean);
    cfg.compare_columns = (cfg.compare_columns || []).filter(c => c && c.name);
    delete cfg.scalar_tolerance;
    return cfg;
}

// ========== DOMContentLoaded Setup ==========

document.addEventListener('DOMContentLoaded', function () {
    const saveCustomScriptBtn = document.getElementById('saveCustomScriptBtn');
    const testCustomScriptBtn = document.getElementById('testCustomScriptBtn');
    const cancelEditScriptBtn = document.getElementById('cancelEditScriptBtn');
    const addVariableBtn = document.getElementById('addVariableBtn');
    const addRuleBtnConfig = document.getElementById('addRuleBtnConfig');
    const savedScriptsList = document.getElementById('savedScriptsList');
    const customScriptMode = document.getElementById('customScriptMode');

    // ========== Mode switch handler ==========

    if (customScriptMode) {
        customScriptMode.addEventListener('change', function () {
            const mode = this.value;
            const singleDbConfig = document.getElementById('singleDbConfig');
            const crossDbConfig = document.getElementById('crossDbConfig');
            const customScriptContent = document.getElementById('customScriptContent');

            if (mode === 'single_db') {
                singleDbConfig.classList.remove('hidden');
                crossDbConfig.classList.add('hidden');
                customScriptContent.parentElement.classList.remove('hidden');
            } else {
                singleDbConfig.classList.add('hidden');
                crossDbConfig.classList.remove('hidden');
                customScriptContent.parentElement.classList.add('hidden');
            }
            toggleCrossDbSections(mode);
        });
    }

    // ========== Save script button ==========

    if (saveCustomScriptBtn) {
        saveCustomScriptBtn.addEventListener('click', function () {
            const scriptId = document.getElementById('customScriptId').value;
            const scriptName = document.getElementById('customScriptName').value;
            const category = document.getElementById('customScriptCategory').value.trim();
            const mode = document.getElementById('customScriptMode').value;
            const scheduled = document.getElementById('customScriptScheduled').checked;
            const daily = document.getElementById('customScriptDaily').checked;
            const realTime = document.getElementById('customScriptRealTime').checked;

            if (!scriptName) {
                showToast('请输入脚本名称', 'warning');
                return;
            }

            const requestData = {
                name: scriptName,
                category: category,
                mode: mode,
                scheduled: scheduled,
                daily: daily,
                realtime: realTime,
                variables: currentVariables,
                rules: currentRules
            };

            if (mode === 'single_db') {
                requestData.database = document.getElementById('customScriptDatabase').value;
                requestData.content = document.getElementById('customScriptContent').value;
                if (!requestData.content) {
                    showToast('请输入脚本内容', 'warning');
                    return;
                }
            } else {
                requestData.source_db = document.getElementById('customScriptSourceDb').value;
                requestData.target_db = document.getElementById('customScriptTargetDb').value;
                requestData.source_sql = document.getElementById('customScriptSourceSql').value;
                requestData.target_sql = document.getElementById('customScriptTargetSql').value;
                if (!requestData.source_sql || !requestData.target_sql) {
                    showToast('请输入源数据库和目标数据库SQL', 'warning');
                    return;
                }
                requestData.cross_db_config = collectCrossDbConfig();
                if (!requestData.cross_db_config.dimension_columns.length) {
                    showToast('跨库对比需配置至少一个维度列', 'warning');
                    return;
                }
            }

            if (scriptId) {
                requestData.id = scriptId;
            }

            fetch('/api/custom_scripts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestData)
            })
                .then(response => response.json())
                .then(data => {
                    if (data.message) {
                        showToast('脚本保存成功！', 'success');
                        loadSavedScripts();
                        clearScriptForm();
                    } else {
                        showToast('脚本保存失败: ' + (data.error || '未知错误'), 'error');
                    }
                })
                .catch(error => {
                    console.error('保存脚本失败:', error);
                    showToast('脚本保存失败，请检查网络连接', 'error');
                });
        });
    }

    // ========== Cancel edit button ==========

    if (cancelEditScriptBtn) {
        cancelEditScriptBtn.addEventListener('click', clearScriptForm);
    }

    // ========== Test script button ==========

    if (testCustomScriptBtn) {
        testCustomScriptBtn.addEventListener('click', function () {
            const scriptName = document.getElementById('customScriptName').value;
            const mode = document.getElementById('customScriptMode').value;

            const params = {};
            const today = new Date().toISOString().split('T')[0];
            const todayStart = today + ' 00:00:00';
            currentVariables.forEach(v => {
                if (v.type === 'period') {
                    params[v.name] = window.computePeriodValue(
                        v.period_type || 'current_month',
                        v.period_format || 'yyyy_MM');
                } else if (v.type === 'date') {
                    if (v.date_range_type === 'last_n_days' ||
                        v.date_range_type === 'last_n_to_yesterday' ||
                        v.date_range_type === 'last_n_to_today') {
                        const days = v.last_n_days || 7;
                        const d = new Date();
                        // 最近N天：从 N 天前到今天，起始日期为今天减 (N-1) 天
                        d.setDate(d.getDate() - days + 1);
                        params[v.name] = d.toISOString().split('T')[0];
                    } else if (v.date_range_type === 'today') {
                        params[v.name] = window.getTodayDate();
                    } else if (v.date_range_type === 'yesterday') {
                        params[v.name] = window.getYesterdayDate();
                    } else if (!v.default_value) {
                        params[v.name] = today;
                    } else {
                        params[v.name] = v.default_value;
                    }
                } else if (v.type === 'time' && !v.default_value) {
                    params[v.name] = todayStart;
                } else {
                    params[v.name] = v.default_value || '';
                }
            });

            const rules = currentRules;
            let requestData = { params: params, variables: currentVariables };

            if (mode === 'single_db') {
                const database = document.getElementById('customScriptDatabase').value;
                const content = document.getElementById('customScriptContent').value;
                if (!content) {
                    showToast('请输入脚本内容', 'warning');
                    return;
                }
                requestData.mode = 'single_db';
                requestData.database = database;
                requestData.content = content;
            } else {
                const sourceDb = document.getElementById('customScriptSourceDb').value;
                const targetDb = document.getElementById('customScriptTargetDb').value;
                const sourceSql = document.getElementById('customScriptSourceSql').value;
                const targetSql = document.getElementById('customScriptTargetSql').value;
                if (!sourceSql || !targetSql) {
                    showToast('请输入源数据库和目标数据库SQL', 'warning');
                    return;
                }
                requestData.mode = 'cross_db';
                requestData.source_db = sourceDb;
                requestData.target_db = targetDb;
                requestData.source_sql = sourceSql;
                requestData.target_sql = targetSql;
                requestData.cross_db_config = collectCrossDbConfig();
                if (!requestData.cross_db_config.dimension_columns.length) {
                    showToast('跨库对比需配置至少一个维度列', 'warning');
                    return;
                }
            }

            fetch('/api/test_custom_script', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestData)
            })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        showTestScriptResult(data.result, rules, mode);
                    } else {
                        showToast('脚本测试失败: ' + (data.error || '未知错误'), 'error');
                    }
                })
                .catch(error => {
                    console.error('测试脚本失败:', error);
                    showToast('脚本测试失败，请检查网络连接', 'error');
                });
        });
    }

    // ========== Clear test result button ==========

    const clearTestScriptResultBtn = document.getElementById('clearTestScriptResultBtn');
    if (clearTestScriptResultBtn) {
        clearTestScriptResultBtn.addEventListener('click', function () {
            const resultDiv = document.getElementById('testScriptResult');
            resultDiv.classList.add('hidden');
            document.getElementById('testScriptResultHeader').innerHTML = '';
            document.getElementById('testScriptResultBody').innerHTML = '';
            document.getElementById('testScriptResultCount').textContent = '';
        });
    }

    // ========== Script search dropdown ==========

    const customScriptSearch = document.getElementById('customScriptSearch');
    const customScriptCategoryFilter = document.getElementById('customScriptCategoryFilter');
    if (customScriptCategoryFilter) {
        customScriptCategoryFilter.addEventListener('change', function () {
            clearSelectedScript();
            refreshScriptOptions();
            document.getElementById('customScriptDropdown').classList.remove('hidden');
        });
    }
    if (customScriptSearch) {
        // Focus shows dropdown
        customScriptSearch.addEventListener('focus', function () {
            document.getElementById('customScriptDropdown').classList.remove('hidden');
        });

        // Search filtering
        customScriptSearch.addEventListener('input', function () {
            const filteredScripts = getFilteredScripts();
            renderScriptOptions(filteredScripts);
            document.getElementById('customScriptDropdown').classList.remove('hidden');
        });

        // Keyboard navigation
        customScriptSearch.addEventListener('keydown', function (e) {
            const dropdown = document.getElementById('customScriptDropdown');

            if (dropdown.classList.contains('hidden')) {
                if (e.key === 'ArrowDown') {
                    dropdown.classList.remove('hidden');
                    highlightedIndex = -1;
                }
                return;
            }

            const optionsCount = currentFilteredScripts.length;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (optionsCount > 0) {
                    highlightedIndex = (highlightedIndex + 1) % optionsCount;
                    highlightOption(highlightedIndex);
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (optionsCount > 0) {
                    highlightedIndex = highlightedIndex <= 0 ? optionsCount - 1 : highlightedIndex - 1;
                    highlightOption(highlightedIndex);
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (highlightedIndex >= 0 && highlightedIndex < optionsCount) {
                    selectScript(currentFilteredScripts[highlightedIndex]);
                }
            } else if (e.key === 'Escape') {
                dropdown.classList.add('hidden');
                highlightedIndex = -1;
            }
        });
    }

    // Dropdown toggle button
    const dropdownToggle = document.getElementById('customScriptDropdownToggle');
    if (dropdownToggle) {
        dropdownToggle.addEventListener('click', function () {
            const dropdown = document.getElementById('customScriptDropdown');
            const opened = dropdown.classList.contains('hidden');
            dropdown.classList.toggle('hidden', !opened);
            this.classList.toggle('is-open', opened);
            this.setAttribute('aria-expanded', opened ? 'true' : 'false');
            if (opened) customScriptSearch.focus();
        });
    }

    // Click outside closes dropdown
    document.addEventListener('click', function (e) {
        const container = e.target.closest('.relative');
        if (!container || !container.querySelector('#customScriptSearch')) {
            document.getElementById('customScriptDropdown').classList.add('hidden');
        }
    });

    // ========== Execute custom script button ==========

    const executeCustomScriptBtn = document.getElementById('executeCustomScriptBtn');
    if (executeCustomScriptBtn) {
        executeCustomScriptBtn.addEventListener('click', function () {
            const scriptId = document.getElementById('customScriptSelect').value;
            if (!scriptId) {
                showToast('请先选择脚本', 'warning');
                return;
            }

            this.disabled = true;
            this.innerHTML = '<i class="fa fa-spinner fa-spin mr-2"></i>执行中...';

            const currentScript = allCustomScripts.find(s => s.id === scriptId);
            const params = getParamsValues(currentScript?.variables);

            fetch(`/api/custom_scripts/${scriptId}/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(params)
            })
                .then(async response => {
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) {
                        throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
                    }
                    return data;
                })
                .then(data => {
                    if (data.columns && data.rows !== undefined) {
                        customScriptColumns = data.columns;
                        customScriptRows = data.rows;

                        const mode = currentScript?.mode || 'single_db';
                        renderCustomScriptResult(data.columns, data.rows, mode, data.summary, data.is_consistent);

                        document.getElementById('exportCustomScriptBtn').classList.remove('hidden');
                        document.getElementById('customSqlHeaderColorWrap').classList.remove('hidden');
                        document.getElementById('customScriptResult').classList.remove('hidden');
                    } else {
                        showToast('执行失败: ' + (data.error || '未知错误'), 'error');
                    }
                })
                .catch(error => {
                    console.error('执行脚本失败:', error);
                    showToast('执行失败: ' + error.message, 'error');
                })
                .finally(() => {
                    this.disabled = false;
                    this.innerHTML = '<i class="fa fa-play mr-2"></i>执行SQL';
                });
        });
    }

    // ========== Add rule button (execution view) ==========

    const addRuleBtn = document.getElementById('addRuleBtn');
    if (addRuleBtn) {
        addRuleBtn.addEventListener('click', function () {
            const currentScript = allCustomScripts.find(s => s.id === selectedScriptId);
            if (currentScript) {
                if (!currentScript.rules) {
                    currentScript.rules = [];
                }
                currentScript.rules.push({
                    column: '',
                    operator: '=',
                    value: '',
                    result: '异常'
                });
                renderRulesList(currentScript.rules);
            }
        });
    }

    // ========== Export custom script results ==========

    const exportCustomScriptBtn = document.getElementById('exportCustomScriptBtn');
    if (exportCustomScriptBtn) {
        exportCustomScriptBtn.addEventListener('click', function () {
            if (customScriptColumns.length === 0 || customScriptRows.length === 0) {
                showToast('没有可导出的数据', 'warning');
                return;
            }

            this.disabled = true;
            const originalHtml = this.innerHTML;
            this.innerHTML = '<i class="fa fa-spinner fa-spin mr-2"></i>导出中...';
            fetch('/api/custom_scripts/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    columns: customScriptColumns,
                    rows: customScriptRows,
                    script_name: currentSelectedScriptName || 'SQL结果',
                    header_color: document.getElementById('customSqlHeaderColor')?.value || '#87CEEB'
                })
            })
                .then(response => {
                    if (!response.ok) {
                        return response.json().then(data => Promise.reject(new Error(data.error || '导出失败')));
                    }
                    const disposition = response.headers.get('Content-Disposition') || '';
                    const match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
                    return response.blob().then(blob => ({ blob, fileName: match ? decodeURIComponent(match[1]) : 'SQL结果.xlsx' }));
                })
                .then(({ blob, fileName }) => {
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = fileName;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    URL.revokeObjectURL(url);
                })
                .catch(error => showToast('导出失败: ' + error.message, 'error'))
                .finally(() => {
                    this.disabled = false;
                    this.innerHTML = originalHtml;
                });
        });
    }

    // ========== Add variable button ==========

    if (addVariableBtn) {
        addVariableBtn.addEventListener('click', window.addVariable);
    }

    // ========== Add rule button (config view) ==========

    if (addRuleBtnConfig) {
        addRuleBtnConfig.addEventListener('click', function () {
            currentRules.push({ column: '', operator: '=', value: '', result: '异常', abnormal_description: '' });
            renderRulesConfig();
        });
    }

    // 脚本与数据库选项仅在用户打开“自定义SQL”页面时加载，避免无权限账号发起未授权请求。
    renderVariables();
    renderRulesConfig();
    // 预渲染跨库对比配置（默认隐藏）：否则新建脚本切换到跨库模式时
    // #crossDbCompareConfig 容器虽显示，但 #crossDbCompareFields 为空，无法配置
    renderCrossDbConfig();
});