(() => {
  const replaceTerms = value => String(value ?? '')
    .replace('QQ 登录全局共用；实例仅用于分组频道', '当前 QQ 账号独立登录；频道分组只管理该账号下的频道')
    .replace('实例用于分组管理频道；QQ 登录状态由所有实例共用。', '频道分组用于管理当前 QQ 账号下的频道；不同 QQ 账号的数据和登录状态互相隔离。')
    .replace(/实例/g, '频道分组')
    .replace(/所属频道分组频道/g, '所属频道分组');

  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  const nativePrompt = window.prompt.bind(window);
  window.alert = message => nativeAlert(replaceTerms(message));
  window.confirm = message => nativeConfirm(replaceTerms(message));
  window.prompt = (message, defaultValue) => nativePrompt(replaceTerms(message), defaultValue);

  let accountRows = [];
  let accountStatuses = new Map();
  let activeAccountId = null;
  let statusRefreshPromise = null;

  function replaceNodeText(root = document.body) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent || ['SCRIPT', 'STYLE'].includes(parent.tagName)) continue;
      const next = replaceTerms(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    }

    root.querySelectorAll?.('[placeholder],[title],[aria-label]').forEach(element => {
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        if (!element.hasAttribute(attr)) continue;
        const current = element.getAttribute(attr) || '';
        const next = replaceTerms(current);
        if (next !== current) element.setAttribute(attr, next);
      }
    });
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .account-switcher{display:inline-flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid #dbe5ef;border-radius:9px;background:#fff}
      .account-switcher-label{font-size:12px;color:#64748b;white-space:nowrap}
      #accountSelect{min-width:190px;max-width:260px;border:0;background:transparent;padding:5px 4px;font-weight:600}
      #accountSelect:focus{outline:none}
      .account-mini-btn{padding:6px 9px!important;min-width:auto!important;white-space:nowrap}
      .account-status-summary{font-size:12px;white-space:nowrap;padding:4px 7px;border-radius:999px;background:#f1f5f9;color:#475569}
      .account-status-summary.logged-in{background:#ecfdf5;color:#047857}
      .account-status-summary.logged-out{background:#fff7ed;color:#c2410c}
      .account-status-summary.checking{background:#eff6ff;color:#1d4ed8}
    `;
    document.head.appendChild(style);
  }

  function statusText(status) {
    if (!status) return '◌ 检测中';
    return status.loggedIn ? '● 已登录' : '○ 未登录';
  }

  function renderAccountOptions() {
    const select = document.querySelector('#accountSelect');
    if (!select) return;
    const currentValue = String(activeAccountId || select.value || '');
    select.innerHTML = accountRows.map(account => {
      const status = accountStatuses.get(Number(account.id));
      const state = statusText(status);
      const name = String(account.name || `QQ账号${account.id}`);
      return `<option value="${Number(account.id)}">${state} · ${name}</option>`;
    }).join('');
    if (currentValue && accountRows.some(item => String(item.id) === currentValue)) select.value = currentValue;
    updateCurrentStatusBadge();
  }

  function updateCurrentStatusBadge() {
    const badge = document.querySelector('#currentAccountLoginStatus');
    if (!badge) return;
    const status = accountStatuses.get(Number(activeAccountId));
    badge.className = 'account-status-summary';
    if (!status) {
      badge.classList.add('checking');
      badge.textContent = '当前账号：检测中';
      return;
    }
    if (status.loggedIn) {
      badge.classList.add('logged-in');
      badge.textContent = '当前账号：已登录';
    } else {
      badge.classList.add('logged-out');
      badge.textContent = '当前账号：未登录';
    }
  }

  async function refreshAccountStatuses() {
    if (statusRefreshPromise) return statusRefreshPromise;
    const refreshButton = document.querySelector('#btnRefreshAccountStatus');
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = '检测中...';
    }
    if (!accountStatuses.size) renderAccountOptions();

    statusRefreshPromise = (async () => {
      try {
        const statuses = await window.api.listAccountStatuses();
        accountStatuses = new Map((statuses || []).map(status => [Number(status.id), status]));
        renderAccountOptions();
      } catch (error) {
        console.error('检测QQ账号登录状态失败', error);
      } finally {
        if (refreshButton) {
          refreshButton.disabled = false;
          refreshButton.textContent = '↻状态';
        }
        statusRefreshPromise = null;
      }
    })();
    return statusRefreshPromise;
  }

  async function mountAccountUi() {
    const toolbar = document.querySelector('.toolbar');
    const loginButton = document.querySelector('#btnLogin');
    if (!toolbar || !loginButton || document.querySelector('#accountSelect')) return;

    injectStyles();
    const wrapper = document.createElement('div');
    wrapper.className = 'account-switcher';
    wrapper.innerHTML = `
      <span class="account-switcher-label">QQ账号</span>
      <select id="accountSelect" aria-label="QQ账号"></select>
      <span id="currentAccountLoginStatus" class="account-status-summary checking">当前账号：检测中</span>
      <button type="button" class="account-mini-btn" id="btnRefreshAccountStatus" title="检测全部QQ账号登录状态">↻状态</button>
      <button type="button" class="account-mini-btn" id="btnRenameAccount" title="修改当前账号名称">改名</button>
      <button type="button" class="account-mini-btn" id="btnAddAccount" title="新增QQ账号">＋账号</button>
    `;
    toolbar.insertBefore(wrapper, loginButton);

    const select = document.querySelector('#accountSelect');
    try {
      [accountRows, activeAccountId] = await Promise.all([
        window.api.listAccounts(),
        window.api.getActiveAccount()
      ]);
      renderAccountOptions();
      refreshAccountStatuses();
    } catch (error) {
      select.innerHTML = '<option>账号加载失败</option>';
      select.disabled = true;
      console.error(error);
    }

    select.addEventListener('change', async () => {
      const accountId = Number(select.value);
      if (!accountId) return;
      select.disabled = true;
      try {
        await window.api.setActiveAccount(accountId);
        location.reload();
      } catch (error) {
        select.disabled = false;
        alert(`切换QQ账号失败：${error?.message || error}`);
      }
    });

    document.querySelector('#btnRefreshAccountStatus')?.addEventListener('click', () => {
      refreshAccountStatuses();
    });

    document.querySelector('#btnAddAccount')?.addEventListener('click', async () => {
      const accounts = await window.api.listAccounts();
      const name = prompt('新账号名称', `QQ账号${accounts.length + 1}`);
      if (name == null) return;
      const clean = String(name).trim();
      if (!clean) return alert('账号名称不能为空');
      try {
        await window.api.createAccount(clean);
        location.reload();
      } catch (error) {
        alert(`新增QQ账号失败：${error?.message || error}`);
      }
    });

    document.querySelector('#btnRenameAccount')?.addEventListener('click', async () => {
      const accountId = Number(select.value);
      const account = accountRows.find(item => Number(item.id) === accountId);
      const currentName = account?.name || '';
      if (!accountId) return;
      const name = prompt('修改当前QQ账号名称', currentName);
      if (name == null) return;
      const clean = String(name).trim();
      if (!clean) return alert('账号名称不能为空');
      try {
        await window.api.renameAccount({ id: accountId, name: clean });
        if (account) account.name = clean;
        renderAccountOptions();
      } catch (error) {
        alert(`修改账号名称失败：${error?.message || error}`);
      }
    });

    // 当前账号扫码完成或手动检测之后，同步刷新整个账号列表的登录状态。
    document.querySelector('#btnCheckLogin')?.addEventListener('click', () => setTimeout(refreshAccountStatuses, 600));
    document.querySelector('#btnPollPublisherLogin')?.addEventListener('click', () => setTimeout(refreshAccountStatuses, 1200));

    replaceNodeText(document.body);
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          const next = replaceTerms(mutation.target.nodeValue);
          if (next !== mutation.target.nodeValue) mutation.target.nodeValue = next;
          continue;
        }
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) replaceNodeText(node);
          if (node.nodeType === Node.TEXT_NODE) {
            const next = replaceTerms(node.nodeValue);
            if (next !== node.nodeValue) node.nodeValue = next;
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.addEventListener('DOMContentLoaded', () => {
    mountAccountUi().catch(error => console.error('账号界面初始化失败', error));
  });
})();
