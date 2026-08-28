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
    const name = document.querySelector('#instanceName');
    if (name && /^实例\s*/.test(name.value)) {
      name.value = name.value.replace(/^实例\s*/, '频道分组 ');
    }

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
    queueMicrotask(normalizeControls);
  });
  document.querySelector('#btnManageInstance')?.addEventListener('click', () => {
    queueMicrotask(normalizeControls);
  });
})();
