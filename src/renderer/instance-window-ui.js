(() => {
  const params = new URLSearchParams(location.search);
  const fixedInstanceId = Math.max(0, Number(params.get('instanceId')) || 0);
  const $ = selector => document.querySelector(selector);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  window.QQCHANNEL_FIXED_INSTANCE_ID = fixedInstanceId || null;

  function loadScriptOnce(src, dataKey) {
    const attr = `data-${dataKey}`;
    if (document.querySelector(`script[${attr}="1"]`)) return;
    const script = document.createElement('script');
    script.src = src;
    script.setAttribute(attr, '1');
    document.head.appendChild(script);
  }

  function loadRuntimeUi() {
    loadScriptOnce('ui-feedback.js', 'qqchannel-ui-feedback');
    loadScriptOnce('login-qr-ui.js', 'qqchannel-qr-login');
    loadScriptOnce('publish-stage-ui.js', 'qqchannel-publish-stage');
  }

  async function waitFor(fn, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = fn();
      if (value) return value;
      await sleep(100);
    }
    return null;
  }

  async function getInstances() {
    try { return await window.api.listInstances(); }
    catch (_) { return []; }
  }

  async function openWindowFor(instance) {
    const id = Number(instance?.id || instance?.instanceId || instance);
    if (!id || !window.api.openInstanceWindow) return;
    await window.api.openInstanceWindow({ instanceId: id, name: String(instance?.name || '') });
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function formatCreatedAt(value) {
    const raw = String(value || '').trim();
    if (!raw) return '创建时间未知';
    const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? new Date(raw.replace(' ', 'T') + 'Z')
      : new Date(raw);
    if (Number.isNaN(date.getTime())) return `创建于 ${raw}`;
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `创建于 ${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
  }

  function scopeTargetHost(host) {
    if (!fixedInstanceId || !host) return;
    const groups = [...host.querySelectorAll('.instance-target-group[data-instance-id]')];
    for (const group of groups) {
      const same = Number(group.dataset.instanceId || 0) === fixedInstanceId;
      group.style.display = same ? '' : 'none';
      if (!same) {
        group.querySelectorAll('input[type="checkbox"]').forEach(input => {
          input.checked = false;
          input.indeterminate = false;
        });
      }
    }
  }

  function scopeAllTargets() {
    scopeTargetHost($('#taskChannelList'));
  }

  function observeTargetHost(selector) {
    const host = $(selector);
    if (!host || !fixedInstanceId) return;
    new MutationObserver(() => scopeTargetHost(host)).observe(host, { childList: true, subtree: true });
    scopeTargetHost(host);
  }

  async function restoreFixedInstance() {
    if (!fixedInstanceId) return;
    const select = await waitFor(() => {
      const el = $('#instanceSelect');
      return el && [...el.options].some(option => Number(option.value) === fixedInstanceId) ? el : null;
    }, 12000);
    if (!select) return;

    if (Number(select.value) !== fixedInstanceId) {
      select.value = String(fixedInstanceId);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250);
    }

    select.disabled = false;
    select.title = '选择其他实例可打开或聚焦对应实例窗口';

    const rows = await getInstances();
    const current = rows.find(item => Number(item.id) === fixedInstanceId);
    const name = current?.name || `实例 #${fixedInstanceId}`;
    document.title = `腾讯频道批量发布工具 - ${name}`;
    const title = $('.brand .title');
    if (title) title.textContent = `腾讯频道批量发布工具 · ${name}`;

    $('#btnQueueStartAll')?.classList.add('hidden');
    $('#btnQueueStopAll')?.classList.add('hidden');
    scopeAllTargets();
  }

  async function installInstanceWindowSwitcher() {
    if (!fixedInstanceId) return;
    const select = await waitFor(() => $('#instanceSelect'), 12000);
    if (!select || select.dataset.instanceWindowSwitcher === '1') return;
    select.dataset.instanceWindowSwitcher = '1';

    select.addEventListener('change', event => {
      const targetId = Number(select.value || 0);
      if (!targetId || targetId === fixedInstanceId) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      select.value = String(fixedInstanceId);

      setTimeout(async () => {
        try {
          const rows = await getInstances();
          const target = rows.find(item => Number(item.id) === targetId);
          if (!target) {
            window.qqToast?.('实例不存在，请刷新后重试', { type: 'error' });
            return;
          }
          await openWindowFor(target);
        } catch (error) {
          const message = `打开实例失败：${String(error?.message || error)}`;
          if (typeof window.qqToast === 'function') window.qqToast(message, { type: 'error' });
          else alert(message);
        }
      }, 0);
    }, true);
  }

  function installSelectAllGuard() {
    if (!fixedInstanceId) return;
    $('#btnSelectAll')?.addEventListener('click', () => setTimeout(scopeAllTargets, 0));
  }

  function installCreateInstanceWatcher() {
    if (!fixedInstanceId) return;
    const button = $('#btnNewInstance');
    const dialog = $('#instanceDialog');
    if (!button || !dialog) return;

    let beforeIds = null;
    button.addEventListener('click', async () => {
      beforeIds = new Set((await getInstances()).map(item => Number(item.id)));
    });

    dialog.addEventListener('close', () => {
      if (!beforeIds) return;
      const snapshot = beforeIds;
      beforeIds = null;
      setTimeout(async () => {
        const rows = await getInstances();
        const created = rows.find(item => !snapshot.has(Number(item.id)));
        if (created) await openWindowFor(created);
        await restoreFixedInstance();
        setTimeout(() => restoreFixedInstance().catch(() => {}), 800);
      }, 350);
    });
  }

  function installLauncherStyles() {
    if ($('#qqInstanceLauncherStyles')) return;
    const style = document.createElement('style');
    style.id = 'qqInstanceLauncherStyles';
    style.textContent = `
      body.qq-launcher-mode{margin:0;background:#f5f7fb;overflow:hidden;font-family:Inter,"Microsoft YaHei",sans-serif;color:#1f2937}
      body.qq-launcher-mode>.topbar,body.qq-launcher-mode>main,body.qq-launcher-mode>dialog{display:none!important}
      #qqInstanceLauncher{height:100vh;box-sizing:border-box;padding:20px;background:linear-gradient(180deg,#f9fbff 0%,#f3f6fb 100%);display:flex;flex-direction:column;gap:14px}
      .qq-launcher-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
      .qq-launcher-title{font-size:20px;font-weight:700;color:#162033}
      .qq-launcher-subtitle{margin-top:5px;color:#64748b;font-size:13px}
      .qq-launcher-refresh{border:1px solid #d9e2ef;background:#fff;border-radius:8px;padding:8px 13px;cursor:pointer}
      .qq-launcher-list{flex:1;min-height:0;overflow:auto;border:1px solid #dfe6ef;border-radius:10px;background:#fff;padding:6px}
      .qq-launcher-empty{height:100%;min-height:180px;display:flex;align-items:center;justify-content:center;color:#94a3b8}
      .qq-launcher-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 13px;border-radius:8px;cursor:pointer;border:1px solid transparent;user-select:none}
      .qq-launcher-item:hover{background:#f7faff}
      .qq-launcher-item.selected{background:#edf5ff;border-color:#b8d7ff;box-shadow:inset 3px 0 0 #1677ff}
      .qq-launcher-name{font-size:15px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .qq-launcher-meta{margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;color:#64748b;font-size:12px}
      .qq-launcher-status{padding:3px 8px;border-radius:999px;font-size:12px;background:#f1f5f9;color:#64748b}
      .qq-launcher-status.logged{background:#edf9f2;color:#159a58}
      .qq-launcher-new{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;align-items:center}
      .qq-launcher-new label{font-size:13px;color:#475569}
      .qq-launcher-new input{height:38px;box-sizing:border-box;border:1px solid #ccd7e5;border-radius:8px;padding:0 11px;font-size:14px;outline:none;background:#fff}
      .qq-launcher-new input:focus{border-color:#1677ff;box-shadow:0 0 0 3px rgba(22,119,255,.10)}
      .qq-launcher-actions{display:flex;justify-content:flex-end;gap:9px}
      .qq-launcher-actions button,.qq-launcher-new button{height:38px;border:1px solid #d3ddea;background:#fff;border-radius:8px;padding:0 16px;cursor:pointer;font-size:14px}
      .qq-launcher-actions .primary,.qq-launcher-new .primary{background:#1677ff;color:#fff;border-color:#1677ff}
      .qq-launcher-actions .danger{color:#e5484d;border-color:#f1c5c7}
      .qq-launcher-actions button:disabled{opacity:.45;cursor:not-allowed}
      .qq-launcher-hint{font-size:12px;color:#94a3b8;text-align:left}
    `;
    document.head.appendChild(style);
  }

  let launcherSelectedId = 0;
  let launcherRows = [];

  async function launcherRowsWithSummary() {
    const rows = await getInstances();
    return Promise.all((rows || []).map(async item => {
      let summary = null;
      try { summary = await window.api.getInstanceSummary(Number(item.id)); } catch (_) {}
      return { ...item, summary };
    }));
  }

  function renderLauncherList() {
    const host = $('#qqInstanceLauncherList');
    if (!host) return;
    if (!launcherRows.length) {
      host.innerHTML = '<div class="qq-launcher-empty">还没有实例，请在下方新建一个实例。</div>';
      const startButton = $('#qqLauncherStart');
      const deleteButton = $('#qqLauncherDelete');
      if (startButton) startButton.disabled = true;
      if (deleteButton) deleteButton.disabled = true;
      return;
    }

    if (!launcherRows.some(item => Number(item.id) === launcherSelectedId)) {
      launcherSelectedId = Number(launcherRows[0].id);
    }

    host.innerHTML = launcherRows.map(item => {
      const id = Number(item.id);
      const channels = Number(item.summary?.channel_count || 0);
      const logged = String(item.login_status || '') === 'logged_in';
      return `
        <div class="qq-launcher-item ${id === launcherSelectedId ? 'selected' : ''}" data-instance-id="${id}" tabindex="0">
          <div>
            <div class="qq-launcher-name">${escapeHtml(item.name || `实例 #${id}`)}</div>
            <div class="qq-launcher-meta">
              <span>${channels} 个频道</span>
              <span>·</span>
              <span>${escapeHtml(formatCreatedAt(item.created_at))}</span>
            </div>
          </div>
          <span class="qq-launcher-status ${logged ? 'logged' : ''}">${logged ? '已登录' : '未登录'}</span>
        </div>`;
    }).join('');

    host.querySelectorAll('.qq-launcher-item').forEach(item => {
      const select = () => {
        launcherSelectedId = Number(item.dataset.instanceId || 0);
        renderLauncherList();
      };
      item.addEventListener('click', select);
      item.addEventListener('dblclick', () => launchSelectedInstance().catch(showLauncherError));
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter') launchSelectedInstance().catch(showLauncherError);
      });
    });

    const startButton = $('#qqLauncherStart');
    const deleteButton = $('#qqLauncherDelete');
    if (startButton) startButton.disabled = !launcherSelectedId;
    if (deleteButton) deleteButton.disabled = !launcherSelectedId;
  }

  function showLauncherError(error) {
    const message = String(error?.message || error);
    if (typeof window.qqToast === 'function') window.qqToast(message, { type: 'error' });
    else alert(message);
  }

  async function refreshLauncher() {
    launcherRows = await launcherRowsWithSummary();
    renderLauncherList();
  }

  async function launchSelectedInstance() {
    const target = launcherRows.find(item => Number(item.id) === launcherSelectedId);
    if (!target) throw new Error('请先选择要启动的实例');
    const button = $('#qqLauncherStart');
    if (button) {
      button.disabled = true;
      button.textContent = '正在启动...';
    }
    try {
      await openWindowFor(target);
      if (window.api.hideCoordinatorWindow) await window.api.hideCoordinatorWindow();
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '启动';
      }
    }
  }

  async function createAndLaunchInstance() {
    const input = $('#qqLauncherNewName');
    const name = String(input?.value || '').trim();
    if (!name) {
      input?.focus();
      throw new Error('请输入实例名称');
    }
    const button = $('#qqLauncherCreate');
    if (button) button.disabled = true;
    try {
      const created = await window.api.createInstance(name);
      const target = { ...created, id: Number(created.createdInstanceId || created.id), name };
      await openWindowFor(target);
      if (window.api.hideCoordinatorWindow) await window.api.hideCoordinatorWindow();
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function deleteSelectedInstance() {
    const target = launcherRows.find(item => Number(item.id) === launcherSelectedId);
    if (!target) return;
    const summary = target.summary || await window.api.getInstanceSummary(launcherSelectedId);
    if (Number(summary.running_task_count || 0) > 0) throw new Error('该实例仍有正在发布的任务，不能删除');
    if (!confirm(`确定删除实例“${target.name}”？\n\n将同时删除 ${Number(summary.channel_count || 0)} 个本地频道和 ${Number(summary.task_count || 0)} 条任务记录。\n不会删除腾讯频道中的实际内容。`)) return;
    await window.api.deleteInstance(launcherSelectedId);
    launcherSelectedId = 0;
    await refreshLauncher();
  }

  async function bootCoordinator() {
    document.title = '腾讯频道批量发布工具 - 选择实例';
    document.body.classList.add('qq-launcher-mode');
    installLauncherStyles();

    const root = document.createElement('div');
    root.id = 'qqInstanceLauncher';
    root.innerHTML = `
      <div class="qq-launcher-head">
        <div>
          <div class="qq-launcher-title">选择实例</div>
          <div class="qq-launcher-subtitle">选择一个实例启动；程序不会再自动打开全部实例。</div>
        </div>
        <button type="button" class="qq-launcher-refresh" id="qqLauncherRefresh">↻ 刷新</button>
      </div>
      <div class="qq-launcher-list" id="qqInstanceLauncherList"><div class="qq-launcher-empty">正在读取实例...</div></div>
      <div class="qq-launcher-hint">双击实例也可以直接启动。</div>
      <div class="qq-launcher-new">
        <label for="qqLauncherNewName">新建：</label>
        <input id="qqLauncherNewName" maxlength="100" autocomplete="off" placeholder="输入实例名，例如：账号1、动漫频道、测试">
        <button type="button" class="primary" id="qqLauncherCreate">新建并启动</button>
      </div>
      <div class="qq-launcher-actions">
        <button type="button" class="danger" id="qqLauncherDelete">删除选中实例</button>
        <button type="button" class="primary" id="qqLauncherStart">启动</button>
        <button type="button" id="qqLauncherExit">退出</button>
      </div>`;
    document.body.appendChild(root);

    $('#qqLauncherRefresh')?.addEventListener('click', () => refreshLauncher().catch(showLauncherError));
    $('#qqLauncherStart')?.addEventListener('click', () => launchSelectedInstance().catch(showLauncherError));
    $('#qqLauncherCreate')?.addEventListener('click', () => createAndLaunchInstance().catch(showLauncherError));
    $('#qqLauncherDelete')?.addEventListener('click', () => deleteSelectedInstance().catch(showLauncherError));
    $('#qqLauncherExit')?.addEventListener('click', () => window.close());
    $('#qqLauncherNewName')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') createAndLaunchInstance().catch(showLauncherError);
    });

    await refreshLauncher();
  }

  async function bootFixedWindow() {
    await restoreFixedInstance();
    await installInstanceWindowSwitcher();
    observeTargetHost('#taskChannelList');
    installSelectAllGuard();
    installCreateInstanceWatcher();
    $('#btnCreateTask')?.addEventListener('click', () => setTimeout(scopeAllTargets, 250));
  }

  function start() {
    loadRuntimeUi();
    if (fixedInstanceId) {
      bootFixedWindow().catch(error => console.error('实例窗口初始化失败', error));
    } else {
      bootCoordinator().catch(error => console.error('实例启动器初始化失败', error));
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();