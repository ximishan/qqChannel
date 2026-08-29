(() => {
  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  let messageQueue = Promise.resolve();
  let lastReplayAction = null;
  let bypassConfirmCount = 0;
  let confirmPending = false;

  function compactBatchPreview(text) {
    if (!text.includes('分配预览：')) return text;

    const totalMatch = text.match(/本次将创建\s*(\d+)\s*条任务/) || text.match(/中的\s*(\d+)\s*个频道/);
    const total = totalMatch ? Number(totalMatch[1]) : 0;
    const lines = text.split('\n');
    const output = [];
    let assignmentCount = 0;
    let inPreview = false;
    let summaryInserted = false;

    for (const rawLine of lines) {
      const line = String(rawLine || '');
      const trimmed = line.trim();
      if (trimmed === '分配预览：') {
        inPreview = true;
        output.push(line);
        continue;
      }

      if (inPreview && /^\d+\.\s/.test(trimmed)) {
        assignmentCount += 1;
        if (assignmentCount <= 5) {
          const compact = trimmed.length > 82 ? `${trimmed.slice(0, 79)}…` : trimmed;
          output.push(compact);
        } else if (!summaryInserted && total > 5) {
          output.push(`……其余 ${total - 5} 个频道不展开显示`);
          summaryInserted = true;
        }
        continue;
      }

      if (inPreview && /^……另有\s*\d+\s*个频道/.test(trimmed)) {
        if (!summaryInserted && total > 5) {
          output.push(`……其余 ${total - 5} 个频道不展开显示`);
          summaryInserted = true;
        }
        continue;
      }

      output.push(line);
    }

    if (inPreview && !summaryInserted && total > 5 && assignmentCount >= 5) {
      const continueIndex = output.findIndex(line => String(line).trim() === '是否继续？');
      const summary = `……其余 ${total - 5} 个频道不展开显示`;
      if (continueIndex >= 0) output.splice(continueIndex, 0, summary, '');
      else output.push(summary);
    }

    return output.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function normalizeMessage(value) {
    let text = String(value ?? '').trim();
    if (/^登录正常[：:].+/.test(text)) return '登录正常';
    text = compactBatchPreview(text);
    return text || '操作完成';
  }

  function inferType(message, fallback = 'info') {
    const text = String(message || '');
    if (/失败|错误|异常|不存在|不能为空|未登录|已失效|无效|超时/.test(text)) return 'error';
    if (/成功|完成|已保存|正常|已创建|已删除|已更新/.test(text)) return 'success';
    return fallback;
  }

  function titleFor(type, confirmMode = false) {
    if (confirmMode) return '请确认';
    if (type === 'success') return '操作成功';
    if (type === 'error') return '操作失败';
    if (type === 'warning') return '提示';
    return '提示';
  }

  function iconFor(type) {
    if (type === 'success') return '✓';
    if (type === 'error') return '!';
    if (type === 'warning') return '!';
    return 'i';
  }

  function ensureDialog() {
    let dialog = document.querySelector('#appMessageDialog');
    if (dialog) return dialog;

    dialog = document.createElement('dialog');
    dialog.id = 'appMessageDialog';
    dialog.className = 'app-message-dialog';
    dialog.innerHTML = `
      <div class="app-message-card">
        <button type="button" class="app-message-close" aria-label="关闭">×</button>
        <div class="app-message-main">
          <div class="app-message-icon" aria-hidden="true">i</div>
          <div class="app-message-copy">
            <div class="app-message-title">提示</div>
            <div class="app-message-text"></div>
          </div>
        </div>
        <div class="app-message-actions">
          <button type="button" class="app-message-cancel">取消</button>
          <button type="button" class="app-message-confirm primary">确定</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  function showMessage(message, options = {}) {
    const text = normalizeMessage(message);
    const confirmMode = Boolean(options.confirm);
    const type = options.type || inferType(text, confirmMode ? 'warning' : 'info');

    return new Promise(resolve => {
      const dialog = ensureDialog();
      const card = dialog.querySelector('.app-message-card');
      const icon = dialog.querySelector('.app-message-icon');
      const title = dialog.querySelector('.app-message-title');
      const body = dialog.querySelector('.app-message-text');
      const cancel = dialog.querySelector('.app-message-cancel');
      const confirm = dialog.querySelector('.app-message-confirm');
      const close = dialog.querySelector('.app-message-close');

      card.dataset.type = type;
      icon.textContent = iconFor(type);
      title.textContent = options.title || titleFor(type, confirmMode);
      body.textContent = text;
      cancel.classList.toggle('hidden', !confirmMode);
      confirm.textContent = options.confirmText || '确定';
      cancel.textContent = options.cancelText || '取消';

      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        dialog.removeEventListener('cancel', onCancel);
        dialog.removeEventListener('click', onBackdrop);
        confirm.removeEventListener('click', onConfirm);
        cancel.removeEventListener('click', onCancelClick);
        close.removeEventListener('click', onClose);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onConfirm = () => finish(true);
      const onCancelClick = () => finish(false);
      const onClose = () => finish(false);
      const onCancel = event => {
        event.preventDefault();
        finish(false);
      };
      const onBackdrop = event => {
        if (event.target === dialog) finish(false);
      };

      confirm.addEventListener('click', onConfirm);
      cancel.addEventListener('click', onCancelClick);
      close.addEventListener('click', onClose);
      dialog.addEventListener('cancel', onCancel);
      dialog.addEventListener('click', onBackdrop);

      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => confirm.focus());
    });
  }

  window.appAlert = (message, options = {}) => {
    const task = () => showMessage(message, { ...options, confirm: false });
    messageQueue = messageQueue.then(task, task);
    return messageQueue;
  };

  window.appConfirm = (message, options = {}) => {
    const task = () => showMessage(message, { ...options, confirm: true, type: options.type || 'warning' });
    messageQueue = messageQueue.then(task, task);
    return messageQueue;
  };

  function rememberClick(event) {
    const control = event.target?.closest?.('button, [role="button"], input[type="button"], input[type="submit"], a');
    if (!control || control.closest('#appMessageDialog')) return;
    lastReplayAction = () => {
      if (!control.isConnected) return;
      if (typeof control.click === 'function') control.click();
    };
  }

  function rememberSubmit(event) {
    const form = event.target;
    if (!form || form.closest?.('#appMessageDialog')) return;
    const submitter = event.submitter;
    lastReplayAction = () => {
      if (!form.isConnected || typeof form.requestSubmit !== 'function') return;
      form.requestSubmit(submitter?.isConnected ? submitter : undefined);
    };
  }

  document.addEventListener('click', rememberClick, true);
  document.addEventListener('submit', rememberSubmit, true);

  window.alert = message => {
    window.appAlert(message).catch(() => nativeAlert(normalizeMessage(message)));
  };

  window.confirm = message => {
    if (bypassConfirmCount > 0) {
      bypassConfirmCount -= 1;
      return true;
    }

    if (confirmPending) return false;
    const replay = lastReplayAction;
    if (!replay) return nativeConfirm(normalizeMessage(message));

    confirmPending = true;
    window.appConfirm(message).then(approved => {
      confirmPending = false;
      if (!approved) return;
      bypassConfirmCount += 1;
      setTimeout(() => {
        try {
          replay();
        } catch (error) {
          bypassConfirmCount = Math.max(0, bypassConfirmCount - 1);
          window.appAlert(String(error?.message || error), { type: 'error' });
        }
      }, 0);
    }).catch(error => {
      confirmPending = false;
      console.error('自定义确认弹窗失败', error);
    });
    return false;
  };
})();
