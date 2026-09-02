(() => {
  const fixedInstanceId = Math.max(0, Number(window.QQCHANNEL_FIXED_INSTANCE_ID || 0));

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function renderStage(data) {
    if (!data || data.type !== 'target-stage') return;
    if (fixedInstanceId && Number(data.instanceId) !== fixedInstanceId) return;
    const progress = document.querySelector('#publishProgress');
    if (!progress) return;

    const attempt = Math.max(1, Number(data.attempt) || 1);
    const stage = String(data.stage || '处理中');
    const detail = String(data.detail || '');
    progress.className = 'publish-progress';
    progress.innerHTML = [
      `<strong>任务 #${Number(data.taskId) || 0} 正在发布到：${escapeHtml(data.channelName || '')}</strong>`,
      `<br><span>当前步骤：${escapeHtml(stage)}</span>`,
      detail ? `<br><span>${escapeHtml(detail)}</span>` : '',
      `<br><span>第 ${attempt} 次尝试</span>`
    ].join('');
  }

  if (window.api?.onPublishUpdate) {
    window.api.onPublishUpdate(renderStage);
  }
})();
