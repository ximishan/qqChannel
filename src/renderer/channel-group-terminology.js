(() => {
  const replaceText = (value) => String(value || '')
    .replaceAll('实例', '频道分组')
    .replaceAll('当前频道分组频道', '当前频道分组')
    .replaceAll('频道分组用于分组管理频道', '频道分组用于管理频道');

  function normalizeTextNodes(root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const next = replaceText(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
  }

  function normalizeControls() {
    const title = document.querySelector('#instanceDialogTitle');
    if (title) title.textContent = replaceText(title.textContent);

    const description = document.querySelector('#instanceDialogDescription');
    if (description) description.textContent = replaceText(description.textContent);

    const save = document.querySelector('#btnSaveInstance');
    if (save) save.textContent = replaceText(save.textContent);

    const del = document.querySelector('#btnDeleteInstance');
    if (del) del.textContent = replaceText(del.textContent);
  }

  function normalizeAll(root = document.body) {
    normalizeTextNodes(root);
    normalizeControls();
  }

  async function fillCurrentGroupName() {
    const form = document.querySelector('#instanceForm');
    const input = document.querySelector('#instanceName');
    const select = document.querySelector('#instanceSelect');
    if (!form || !input || !select || form.dataset.mode !== 'edit') return;

    const currentId = Number(select.value || 0);
    if (!currentId) return;

    try {
      const groups = await window.api.listInstances();
      const current = (groups || []).find(item => Number(item.id) === currentId);
      if (!current) return;
      input.value = String(current.name || '');
      input.placeholder = '请输入频道分组名称';
      const description = document.querySelector('#instanceDialogDescription');
      if (description) description.textContent = `当前频道分组：${current.name}。可修改名称，也可删除该频道分组及其本地频道和任务数据。`;
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } catch (error) {
      console.error('读取频道分组名称失败', error);
    }
  }

  normalizeAll();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData' && mutation.target?.nodeValue?.includes('实例')) {
        mutation.target.nodeValue = replaceText(mutation.target.nodeValue);
      }
      for (const node of mutation.addedNodes || []) {
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.includes('实例')) {
          node.nodeValue = replaceText(node.nodeValue);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          normalizeTextNodes(node);
        }
      }
    }
    normalizeControls();
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  document.querySelector('#btnNewInstance')?.addEventListener('click', () => {
    queueMicrotask(() => {
      normalizeControls();
      const input = document.querySelector('#instanceName');
      if (input && /^实例\s*/.test(input.value)) input.value = input.value.replace(/^实例\s*/, '频道分组 ');
    });
  });

  document.querySelector('#btnManageInstance')?.addEventListener('click', () => {
    // app.js 先打开弹窗；下一轮事件循环再从数据库重新读取当前分组名称，
    // 避免旧的动态文案/状态覆盖 input.value，导致管理弹窗只显示 placeholder。
    setTimeout(() => {
      normalizeControls();
      fillCurrentGroupName();
    }, 0);
  });

  const form = document.querySelector('#instanceForm');
  form?.addEventListener('submit', () => {
    const input = document.querySelector('#instanceName');
    if (form.dataset.mode === 'edit' && input) {
      // 保留用户实际输入，术语脚本不再改写编辑框 value。
      input.value = String(input.value || '').trim();
    }
  }, true);
})();
