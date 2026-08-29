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

  function setTextIfChanged(element, nextText) {
    if (!element) return;
    const next = String(nextText || '');
    if (element.textContent !== next) element.textContent = next;
  }

  function normalizeControls() {
    const title = document.querySelector('#instanceDialogTitle');
    if (title) setTextIfChanged(title, replaceText(title.textContent));

    const description = document.querySelector('#instanceDialogDescription');
    if (description) setTextIfChanged(description, replaceText(description.textContent));

    const save = document.querySelector('#btnSaveInstance');
    if (save) setTextIfChanged(save, replaceText(save.textContent));

    const del = document.querySelector('#btnDeleteInstance');
    if (del) setTextIfChanged(del, replaceText(del.textContent));
  }

  function normalizeAll(root = document.body) {
    normalizeTextNodes(root);
    normalizeControls();
  }

  function removeEmbeddedBrowserTab() {
    document.querySelector('.tab[data-tab="browser"]')?.remove();
    document.querySelector('#browser')?.remove();
  }

  function hideAdvancedSelectorSettings() {
    document.querySelector('#selectorList')?.closest('.card')?.classList.add('hidden');
    document.querySelector('#testResult')?.closest('.card')?.classList.add('hidden');
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
      if (description) {
        const next = `当前频道分组：${current.name}。可修改名称，也可删除该频道分组及其本地频道和任务数据。`;
        if (description.textContent !== next) description.textContent = next;
      }
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } catch (error) {
      console.error('读取频道分组名称失败', error);
    }
  }

  normalizeAll();
  removeEmbeddedBrowserTab();
  hideAdvancedSelectorSettings();

  const observer = new MutationObserver((mutations) => {
    let controlsNeedNormalize = false;
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
      controlsNeedNormalize = true;
    }
    if (controlsNeedNormalize) normalizeControls();
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
    setTimeout(() => {
      normalizeControls();
      fillCurrentGroupName();
    }, 0);
  });

  const form = document.querySelector('#instanceForm');
  form?.addEventListener('submit', () => {
    const input = document.querySelector('#instanceName');
    if (form.dataset.mode === 'edit' && input) input.value = String(input.value || '').trim();
  }, true);

  // 任务列表默认展示全部任务；单独脚本提供频道分组筛选和 QQ 频道搜索。
  if (!document.querySelector('script[data-task-list-filters]')) {
    const script = document.createElement('script');
    script.src = 'task-list-filters.js';
    script.dataset.taskListFilters = '1';
    document.body.appendChild(script);
  }

  // 评论区默认值：保存到 settings，创建普通任务/批量视频任务时自动填充。
  if (!document.querySelector('script[data-comment-default-setting]')) {
    const script = document.createElement('script');
    script.src = 'comment-default-setting.js';
    script.dataset.commentDefaultSetting = '1';
    document.body.appendChild(script);
  }

  // 账号工作区：退出后没有频道分组时仍允许登录；登录成功后按 account_id 恢复对应数据。
  if (!document.querySelector('script[data-account-workspace-ui]')) {
    const script = document.createElement('script');
    script.src = 'account-workspace-ui.js';
    script.dataset.accountWorkspaceUi = '1';
    document.body.appendChild(script);
  }
})();
