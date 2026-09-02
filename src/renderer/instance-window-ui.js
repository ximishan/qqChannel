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
        if (created) {
          await openWindowFor(created);
          if (!fixedInstanceId && window.api.hideCoordinatorWindow) await window.api.hideCoordinatorWindow();
        }
        if (fixedInstanceId) {
          await restoreFixedInstance();
          setTimeout(() => restoreFixedInstance().catch(() => {}), 800);
        }
      }, 350);
    });
  }

  async function bootCoordinator() {
    const rows = await getInstances();
    if (!rows.length) return;
    for (const instance of rows) {
      await openWindowFor(instance);
      await sleep(60);
    }
    if (window.api.hideCoordinatorWindow) await window.api.hideCoordinatorWindow();
  }

  async function bootFixedWindow() {
    await restoreFixedInstance();
    await installInstanceWindowSwitcher();
    observeTargetHost('#taskChannelList');
    installSelectAllGuard();
    $('#btnCreateTask')?.addEventListener('click', () => setTimeout(scopeAllTargets, 250));
  }

  function start() {
    loadRuntimeUi();
    installCreateInstanceWatcher();
    if (fixedInstanceId) {
      bootFixedWindow().catch(error => console.error('实例窗口初始化失败', error));
    } else {
      setTimeout(() => bootCoordinator().catch(error => console.error('打开实例窗口失败', error)), 500);
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
