let authAccess = null;
let authRoles = [];
let customSqlOptions = { categories: [], scripts: [] };

function selectedValues(containerId) {
    return [...document.querySelectorAll(`#${containerId} input:checked`)].map(input => input.value);
}
function rolePermissionItems() {
    return Object.entries(authAccess.permission_labels)
        .filter(([id]) => id !== 'system_config')
        .map(([id, name]) => ({ id, name }));
}
function effectiveRolePermissions(permissions = []) {
    const selected = new Set(permissions);
    if (selected.delete('system_config')) {
        ['config_basic_alert', 'config_inspection_strategy', 'config_data_notification', 'config_custom_sql']
            .forEach(permission => selected.add(permission));
    }
    return [...selected];
}
function escapeAuthHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function customSqlScope() {
    const mode = document.querySelector('input[name="customSqlScopeMode"]:checked')?.value || 'all';
    return {
        mode,
        category_names: mode === 'selected' ? selectedValues('customSqlCategoryOptions') : [],
        script_ids: mode === 'selected' ? selectedValues('customSqlScriptOptions') : [],
    };
}
function renderCustomSqlScope(scope = { mode: 'all', category_names: [], script_ids: [] }) {
    const normalized = { mode: scope.mode === 'selected' ? 'selected' : 'all', category_names: scope.category_names || [], script_ids: scope.script_ids || [] };
    const categoryOptions = document.getElementById('customSqlCategoryOptions');
    const scriptOptions = document.getElementById('customSqlScriptOptions');
    if (categoryOptions) categoryOptions.innerHTML = customSqlOptions.categories.map(category => `<label class="flex items-center text-sm text-gray-700"><input type="checkbox" class="mr-2" value="${escapeAuthHtml(category)}" ${normalized.category_names.includes(category) ? 'checked' : ''}>${escapeAuthHtml(category)}</label>`).join('') || '<p class="text-xs text-gray-400">暂无脚本分类</p>';
    if (scriptOptions) scriptOptions.innerHTML = customSqlOptions.scripts.map(script => `<label class="flex items-center text-sm text-gray-700"><input type="checkbox" class="mr-2" value="${escapeAuthHtml(script.id)}" ${normalized.script_ids.includes(String(script.id)) ? 'checked' : ''}>${escapeAuthHtml(script.category)} / ${escapeAuthHtml(script.name)}</label>`).join('') || '<p class="text-xs text-gray-400">暂无自定义SQL脚本</p>';
    const radio = document.querySelector(`input[name="customSqlScopeMode"][value="${normalized.mode}"]`);
    if (radio) radio.checked = true;
    updateCustomSqlScopeVisibility();
}
function updateCustomSqlScopeVisibility() {
    const hasCustomSql = selectedValues('rolePermissionOptions').includes('custom_sql');
    const scopeConfig = document.getElementById('customSqlScopeConfig');
    const selectedScope = document.getElementById('customSqlSelectedScope');
    const mode = document.querySelector('input[name="customSqlScopeMode"]:checked')?.value;
    if (scopeConfig) scopeConfig.classList.toggle('hidden', !hasCustomSql);
    if (selectedScope) selectedScope.classList.toggle('hidden', !hasCustomSql || mode !== 'selected');
}
function renderOptions(containerId, items, selected, labelKey, valueKey) {
    const container = document.getElementById(containerId);
    container.innerHTML = items.map(item => `<label class="flex items-center text-sm text-gray-700"><input type="checkbox" class="mr-2" value="${escapeAuthHtml(item[valueKey])}" ${selected.includes(item[valueKey]) ? 'checked' : ''}>${escapeAuthHtml(item[labelKey])}</label>`).join('');
    if (containerId === 'rolePermissionOptions') container.querySelectorAll('input').forEach(input => input.addEventListener('change', updateCustomSqlScopeVisibility));
}
function resetRoleForm() {
    document.getElementById('roleId').value = ''; document.getElementById('roleName').value = ''; document.getElementById('roleDescription').value = '';
    renderOptions('rolePermissionOptions', rolePermissionItems(), [], 'name', 'id');
    renderCustomSqlScope();
}
function resetUserForm() {
    document.getElementById('userUsernameEdit').value = ''; document.getElementById('userUsername').value = ''; document.getElementById('userUsername').readOnly = false;
    document.getElementById('userDisplayName').value = ''; document.getElementById('userPassword').value = ''; document.getElementById('userEnabled').value = 'true';
    renderOptions('userRoleOptions', authRoles, [], 'name', 'id');
}
function renderRoles() {
    const list = document.getElementById('roleList');
    list.innerHTML = authRoles.map(role => {
        const scope = role.custom_sql_scope || { mode: 'all', category_names: [], script_ids: [] };
        const scopeSummary = (role.permissions || []).includes('custom_sql') ? ` · 自定义SQL：${scope.mode === 'selected' ? `分类${(scope.category_names || []).length}个，脚本${(scope.script_ids || []).length}个` : '全部'}` : '';
        return `<div class="border rounded-lg p-3 flex justify-between gap-3"><div><p class="text-sm font-medium">${escapeAuthHtml(role.name)}</p><p class="text-xs text-gray-500">${escapeAuthHtml(role.description || '无说明')} · ${(role.permissions || []).map(id => escapeAuthHtml(authAccess.permission_labels[id] || id)).join('、') || '无功能权限'}${scopeSummary}</p></div><div>${role.id === 'system_admin' ? '<span class="text-xs text-gray-400">系统内置</span>' : `<button class="edit-role text-primary text-xs mr-2" data-id="${escapeAuthHtml(role.id)}">编辑</button><button class="delete-role text-red-500 text-xs" data-id="${escapeAuthHtml(role.id)}">删除</button>`}</div></div>`;
    }).join('');
    list.querySelectorAll('.edit-role').forEach(btn => btn.onclick = () => {
        const role = authRoles.find(item => item.id === btn.dataset.id);
        document.getElementById('roleId').value = role.id;
        document.getElementById('roleName').value = role.name;
        document.getElementById('roleDescription').value = role.description || '';
        renderOptions('rolePermissionOptions', rolePermissionItems(), effectiveRolePermissions(role.permissions), 'name', 'id');
        renderCustomSqlScope(role.custom_sql_scope || { mode: 'all', category_names: [], script_ids: [] });
    });
    list.querySelectorAll('.delete-role').forEach(btn => btn.onclick = async () => { if (await showConfirm('确定删除该角色吗？', '删除角色')) fetch(`/api/auth/roles/${btn.dataset.id}`, { method: 'DELETE' }).then(handleResult); });
}
function renderUsers(users) {
    const list = document.getElementById('userList');
    list.innerHTML = users.map(user => `<div class="border rounded-lg p-3 flex justify-between gap-3"><div><p class="text-sm font-medium">${user.display_name || user.username} <span class="text-xs text-gray-400">${user.username}</span></p><p class="text-xs text-gray-500">${(user.role_ids || []).map(id => authRoles.find(role => role.id === id)?.name || id).join('、') || '未分配角色'} · ${user.enabled ? '启用' : '停用'}</p></div><div>${user.username === 'admin' ? '<span class="text-xs text-gray-400">系统管理员</span>' : `<button class="edit-user text-primary text-xs" data-name="${user.username}">编辑</button>`}</div></div>`).join('');
    list.querySelectorAll('.edit-user').forEach(btn => btn.onclick = () => { const user = users.find(item => item.username === btn.dataset.name); document.getElementById('userUsernameEdit').value = user.username; document.getElementById('userUsername').value = user.username; document.getElementById('userUsername').readOnly = true; document.getElementById('userDisplayName').value = user.display_name || ''; document.getElementById('userPassword').value = ''; document.getElementById('userEnabled').value = String(user.enabled); renderOptions('userRoleOptions', authRoles, user.role_ids || [], 'name', 'id'); });
}
function handleResult(response) { return response.json().then(data => { if (!response.ok) throw new Error(data.error || '操作失败'); showToast(data.message || '保存成功', 'success'); loadPermissionManagement(); return data; }).catch(error => showToast(error.message, 'error')); }
async function loadPermissionManagement() {
    const roleList = document.getElementById('roleList');
    const userList = document.getElementById('userList');
    if (!authAccess) await loadAccess();
    if (!authAccess?.is_admin) {
        const message = '仅 admin 账号可查看和配置菜单权限、角色及人员。';
        if (roleList) roleList.innerHTML = `<p class="text-sm text-red-500">${message}</p>`;
        if (userList) userList.innerHTML = `<p class="text-sm text-red-500">${message}</p>`;
        return;
    }

    if (roleList) roleList.innerHTML = '<p class="text-sm text-gray-400">正在加载角色...</p>';
    if (userList) userList.innerHTML = '<p class="text-sm text-gray-400">正在加载人员...</p>';
    try {
        const [rolesResponse, usersResponse, optionsResponse] = await Promise.all([
            fetch('/api/auth/roles'),
            fetch('/api/auth/users'),
            fetch('/api/auth/custom-sql-options'),
        ]);
        const [rolesData, usersData, optionsData] = await Promise.all([rolesResponse.json(), usersResponse.json(), optionsResponse.json()]);
        if (!rolesResponse.ok) throw new Error(rolesData.error || '加载角色失败');
        if (!usersResponse.ok) throw new Error(usersData.error || '加载人员失败');
        if (!optionsResponse.ok) throw new Error(optionsData.error || '加载自定义SQL授权项失败');
        customSqlOptions = { categories: optionsData.categories || [], scripts: optionsData.scripts || [] };
        authRoles = rolesData.roles || [];
        renderRoles();
        renderUsers(usersData.users || []);
        resetRoleForm();
        resetUserForm();
    } catch (error) {
        const message = error.message || '加载人员与权限配置失败';
        if (roleList) roleList.innerHTML = `<p class="text-sm text-red-500">${message}</p>`;
        if (userList) userList.innerHTML = `<p class="text-sm text-red-500">${message}</p>`;
        showToast(message, 'error');
    }
}
window.showUserPermission = function () {
    if (typeof setPageContext === 'function') {
        setPageContext('人员与权限', '管理角色、账号与细分功能授权', 'ACCESS CONTROL', '管理员专用');
    }
    hideAllContent();
    const content = document.getElementById('userPermissionContent');
    if (!content) {
        showToast('人员与权限页面未加载，请刷新后重试', 'error');
        return;
    }
    content.classList.remove('hidden');
    loadPermissionManagement();
};
async function loadAccess() {
    try {
        const response = await fetch('/api/auth/access');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '加载当前权限失败');
        authAccess = data;
        window.authAccess = data;
        const userPermissionBtn = document.getElementById('userPermissionBtn');
        if (userPermissionBtn) userPermissionBtn.classList.toggle('hidden', !data.is_admin);
        const configMenu = document.querySelector('[data-config-menu]');
        if (configMenu) {
            const configPermissions = ['config_basic_alert', 'config_inspection_strategy', 'config_data_notification', 'config_custom_sql'];
            configMenu.classList.toggle('hidden', !configPermissions.some(permission => data.permissions.includes(permission)));
        }
        document.querySelectorAll('[data-permission]').forEach(item => {
            item.classList.toggle('hidden', !data.permissions.includes(item.dataset.permission));
        });
        return data;
    } catch (error) {
        authAccess = null;
        window.authAccess = null;
        return null;
    }
}
document.addEventListener('DOMContentLoaded', () => {
    loadAccess();
    document.querySelectorAll('input[name="customSqlScopeMode"]').forEach(input => input.addEventListener('change', updateCustomSqlScopeVisibility));
    document.getElementById('saveRoleBtn')?.addEventListener('click', () => {
        const id = document.getElementById('roleId').value;
        const permissions = selectedValues('rolePermissionOptions');
        const payload = { name: document.getElementById('roleName').value.trim(), description: document.getElementById('roleDescription').value.trim(), permissions, custom_sql_scope: customSqlScope() };
        if (permissions.includes('custom_sql') && payload.custom_sql_scope.mode === 'selected' && !payload.custom_sql_scope.category_names.length && !payload.custom_sql_scope.script_ids.length) {
            showToast('请至少选择一个自定义SQL分类或脚本', 'warning');
            return;
        }
        fetch(id ? `/api/auth/roles/${id}` : '/api/auth/roles', { method: id ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(handleResult);
    });
    document.getElementById('cancelRoleBtn')?.addEventListener('click', resetRoleForm);
    document.getElementById('saveUserBtn')?.addEventListener('click', () => { const edit = document.getElementById('userUsernameEdit').value; const payload = { username: document.getElementById('userUsername').value.trim(), display_name: document.getElementById('userDisplayName').value.trim(), password: document.getElementById('userPassword').value, enabled: document.getElementById('userEnabled').value === 'true', role_ids: selectedValues('userRoleOptions') }; fetch(edit ? `/api/auth/users/${encodeURIComponent(edit)}` : '/api/auth/users', { method: edit ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(handleResult); });
    document.getElementById('cancelUserBtn')?.addEventListener('click', resetUserForm);
});
