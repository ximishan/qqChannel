(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  function installStyles() {
    if ($('#taskTitleCleanupStyle')) return;
    const style = document.createElement('style');
    style.id = 'taskTitleCleanupStyle';
    style.textContent = `
      /* 任务列表不展示内部任务名称，避免和真正发布到 QQ 的“内容”混淆。 */
      #tasks .table-wrap table th:nth-child(5),
      #tasks .table-wrap table td:nth-child(5){display:none}
      #taskContent{min-height:96px;resize:vertical}
    `;
    document.head.appendChild(style);
  }

  function getTitleLabel() {
    const input = $('#taskTitle');
    if (!input) return null;
    const previous = input.previousElementSibling;
    return previous && previous.tagName === 'LABEL' ? previous : null;
  }

  function ensureContentField() {
    if ($('#taskContent')) return $('#taskContent');
    const comment = $('#taskBodyText');
    if (!comment) return null;
    const commentLabel = comment.previousElementSibling;

    const label = document.createElement('label');
    label.htmlFor = 'taskContent';
    label.textContent = '内容';

    const textarea = document.createElement('textarea');
    textarea.id = 'taskContent';
    textarea.rows = 5;
    textarea.placeholder = '请输入要发布到 QQ 频道的正文内容；图片、视频任务也可以填写';

    if (commentLabel?.parentNode) {
      commentLabel.parentNode.insertBefore(label, commentLabel);
      commentLabel.parentNode.insertBefore(textarea, commentLabel);
    } else {
      comment.parentNode?.insertBefore(label, comment);
      comment.parentNode?.insertBefore(textarea, comment);
    }
    return textarea;
  }

  function normalizeTitleField() {
    const input = $('#taskTitle');
    const label = getTitleLabel();
    if (!input || !label) return;
    label.style.display = '';
    input.style.display = '';
    label.textContent = '任务名称（可选）';
    input.placeholder = '仅用于本地识别；留空会自动生成，不会发布到 QQ 频道';
  }

  function beijingLocalToISOString(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) throw new Error('开始时间格式无效');
    const [, y, m, d, hh, mm, ss = '00'] = match;
    const utcMs = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) - 8, Number(mm), Number(ss));
    return new Date(utcMs).toISOString();
  }

  function selectedTargets() {
    const specific = $$('#taskChannelList .task-channel-checkbox:checked');
    const inputs = specific.length
      ? specific
      : $$('#taskChannelList input[type="checkbox"]:checked').filter(input => !input.classList.contains('task-instance-checkbox'));
    const fallbackInstanceId = Number($('#instanceSelect')?.value || 0);
    return inputs.map(input => ({
      channelId: Number(input.value),
      instanceId: Number(input.dataset.instanceId || fallbackInstanceId)
    })).filter(item => item.channelId > 0 && item.instanceId > 0);
  }

  function deriveTitle(title, content, mediaPath, mediaType) {
    const explicit = String(title || '').trim();
    if (explicit) return explicit;
    const normalizedContent = String(content || '').replace(/\s+/g, ' ').trim();
    if (normalizedContent) return normalizedContent.slice(0, 80);
    const name = String(mediaPath || '').split(/[\\/]/).pop() || '';
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return stem || (mediaType === 'image' ? '图片任务' : mediaType === 'video' ? '视频任务' : '文本任务');
  }

  async function saveTaskWithContent() {
    const mediaType = $('#taskMediaType')?.value || 'text';
    const mediaPath = $('#mediaPath')?.value.trim() || '';
    const content = $('#taskContent')?.value.trim() || '';
    const comment = $('#taskBodyText')?.value.trim() || '';
    const title = deriveTitle($('#taskTitle')?.value, content, mediaPath, mediaType);
    const targets = selectedTargets();
    const startTimeValue = $('#taskStartTime')?.value || '';
    let intervalMinSeconds = Number($('#taskIntervalMin')?.value || 0);
    let intervalMaxSeconds = Number($('#taskIntervalMax')?.value || 0);

    if (mediaType === 'text' && !content) return alert('纯文本任务必须填写“内容”');
    if (mediaType === 'image' && !mediaPath) return alert('请选择图片');
    if (mediaType === 'video' && !mediaPath) return alert('请选择视频');
    if (!targets.length) return alert('至少选择一个频道');
    if (!Number.isFinite(intervalMinSeconds) || !Number.isFinite(intervalMaxSeconds) || intervalMinSeconds < 0 || intervalMaxSeconds < 0) {
      return alert('随机间隔必须是大于或等于 0 的秒数');
    }
    if (intervalMaxSeconds < intervalMinSeconds) [intervalMinSeconds, intervalMaxSeconds] = [intervalMaxSeconds, intervalMinSeconds];

    const scheduledAt = startTimeValue ? beijingLocalToISOString(startTimeValue) : null;
    const instanceCount = new Set(targets.map(item => item.instanceId)).size;
    if (!confirm(`已选择 ${instanceCount} 个实例中的 ${targets.length} 个频道。\n\n正文内容：${content ? '有' : '无'}\n自动评论：${comment ? '有' : '无'}\n\n每个频道会单独创建 1 条任务，共 ${targets.length} 条任务。是否继续？`)) return;

    const button = $('#btnSaveTask');
    if (button) {
      button.disabled = true;
      button.textContent = '创建中...';
    }

    try {
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (button) button.textContent = `创建中 ${i + 1}/${targets.length}`;
        await window.api.createTask({
          instanceId: target.instanceId,
          title,
          // 保持现有 IPC 字段名不变；主进程 task-content-support 会拆成 tasks.body + tasks.comment。
          body: { content, comment },
          mediaPath,
          mediaType,
          channelIds: [target.channelId],
          scheduledAt,
          intervalMinSeconds,
          intervalMaxSeconds
        });
      }

      $('#taskDialog')?.close();
      if ($('#mediaPath')) $('#mediaPath').value = '';
      if ($('#taskTitle')) $('#taskTitle').value = '';
      if ($('#taskContent')) $('#taskContent').value = '';
      if ($('#taskBodyText')) $('#taskBodyText').value = '';

      const firstInstanceId = targets[0]?.instanceId;
      const instanceSelect = $('#instanceSelect');
      if (firstInstanceId && instanceSelect && Number(instanceSelect.value) !== Number(firstInstanceId)) {
        instanceSelect.value = String(firstInstanceId);
        instanceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        $('#btnRefreshTasks')?.click();
      }

      alert(`创建完成：${targets.length} 条任务已保存，发布内容和评论已分开记录。`);
    } catch (error) {
      alert(`创建任务失败：${String(error?.message || error)}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '创建任务';
      }
    }
  }

  function replaceSaveButton() {
    const oldButton = $('#btnSaveTask');
    if (!oldButton) return;
    const newButton = oldButton.cloneNode(true);
    oldButton.replaceWith(newButton);
    newButton.addEventListener('click', () => saveTaskWithContent().catch(error => alert(String(error?.message || error))));
  }

  window.addEventListener('DOMContentLoaded', () => {
    installStyles();
    ensureContentField();
    normalizeTitleField();
    replaceSaveButton();

    $('#taskMediaType')?.addEventListener('change', normalizeTitleField);
    $('#btnCreateTask')?.addEventListener('click', () => {
      setTimeout(() => {
        ensureContentField();
        normalizeTitleField();
        if ($('#taskContent')) $('#taskContent').value = '';
        if ($('#taskTitle')) $('#taskTitle').value = '';
      }, 0);
    });
  });
})();
