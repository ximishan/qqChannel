(() => {
  const replaceTerms = value => String(value ?? '')
    .replace(/实例/g, '频道分组')
    .replace(/所属频道分组频道/g, '所属频道分组');

  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  const nativePrompt = window.prompt.bind(window);
  window.alert = message => nativeAlert(replaceTerms(message));
  window.confirm = message => nativeConfirm(replaceTerms(message));
  window.prompt = (message, defaultValue) => nativePrompt(replaceTerms(message), defaultValue);

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
      #accountSelect{min-width:118px;max-width:180px;border:0;background:transparent;padding:5px 4px;font-weight:600}
      #accountSelect:focus{outline:none}
      .account-mini-btn{padding:6px 9px!important;min-width:auto!important;white-space:nowrap}
    `;
    document.head.appendChild(style);
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
      <button type="button" class="account-mini-btn" id="btnRenameAccount" title="修改当前账号名称">改名</button>
      <button type="button" class="account-mini-btn" id="btnAddAccount" title="新增QQ账号">＋账号</button>
    `;
    toolbar.insertBefore(wrapper, loginButton);

    const select = document.querySelector('#accountSelect');
    try {
      const [accounts, activeId] = await Promise.all([
        window.api.listAccounts(),
        window.api.getActiveAccount()
      ]);
      select.innerHTML = accounts.map(account =>
        `<option value="${Number(account.id)}">${String(account.name || `QQ账号${account.id}`)}</option>`
      ).join('');
      if (activeId) select.value = String(activeId);
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
      const currentName = select.selectedOptions?.[0]?.textContent || '';
      if (!accountId) return;
      const name = prompt('修改当前QQ账号名称', currentName);
      if (name == null) return;
      const clean = String(name).trim();
      if (!clean) return alert('账号名称不能为空');
      try {
        await window.api.renameAccount({ id: accountId, name: clean });
        select.selectedOptions[0].textContent = clean;
      } catch (error) {
        alert(`修改账号名称失败：${error?.message || error}`);
      }
    });

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
