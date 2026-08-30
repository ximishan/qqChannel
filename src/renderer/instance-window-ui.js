(() => {
  const params = new URLSearchParams(location.search);
  const fixedInstanceId = Math.max(0, Number(params.get('instanceId')) || 0);
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  window.QQCHANNEL_FIXED_INSTANCE_ID = fixedInstanceId || null;

  function loadUiFeedback() {
    if (document.querySelector('script[data-qqchannel-ui-feedback="1"]')) return;
    const script = document.createElement('script');
    script.src = 'ui-feedback.js';
    script.dataset.qqchannelUiFeedback = '1';
    document.head.appendChild(script);
  }

  function loadQrLoginUi() {
    if (document.querySelector('script[data-qqchannel-qr-login="1"]')) return;
    const script = document.createElement('script');
    script.src = 'login-qr-ui.js';
    script.dataset.qqchannelQrLogin = '1';
    document.head.appendChild(script);
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
    await window.api.openInstanceWindow({
      instanceId: id,
      name: String(instance?.name || '')
    });
  }

  function scopeTargetHost(host) {
    if (!fixedInstanceId || !host) return;
    const groups = [
      ...host.querySelectorAll('.instance-target-group[data-instance-id]'),
      ...host.querySelectorAll('.batch-instance-group[data-instance-id]')
    ];
    for (const group of groups) {
      const id = Number(group.dataset.instanceId || 0);
      const same = id === fixedInstanceId;
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
    scopeTargetHost($('#batchChannelList'));
  }

  function observeTargetHost(selector) {
    const host = $(selector);
    if (!host || !fixedInstanceId) return;
    const observer = new MutationObserver(() => scopeTargetHost(host));
    observer.observe(host, { childList: true, subtree: true });
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
    select.disabled = true;
    select.title = '当前窗口已固定绑定这个实例';

    const channelSelect = $('#channelInstanceSelect');
    if (channelSelect) {
      if ([...channelSelect.options].some(option => Number(option.value) === fixedInstanceId)) {
        channelSelect.value = String(fixedInstanceId);
      }
      channelSelect.disabled = true;
      channelSelect.title = '频道管理固定为当前窗口实例';
    }

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

  function installSelectAllGuards() {
    if (!fixedInstanceId) return;
    $('#btnSelectAll')?.addEventListener('click', () => setTimeout(scopeAllTargets, 0));
    $('#btnBatchSelectAll')?.addEventListener('click', () => setTimeout(scopeAllTargets, 0));
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
          if (!fixedInstanceId && window.api.hideCoordinatorWindow) {
            await window.api.hideCoordinatorWindow();
          }
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
    observeTargetHost('#taskChannelList');
    observeTargetHost('#batchChannelList');
    installSelectAllGuards();

    // 某些旧脚本在弹窗打开后会重新渲染所有实例；每次打开后再次收窄到当前实例。
    $('#btnCreateTask')?.addEventListener('click', () => setTimeout(scopeAllTargets, 250));
    $('#btnBatchVideo')?.addEventListener('click', () => setTimeout(scopeAllTargets, 250));
  }

  function start() {
    loadUiFeedback();
    loadQrLoginUi();
    installCreateInstanceWatcher();
    if (fixedInstanceId) {
      bootFixedWindow().catch(error => console.error('实例窗口初始化失败', error));
    } else {
      // 初始窗口只负责协调。已有实例时自动为每个实例创建独立窗口，然后隐藏自身。
      setTimeout(() => bootCoordinator().catch(error => console.error('打开实例窗口失败', error)), 500);
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();