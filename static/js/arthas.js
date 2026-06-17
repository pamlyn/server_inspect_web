/**
 * arthas.js — Arthas 诊断模块前端逻辑
 * 参考 arthas-web 的 session-based 架构重写：
 *   SSH连接 → sessionId → 容器/进程 → 启动Arthas → 执行命令 → 输出展示
 * Depends on: app.js (showToast, hideAllContent)
 */

// ========== 状态变量 ==========

let arthasMode = 'local';          // 'local' | 'remote'
let arthasSessionId = null;        // 远程模式的 SSH sessionId
let arthasConnected = false;       // SSH 是否连接成功（远程模式）
let arthasRunning = false;         // Arthas HTTP API 是否可达
let arthasHttpPort = 8563;
let arthasCurrentContainer = '';   // 当前选中的容器 ID（空=主机进程）
let arthasCurrentPid = null;       // 当前选中的 Java PID
let arthasAsyncJobId = null;       // 当前异步任务的 jobId
let arthasAsyncPullTimer = null;   // 异步结果拉取定时器

// ========== 页面入口 ==========

window.showArthas = function () {
    hideAllContent();
    const arthasContent = document.getElementById('arthasContent');
    if (arthasContent) arthasContent.classList.remove('hidden');
    // 默认本机模式，自动加载
    arthasSetMode('local');
};

// ========== 模式切换 ==========

window.arthasSetMode = function (mode) {
    arthasMode = mode;
    arthasSessionId = null;
    arthasConnected = false;
    arthasRunning = false;
    arthasCurrentContainer = '';
    arthasCurrentPid = null;

    const localBtn = document.getElementById('arthasModeLocal');
    const remoteBtn = document.getElementById('arthasModeRemote');
    const remoteForm = document.getElementById('arthasRemoteConnForm');
    const containerSection = document.getElementById('arthasContainerSection');
    const processSection = document.getElementById('arthasProcessSection');
    const cmdPanel = document.getElementById('arthasCommandPanel');

    if (mode === 'local') {
        localBtn.className = 'px-4 py-2 rounded-lg text-sm font-medium transition-all bg-primary text-white';
        remoteBtn.className = 'px-4 py-2 rounded-lg text-sm font-medium transition-all bg-gray-100 text-gray-600 hover:bg-gray-200';
        if (remoteForm) remoteForm.classList.add('hidden');
    } else {
        remoteBtn.className = 'px-4 py-2 rounded-lg text-sm font-medium transition-all bg-primary text-white';
        localBtn.className = 'px-4 py-2 rounded-lg text-sm font-medium transition-all bg-gray-100 text-gray-600 hover:bg-gray-200';
        if (remoteForm) remoteForm.classList.remove('hidden');
        arthasLoadSavedServers();
    }

    // 重置容器和进程区域
    if (containerSection) containerSection.classList.add('hidden');
    if (processSection) processSection.classList.add('hidden');
    if (cmdPanel) cmdPanel.classList.add('hidden');
    _updateStatus('disconnected', '未检测');
    _toggleStartStop(false);

    if (mode === 'local') {
        // 本机模式：自动显示容器+进程
        if (containerSection) containerSection.classList.remove('hidden');
        if (processSection) processSection.classList.remove('hidden');
        arthasLoadContainers();
        arthasLoadJavaProcesses();
    }
};

// ========== 状态管理 ==========

function _updateStatus(state, message) {
    const dot = document.getElementById('arthasStatusDot');
    if (!dot) return;
    const circle = dot.querySelector('.rounded-full');
    const span = dot.querySelector('span');

    if (state === 'connected') {
        circle.className = 'w-3 h-3 rounded-full bg-green-500';
        span.className = 'text-sm text-green-600 font-medium';
        arthasRunning = true;
    } else if (state === 'connecting') {
        circle.className = 'w-3 h-3 rounded-full bg-yellow-500';
        span.className = 'text-sm text-yellow-600';
    } else {
        circle.className = 'w-3 h-3 rounded-full bg-gray-300';
        span.className = 'text-sm text-gray-500';
        arthasRunning = false;
    }
    span.textContent = message;
}

function _toggleStartStop(isRunning) {
    const startBtn = document.getElementById('arthasStartBtn');
    const stopBtn = document.getElementById('arthasStopBtn');
    if (startBtn) startBtn.classList.toggle('hidden', isRunning);
    if (stopBtn) stopBtn.classList.toggle('hidden', !isRunning);
}

// ========== 远程 SSH 连接 ==========

window.arthasLoadSavedServers = function () {
    const select = document.getElementById('arthasSavedServer');
    if (!select) return;
    select.innerHTML = '<option value="">选择服务器...</option>';

    fetch('/api/arthas/servers')
        .then(r => r.json())
        .then(data => {
            if (data.success && data.servers) {
                data.servers.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.id;
                    opt.textContent = `${s.name} (${s.host})`;
                    select.appendChild(opt);
                });
            }
        })
        .catch(() => {
            select.innerHTML = '<option value="">加载失败</option>';
        });
};

window.arthasOnSavedServerSelected = function () {
    const select = document.getElementById('arthasSavedServer');
    const serverId = select.value;
    const sshForm = document.getElementById('arthasSSHForm');

    if (serverId) {
        // 选中已保存的服务器，用其配置连接
        if (sshForm) sshForm.classList.add('hidden');
        arthasConnectSavedServer(parseInt(serverId));
    } else {
        // 手动输入
        if (sshForm) sshForm.classList.remove('hidden');
    }
};

function arthasConnectSavedServer(serverId) {
    // 从服务器列表获取配置，然后创建 SSH 会话
    fetch('/api/arthas/servers')
        .then(r => r.json())
        .then(data => {
            if (!data.success) return;
            const server = data.servers.find(s => s.id === serverId);
            if (!server) { showToast('服务器配置不存在', 'error'); return; }

            _updateStatus('connecting', '正在连接...');
            fetch('/api/arthas/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    host: server.host,
                    port: server.ssh_port,
                    username: server.username,
                    auth_type: server.auth_type,
                    password: server.password,
                    private_key: server.private_key_path
                })
            })
                .then(r => r.json())
                .then(result => {
                    if (result.success) {
                        arthasSessionId = result.sessionId;
                        arthasConnected = true;
                        _updateStatus('disconnected', 'SSH已连接 — 等待启动Arthas');
                        showToast('SSH连接成功', 'success');

                        // 显示容器+进程区域
                        const containerSection = document.getElementById('arthasContainerSection');
                        const processSection = document.getElementById('arthasProcessSection');
                        if (containerSection) containerSection.classList.remove('hidden');
                        if (processSection) processSection.classList.remove('hidden');
                        arthasLoadContainers();
                    } else {
                        _updateStatus('disconnected', '连接失败');
                        showToast('SSH连接失败: ' + result.message, 'error');
                    }
                })
                .catch(err => {
                    _updateStatus('disconnected', '连接失败');
                    showToast('连接请求失败: ' + err.message, 'error');
                });
        });
}

window.arthasConnectSSH = function () {
    const host = document.getElementById('arthasSSHHost')?.value;
    const port = parseInt(document.getElementById('arthasSSHPort')?.value) || 22;
    const username = document.getElementById('arthasSSHUsername')?.value || 'root';
    const authType = document.getElementById('arthasSSHAuthType')?.value || 'password';
    const password = document.getElementById('arthasSSHPassword')?.value || '';
    const privateKey = document.getElementById('arthasSSHKeyPath')?.value || '';

    if (!host) { showToast('请输入主机地址', 'warning'); return; }

    _updateStatus('connecting', '正在连接...');

    fetch('/api/arthas/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            host: host, port: port, username: username,
            auth_type: authType, password: password, private_key: privateKey
        })
    })
        .then(r => r.json())
        .then(result => {
            if (result.success) {
                arthasSessionId = result.sessionId;
                arthasConnected = true;
                _updateStatus('disconnected', 'SSH已连接 — 等待启动Arthas');
                showToast('SSH连接成功', 'success');

                // 隐藏SSH表单，显示容器+进程
                const sshForm = document.getElementById('arthasSSHForm');
                if (sshForm) sshForm.classList.add('hidden');
                const containerSection = document.getElementById('arthasContainerSection');
                const processSection = document.getElementById('arthasProcessSection');
                if (containerSection) containerSection.classList.remove('hidden');
                if (processSection) processSection.classList.remove('hidden');
                arthasLoadContainers();
            } else {
                _updateStatus('disconnected', '连接失败');
                showToast('SSH连接失败: ' + result.message, 'error');
            }
        })
        .catch(err => {
            _updateStatus('disconnected', '连接失败');
            showToast('连接请求失败: ' + err.message, 'error');
        });
};

window.arthasToggleSSHAuthFields = function () {
    const authType = document.getElementById('arthasSSHAuthType')?.value;
    const pwDiv = document.getElementById('arthasSSHPasswordDiv');
    const keyDiv = document.getElementById('arthasSSHKeyDiv');
    if (authType === 'password') {
        if (pwDiv) pwDiv.classList.remove('hidden');
        if (keyDiv) keyDiv.classList.add('hidden');
    } else {
        if (pwDiv) pwDiv.classList.add('hidden');
        if (keyDiv) keyDiv.classList.remove('hidden');
    }
};

// ========== 新增服务器 ==========

window.arthasToggleNewServerForm = function () {
    const form = document.getElementById('arthasNewServerForm');
    if (form) form.classList.toggle('hidden');
};

window.arthasSaveNewServer = function () {
    const data = {
        name: document.getElementById('arthasNewServerName')?.value,
        host: document.getElementById('arthasNewServerHost')?.value,
        ssh_port: parseInt(document.getElementById('arthasNewServerSSHPort')?.value) || 22,
        username: document.getElementById('arthasNewServerUsername')?.value || 'root',
        password: document.getElementById('arthasNewServerPassword')?.value || '',
    };
    if (!data.name || !data.host) {
        showToast('服务器名称和地址不能为空', 'warning');
        return;
    }

    fetch('/api/arthas/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
        .then(r => r.json())
        .then(result => {
            if (result.success) {
                showToast('服务器添加成功', 'success');
                arthasToggleNewServerForm();
                arthasLoadSavedServers();
            } else {
                showToast('添加失败: ' + (result.message || ''), 'error');
            }
        });
};

// ========== 容器列表 ==========

window.arthasLoadContainers = function () {
    const select = document.getElementById('arthasContainerSelect');
    if (!select) return;
    select.innerHTML = '<option value="">主机进程（不使用容器）</option><option value="" disabled>加载中...</option>';

    if (arthasMode === 'local') {
        fetch('/api/arthas/local/containers')
            .then(r => r.json())
            .then(data => {
                select.innerHTML = '<option value="">主机进程（不使用容器）</option>';
                if (data.success && data.containers && data.containers.length > 0) {
                    data.containers.forEach(c => {
                        const opt = document.createElement('option');
                        opt.value = c.id || c.name;
                        opt.textContent = `${c.name} (${c.image}) - ${c.status}`;
                        select.appendChild(opt);
                    });
                }
            })
            .catch(() => {
                select.innerHTML = '<option value="">主机进程（不使用容器）</option>';
            });
    } else if (arthasSessionId) {
        fetch(`/api/arthas/sessions/${arthasSessionId}/containers`)
            .then(r => r.json())
            .then(data => {
                select.innerHTML = '<option value="">主机进程（不使用容器）</option>';
                if (data.success && data.containers && data.containers.length > 0) {
                    data.containers.forEach(c => {
                        const opt = document.createElement('option');
                        opt.value = c.id || c.name;
                        opt.textContent = `${c.name} (${c.image})`;
                        select.appendChild(opt);
                    });
                }
            })
            .catch(() => {
                select.innerHTML = '<option value="">主机进程（不使用容器）</option>';
            });
    }
};

window.arthasOnContainerSelected = function () {
    arthasCurrentContainer = document.getElementById('arthasContainerSelect')?.value || '';
    arthasLoadJavaProcesses();
};

// ========== Java 进程列表 ==========

window.arthasLoadJavaProcesses = function () {
    const select = document.getElementById('arthasProcessSelect');
    const manualDiv = document.getElementById('arthasManualPidDiv');
    if (!select) return;
    select.innerHTML = '<option value="">加载中...</option>';
    if (manualDiv) manualDiv.classList.add('hidden');

    const containerId = arthasCurrentContainer;

    if (arthasMode === 'local') {
        const url = containerId
            ? `/api/arthas/local/containers/${containerId}/java-processes`
            : '/api/arthas/local/java-processes';
        fetch(url)
            .then(r => r.json())
            .then(data => {
                select.innerHTML = '<option value="">选择Java进程...</option>';
                if (data.success && data.processes && data.processes.length > 0) {
                    data.processes.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.pid;
                        opt.textContent = `${p.pid} - ${p.name}`;
                        select.appendChild(opt);
                    });
                    if (manualDiv) manualDiv.classList.add('hidden');
                } else {
                    select.innerHTML = '<option value="">未找到Java进程</option>';
                    if (manualDiv) manualDiv.classList.remove('hidden');
                }
            })
            .catch(() => {
                select.innerHTML = '<option value="">加载失败</option>';
                if (manualDiv) manualDiv.classList.remove('hidden');
            });
    } else if (arthasSessionId) {
        const url = containerId
            ? `/api/arthas/sessions/${arthasSessionId}/containers/${containerId}/java-processes`
            : `/api/arthas/sessions/${arthasSessionId}/containers/_host/java-processes`;

        // 如果没有容器，直接在主机上查找进程
        if (!containerId) {
            // 主机进程：通过SSH执行jps
            fetch('/api/arthas/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ _action: 'list_processes', session_id: arthasSessionId })
            }).catch(() => {});
            // 简化：用已有的 API
            fetch(`/api/arthas/sessions/${arthasSessionId}/containers/_host/java-processes`)
                .then(r => {
                    if (r.status === 404) {
                        // fallback：直接通过远程进程列表API
                        return fetch('/api/arthas/remote/processes', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ server_id: null, host: document.getElementById('arthasSSHHost')?.value })
                        }).then(r2 => r2.json());
                    }
                    return r.json();
                })
                .then(data => {
                    select.innerHTML = '<option value="">选择Java进程...</option>';
                    if (data && data.success && data.processes) {
                        data.processes.forEach(p => {
                            const opt = document.createElement('option');
                            opt.value = p.pid;
                            opt.textContent = `${p.pid} - ${p.name}`;
                            select.appendChild(opt);
                        });
                        if (manualDiv) manualDiv.classList.add('hidden');
                    } else {
                        select.innerHTML = '<option value="">未找到Java进程</option>';
                        if (manualDiv) manualDiv.classList.remove('hidden');
                    }
                })
                .catch(() => {
                    select.innerHTML = '<option value="">加载失败</option>';
                    if (manualDiv) manualDiv.classList.remove('hidden');
                });
        } else {
            fetch(`/api/arthas/sessions/${arthasSessionId}/containers/${containerId}/java-processes`)
                .then(r => r.json())
                .then(data => {
                    select.innerHTML = '<option value="">选择Java进程...</option>';
                    if (data.success && data.processes && data.processes.length > 0) {
                        data.processes.forEach(p => {
                            const opt = document.createElement('option');
                            opt.value = p.pid;
                            opt.textContent = `${p.pid} - ${p.name}`;
                            select.appendChild(opt);
                        });
                        if (manualDiv) manualDiv.classList.add('hidden');
                    } else {
                        select.innerHTML = '<option value="">未找到Java进程</option>';
                        if (manualDiv) manualDiv.classList.remove('hidden');
                    }
                })
                .catch(() => {
                    select.innerHTML = '<option value="">加载失败</option>';
                    if (manualDiv) manualDiv.classList.remove('hidden');
                });
        }
    }
};

// ========== Arthas 启动 ==========

window.arthasStart = function () {
    arthasHttpPort = parseInt(document.getElementById('arthasHttpPort')?.value) || 8563;
    arthasCurrentPid = parseInt(document.getElementById('arthasProcessSelect')?.value) || null;

    if (!arthasCurrentPid) {
        showToast('请先选择Java进程', 'warning');
        return;
    }

    if (arthasMode === 'remote' && !arthasSessionId) {
        showToast('请先连接SSH', 'warning');
        return;
    }

    _updateStatus('connecting', '正在启动Arthas...');
    const startBtn = document.getElementById('arthasStartBtn');
    if (startBtn) startBtn.disabled = true;

    const payload = {
        javaPid: arthasCurrentPid,
        httpPort: arthasHttpPort,
        containerId: arthasCurrentContainer
    };

    const url = arthasMode === 'local'
        ? '/api/arthas/local/arthas/start'
        : `/api/arthas/sessions/${arthasSessionId}/arthas/start`;

    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(r => r.json())
        .then(data => {
            if (startBtn) startBtn.disabled = false;
            if (data.success) {
                arthasRunning = true;
                _updateStatus('connected', `Arthas已连接 (PID ${arthasCurrentPid}, 端口${arthasHttpPort})`);
                _toggleStartStop(true);
                showToast('Arthas启动成功！', 'success');
                // 显示命令面板
                const cmdPanel = document.getElementById('arthasCommandPanel');
                if (cmdPanel) cmdPanel.classList.remove('hidden');
            } else {
                _updateStatus('disconnected', '启动失败');
                showToast('Arthas启动失败: ' + (data.message || ''), 'error');
            }
        })
        .catch(err => {
            if (startBtn) startBtn.disabled = false;
            _updateStatus('disconnected', '请求失败');
            showToast('启动请求失败: ' + err.message, 'error');
        });
};

// ========== Arthas 停止 ==========

window.arthasStop = function () {
    const payload = {
        javaPid: arthasCurrentPid,
        httpPort: arthasHttpPort,
        containerId: arthasCurrentContainer
    };

    const url = arthasMode === 'local'
        ? '/api/arthas/local/arthas/stop'
        : `/api/arthas/sessions/${arthasSessionId}/arthas/stop`;

    _updateStatus('connecting', '正在停止Arthas...');

    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(r => r.json())
        .then(data => {
            arthasRunning = false;
            _updateStatus('disconnected', 'Arthas已停止');
            _toggleStartStop(false);
            showToast(data.message || 'Arthas已停止', 'success');
            // 隐藏命令面板
            const cmdPanel = document.getElementById('arthasCommandPanel');
            if (cmdPanel) cmdPanel.classList.add('hidden');
            // 停止异步监听
            _stopAsyncPull();
        })
        .catch(err => {
            showToast('停止请求失败: ' + err.message, 'error');
        });
};

// ========== 连接检测 ==========

window.arthasCheckStatus = function () {
    arthasHttpPort = parseInt(document.getElementById('arthasHttpPort')?.value) || 8563;
    const payload = { httpPort: arthasHttpPort, containerId: arthasCurrentContainer };

    if (arthasMode === 'remote' && !arthasSessionId) {
        showToast('请先连接SSH', 'warning');
        return;
    }

    _updateStatus('connecting', '正在检测...');

    const url = arthasMode === 'local'
        ? '/api/arthas/local/arthas/status'
        : `/api/arthas/sessions/${arthasSessionId}/arthas/status`;

    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(r => r.json())
        .then(data => {
            if (data.success && data.running) {
                arthasRunning = true;
                _updateStatus('connected', 'Arthas连接正常');
                _toggleStartStop(true);
                showToast('Arthas已运行', 'success');
                const cmdPanel = document.getElementById('arthasCommandPanel');
                if (cmdPanel) cmdPanel.classList.remove('hidden');
            } else {
                arthasRunning = false;
                _updateStatus('disconnected', 'Arthas未运行 — 点击"启动Arthas"');
                _toggleStartStop(false);
                if (data.message) showToast(data.message, 'info');
            }
        })
        .catch(err => {
            arthasRunning = false;
            _updateStatus('disconnected', '检测失败');
            showToast('检测请求失败: ' + err.message, 'error');
        });
};

// ========== 命令面板标签切换 ==========

window.arthasShowCmdTab = function (tab) {
    const tabs = ['quick', 'method', 'custom'];
    tabs.forEach(t => {
        const btn = document.getElementById(`arthasCmdTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
        const panel = document.getElementById(`arthasCmd${t.charAt(0).toUpperCase() + t.slice(1)}`);
        if (t === tab) {
            if (btn) btn.className = 'px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-white transition-all';
            if (panel) panel.classList.remove('hidden');
        } else {
            if (btn) btn.className = 'px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-all';
            if (panel) panel.classList.add('hidden');
        }
    });
};

// ========== 命令执行 ==========

function _buildExecPayload(command) {
    return {
        command: command,
        httpPort: arthasHttpPort,
        containerId: arthasCurrentContainer,
        execTimeout: 30000
    };
}

function _execApiUrl() {
    if (arthasMode === 'local') {
        return '/api/arthas/local/arthas/exec';
    }
    return `/api/arthas/sessions/${arthasSessionId}/arthas/exec`;
}

window.arthasExecQuick = function (command) {
    if (!arthasRunning) { showToast('请先启动Arthas', 'warning'); return; }

    // 异步命令用 async API
    const asyncCommands = ['dashboard', 'profiler start', 'watch', 'trace', 'stack'];
    const isAsync = asyncCommands.some(cmd => command.trim().startsWith(cmd));

    _appendOutput(command, '执行中...', false);

    if (isAsync && arthasMode === 'local') {
        // 本机异步命令：使用 ArthasClient 的异步模式
        fetch('/api/arthas/local/arthas/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_buildExecPayload(command))
        })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    _updateOutput(command, data.output || '无输出', false);
                } else {
                    _updateOutput(command, data.output || data.message || '执行失败', true);
                }
            })
            .catch(err => {
                _updateOutput(command, '请求失败: ' + err.message, true);
            });
    } else {
        fetch(_execApiUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_buildExecPayload(command))
        })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    _updateOutput(command, data.output || '无输出', false);
                } else {
                    _updateOutput(command, data.output || data.message || '执行失败', true);
                }
            })
            .catch(err => {
                _updateOutput(command, '请求失败: ' + err.message, true);
            });
    }
};

window.arthasExecMethod = function (type) {
    if (!arthasRunning) { showToast('请先启动Arthas', 'warning'); return; }

    const cls = document.getElementById('arthasMethodClass')?.value || '';
    const method = document.getElementById('arthasMethodMethod')?.value || '';

    if (!cls || !method) {
        showToast('请填写类名和方法名', 'warning');
        return;
    }

    let command;
    if (type === 'watch') {
        command = `watch ${cls} ${method} '{params, returnObj, throwExp}' -n 5 -x 3`;
    } else if (type === 'trace') {
        command = `trace ${cls} ${method} -n 5`;
    } else if (type === 'stack') {
        command = `stack ${cls} ${method} -n 5`;
    } else {
        return;
    }

    // watch/trace/stack 是异步命令，用 async start API
    _appendOutput(command, '异步监听中...', false);
    _showAsyncControls(true);

    const asyncUrl = arthasMode === 'local'
        ? '/api/arthas/local/arthas/async/start'
        : `/api/arthas/sessions/${arthasSessionId}/arthas/async/start`;

    fetch(asyncUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            command: command,
            httpPort: arthasHttpPort,
            containerId: arthasCurrentContainer
        })
    })
        .then(r => r.json())
        .then(data => {
            if (data.success && data.jobId) {
                arthasAsyncJobId = data.jobId;
                // 开始拉取结果
                _startAsyncPull();
            } else {
                _showAsyncControls(false);
                _updateOutput(command, data.message || '异步启动失败', true);
            }
        })
        .catch(err => {
            _showAsyncControls(false);
            _updateOutput(command, '请求失败: ' + err.message, true);
        });
};

window.arthasExecCustom = function () {
    const command = document.getElementById('arthasCustomCmdInput')?.value?.trim();
    if (!command) { showToast('请输入命令', 'warning'); return; }
    if (!arthasRunning) { showToast('请先启动Arthas', 'warning'); return; }
    arthasExecQuick(command);
};

// ========== 异步命令拉取 ==========

function _startAsyncPull() {
    if (arthasAsyncPullTimer) clearInterval(arthasAsyncPullTimer);

    arthasAsyncPullTimer = setInterval(() => {
        if (!arthasAsyncJobId) { _stopAsyncPull(); return; }

        const pullUrl = arthasMode === 'local'
            ? '/api/arthas/local/arthas/exec'
            : `/api/arthas/sessions/${arthasSessionId}/arthas/async/pull`;

        fetch(pullUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                httpPort: arthasHttpPort,
                containerId: arthasCurrentContainer,
                jobId: arthasAsyncJobId
            })
        })
            .then(r => r.json())
            .then(data => {
                if (data.success && data.results) {
                    // 检查是否有输出
                    let output = '';
                    data.results.forEach(r => {
                        if (r.output) output += r.output + '\n';
                    });
                    if (output.trim()) {
                        // 找到当前 "异步监听中..." 的条目并更新
                        _updateOutput(null, output.trim(), false);
                    }
                }
            })
            .catch(() => {});
    }, 3000);
}

function _stopAsyncPull() {
    if (arthasAsyncPullTimer) {
        clearInterval(arthasAsyncPullTimer);
        arthasAsyncPullTimer = null;
    }
    arthasAsyncJobId = null;
    _showAsyncControls(false);
}

window.arthasInterruptAsync = function () {
    if (!arthasAsyncJobId) return;

    const interruptUrl = arthasMode === 'local'
        ? '/api/arthas/local/arthas/async/interrupt'
        : `/api/arthas/sessions/${arthasSessionId}/arthas/async/interrupt`;

    fetch(interruptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jobId: arthasAsyncJobId,
            httpPort: arthasHttpPort,
            containerId: arthasCurrentContainer
        })
    })
        .then(r => r.json())
        .then(() => {
            _stopAsyncPull();
            showToast('异步监听已停止', 'success');
        })
        .catch(err => {
            showToast('停止监听失败: ' + err.message, 'error');
        });
};

function _showAsyncControls(show) {
    const controls = document.getElementById('arthasAsyncControls');
    if (controls) controls.classList.toggle('hidden', !show);
}

// ========== 输出展示 ==========

let _outputCounter = 0;

function _appendOutput(title, content, isError) {
    const area = document.getElementById('arthasOutputArea');
    if (!area) return;

    // 清除占位符
    const placeholder = area.querySelector('.text-center');
    if (placeholder && placeholder.textContent.includes('请先')) {
        placeholder.remove();
    }

    const id = `arthas-out-${++_outputCounter}`;
    const timestamp = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.id = id;
    entry.className = isError
        ? 'bg-red-50 border border-red-200 rounded-lg p-3 fade-in'
        : 'bg-gray-50 border border-gray-200 rounded-lg p-3 fade-in';
    entry.innerHTML = `
        <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-medium text-gray-600">${title || '命令'}</span>
            <span class="text-xs text-gray-400">${timestamp}</span>
        </div>
        <pre class="text-sm text-gray-600 whitespace-pre-wrap max-h-60 overflow-y-auto code-block">${content}</pre>
    `;
    area.insertBefore(entry, area.firstChild);
}

function _updateOutput(title, content, isError) {
    const area = document.getElementById('arthasOutputArea');
    if (!area) return;

    // 找到 "执行中..." 或 "异步监听中..." 的条目
    const entries = area.querySelectorAll('[id^="arthas-out-"]');
    for (const entry of entries) {
        const pre = entry.querySelector('pre');
        if (pre && (pre.textContent.includes('执行中...') || pre.textContent.includes('异步监听中...'))) {
            pre.textContent = content;
            if (isError) {
                entry.className = 'bg-red-50 border border-red-200 rounded-lg p-3 fade-in';
                pre.className = 'text-sm text-red-600 whitespace-pre-wrap max-h-60 overflow-y-auto code-block';
            } else {
                entry.className = 'bg-gray-50 border border-gray-200 rounded-lg p-3 fade-in';
                pre.className = 'text-sm text-gray-600 whitespace-pre-wrap max-h-60 overflow-y-auto code-block';
            }
            if (title) {
                const titleEl = entry.querySelector('.font-medium');
                if (titleEl) titleEl.textContent = title;
            }
            return;
        }
    }

    // 没找到匹配条目，追加新条目
    _appendOutput(title, content, isError);
}

window.arthasClearOutput = function () {
    const area = document.getElementById('arthasOutputArea');
    if (!area) return;
    _outputCounter = 0;
    area.innerHTML = `
        <div class="text-center py-8 text-gray-400 text-sm">
            <i class="fa fa-terminal text-2xl mb-2 block"></i>
            请先连接服务器并启动Arthas，然后执行诊断命令
        </div>
    `;
};

// ========== 进程选择事件 ==========

window.arthasOnProcessSelected = function () {
    const select = document.getElementById('arthasProcessSelect');
    const manualDiv = document.getElementById('arthasManualPidDiv');
    if (select.value) {
        arthasCurrentPid = parseInt(select.value);
        if (manualDiv) manualDiv.classList.add('hidden');
    }
};

window.arthasSetManualPid = function () {
    const pidInput = document.getElementById('arthasManualPid');
    const select = document.getElementById('arthasProcessSelect');
    const pid = parseInt(pidInput.value);
    if (pid && pid > 0) {
        arthasCurrentPid = pid;
        showToast(`已设置手动PID: ${pid}`, 'success');
        // 更新选择框显示
        select.innerHTML = `<option value="${pid}" selected>手动输入 - PID ${pid}</option>`;
        const manualDiv = document.getElementById('arthasManualPidDiv');
        if (manualDiv) manualDiv.classList.add('hidden');
    } else {
        showToast('请输入有效的PID', 'warning');
    }
};

// ========== 容器日志查看 ==========

let _arthasLogController = null;

window.arthasShowContainerLogs = async function () {
    if (!arthasCurrentContainer) {
        showToast('请先选择一个容器', 'warning');
        return;
    }

    const lines = document.getElementById('arthasLogLines')?.value || 100;
    const follow = document.getElementById('arthasLogFollow')?.checked || false;
    const baseUrl = arthasMode === 'local'
        ? `/api/arthas/local/containers/${arthasCurrentContainer}/logs`
        : `/api/arthas/sessions/${arthasSessionId}/containers/${arthasCurrentContainer}/logs`;
    const url = `${baseUrl}?lines=${lines}&follow=${follow ? 'true' : 'false'}`;

    if (follow) {
        showToast('正在启动实时日志流...', 'info');
        arthasStopContainerLogs();
        _arthasLogController = new AbortController();

        const stopBtn = document.getElementById('arthasLogStopBtn');
        if (stopBtn) stopBtn.style.display = 'flex';

        _outputCounter++;
        const outputDiv = document.getElementById('arthasOutputArea');
        const sectionId = `output-${_outputCounter}`;
        const section = document.createElement('div');
        section.id = sectionId;
        section.className = 'mb-4 p-3 rounded-lg bg-gray-900 border border-gray-700';
        section.innerHTML = `
            <div class="flex items-center gap-2 mb-2">
                <span class="text-sm font-medium text-green-400">[实时日志] ${arthasCurrentContainer}</span>
                <span class="text-xs text-gray-500">(${lines} 行起始)</span>
                <span class="ml-auto inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            </div>
            <pre class="text-xs text-gray-300 font-mono whitespace-pre-wrap max-h-96 overflow-auto log-stream-${_outputCounter}" style="line-height: 1.4;"></pre>
        `;
        outputDiv.insertBefore(section, outputDiv.firstChild);

        try {
            const response = await fetch(url, { signal: _arthasLogController.signal });
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const logPre = section.querySelector(`.log-stream-${_outputCounter}`);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                logPre.textContent += decoder.decode(value, { stream: true });
                logPre.scrollTop = logPre.scrollHeight;
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                showToast('实时日志错误: ' + err.message, 'error');
            }
        }

        const statusDot = section.querySelector('.animate-pulse');
        if (statusDot) {
            statusDot.className = 'ml-auto inline-block w-2 h-2 rounded-full bg-gray-500';
        }
        if (stopBtn) stopBtn.style.display = 'none';
    } else {
        showToast('正在获取容器日志...', 'info');
        fetch(url)
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    _appendOutput(`容器日志 - ${arthasCurrentContainer} (最近 ${lines} 行)`, data.logs || '无日志内容', false);
                } else {
                    showToast('获取日志失败: ' + (data.message || ''), 'error');
                }
            })
            .catch(err => {
                showToast('获取日志失败: ' + err.message, 'error');
            });
    }
};

window.arthasStopContainerLogs = function () {
    if (_arthasLogController) {
        _arthasLogController.abort();
        _arthasLogController = null;
    }
    const stopBtn = document.getElementById('arthasLogStopBtn');
    if (stopBtn) stopBtn.style.display = 'none';
};

// ========== 容器选择事件 ==========

window.arthasOnContainerSelected = function () {
    const select = document.getElementById('arthasContainerSelect');
    const logSection = document.getElementById('arthasContainerLogSection');
    arthasCurrentContainer = select.value;
    
    if (logSection) {
        logSection.classList.toggle('hidden', !arthasCurrentContainer);
    }
    
    // 重新加载进程列表
    arthasLoadJavaProcesses();
};

// ========== 全局导出 ==========

// 所有带 window. 的函数已在上面定义