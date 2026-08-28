(() => {
  const qs = (selector) => document.querySelector(selector);
  const qsa = (selector) => [...document.querySelectorAll(selector)];
  let targetGroups = [];

  const escapeHtmlLocal = (value = '') => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function replaceButton(id) {
    const oldButton = qs(`#${id}`);
    if (!oldButton) return null;
    const newButton = oldButton.cloneNode(true);
    oldButton.replaceWith(newButton);
    return newButton;
  }

  async function loadTargetGroups() {
    const instances = await window.api.listInstances();
    targetGroups = await Promise.all(instances.map(async instance => ({
      instance,
      channels: await window.api.listChannels(Number(instance.id))
    })));
    return targetGroups;
  }

  function renderInstanceTargets() {
    const host = qs('#taskChannelList');
    if (!host) return;

    if (!targetGroups.length) {
      host.innerHTML = '<div class="hint">暂无实例，请先新建实例并绑定频道。</div>';
      updateSummary();
      return;
    }

    host.innerHTML = targetGroups.map(group => {
      const disabled = group.channels.length === 0;
      const channelPreview = group.channels.length
        ? group.channels.slice(0, 4).map(channel => escapeHtmlLocal(channel.name)).join('、') + (group.channels.length > 4 ? ` 等 ${group.channels.length} 个频道` : '')
        : '该实例暂未绑定频道';
      return `
        <label class="target-check instance-target-check${disabled ? ' disabled' : ''}">
          <input type="checkbox" class="task-instance-checkbox" value="${Number(group.instance.id)}" ${disabled ? 'disabled' : ''}>
          <span>
            <strong>${escapeHtmlLocal(group.instance.name)}</strong>
            <small style="display:block;margin-top:4px;color:#7b8ba0;line-height:1.45;">${channelPreview}</small>
          </span>
          <span style="margin-left:auto;color:${disabled ? '#9aa7b8' : '#1686ff'};white-space:nowrap;">${group.channels.length} 个频道</span>
        </label>`;
    }).join('');

    qsa('#taskChannelList .task-instance-checkbox').forEach(input => input.addEventListener('change', updateSummary));
    updateSummary();
  }

  function selectedGroups() {
    const selected = new Set(qsa('#taskChannelList .task-instance-checkbox:checked').map(input => Number(input.value)));
    return targetGroups.filter(group => selected.has(Number(group.instance.id)));
  }

  function updateSummary() {
    const groups = selectedGroups();
    const channelCount = groups.reduce((sum, group) => sum + group.channels.length, 0);
    const summary = qs('#taskTargetSummary');
    if (summary) summary.textContent = `已选 ${groups.length} 个实例 · ${channelCount} 个频道 · 将创建 ${channelCount} 条任务`;
  }

  async function openTaskDialog() {
    const mediaType = qs('#taskMediaType');
    if (mediaType) mediaType.value = 'text';
    qs('#taskMediaRow')?.classList.add('hidden');
    if (qs('#mediaPath')) qs('#mediaPath').value = '';
    if (qs('#taskStartTime')) qs('#taskStartTime').value = '';

    const settings = Object.fromEntries((await window.api.listSettings()).map(item => [item.key, item.value]));
    if (qs('#taskIntervalMin')) qs('#taskIntervalMin').value = settings.interval_min_seconds ?? '180';
    if (qs('#taskIntervalMax')) qs('#taskIntervalMax').value = settings.interval_max_seconds ?? '480';

    const host = qs('#taskChannelList');
    if (host) host.innerHTML = '<div class="hint">正在加载实例和频道...</div>';
    qs('#taskDialog')?.showModal();

    try {
      await loadTargetGroups();
      renderInstanceTargets();
    } catch (error) {
      if (host) host.innerHTML = `<div class="hint">加载实例失败：${escapeHtmlLocal(error?.message || error)}</div>`;
    }
  }

  async function saveTask() {
    const mediaType = qs('#taskMediaType')?.value || 'text';
    const mediaPath = qs('#mediaPath')?.value.trim() || '';
    const title = qs('#taskTitle')?.value.trim() || '';
    const body = qs('#taskBodyText')?.value.trim() || '';
    const startTimeValue = qs('#taskStartTime')?.value || '';
    let intervalMinSeconds = Number(qs('#taskIntervalMin')?.value || 0);
    let intervalMaxSeconds = Number(qs('#taskIntervalMax')?.value || 0);
    const groups = selectedGroups();

    if (mediaType === 'image' && !mediaPath) return alert('请选择图片');
    if (mediaType === 'video' && !mediaPath) return alert('请选择视频');
    if (!groups.length) return alert('至少选择一个实例');
    if (!Number.isFinite(intervalMinSeconds) || !Number.isFinite(intervalMaxSeconds) || intervalMinSeconds < 0 || intervalMaxSeconds < 0) {
      return alert('随机间隔必须是大于或等于 0 的秒数');
    }
    if (intervalMaxSeconds < intervalMinSeconds) [intervalMinSeconds, intervalMaxSeconds] = [intervalMaxSeconds, intervalMinSeconds];

    const scheduledAt = startTimeValue ? new Date(startTimeValue).toISOString() : null;
    if (!body && !title) {
      if (mediaType === 'text') return alert('纯文本任务必须填写评论或标题');
      if (!confirm(`当前任务没有填写评论/标题，只发布${mediaType === 'image' ? '图片' : '视频'}，是否继续？`)) return;
    }

    const totalChannels = groups.reduce((sum, group) => sum + group.channels.length, 0);
    const instanceNames = groups.map(group => group.instance.name).join('、');
    if (!confirm(`将为 ${groups.length} 个实例创建任务：\n\n${instanceNames}\n\n共 ${totalChannels} 个频道，每个频道单独创建 1 条任务，共 ${totalChannels} 条任务。\n\n是否继续？`)) return;

    const button = qs('#btnSaveTask');
    if (button) {
      button.disabled = true;
      button.textContent = '创建中...';
    }

    try {
      let createdCount = 0;
      for (const group of groups) {
        for (const channel of group.channels) {
          createdCount += 1;
          if (button) button.textContent = `创建中 ${createdCount}/${totalChannels}`;
          await window.api.createTask({
            instanceId: Number(group.instance.id),
            title,
            body: body || title,
            mediaPath,
            mediaType,
            channelIds: [Number(channel.id)],
            scheduledAt,
            intervalMinSeconds,
            intervalMaxSeconds
          });
        }
      }

      qs('#taskDialog')?.close();
      if (qs('#mediaPath')) qs('#mediaPath').value = '';
      if (qs('#taskTitle')) qs('#taskTitle').value = '';
      if (qs('#taskBodyText')) qs('#taskBodyText').value = '';

      // 切换到第一个已选实例，让用户立即看到该实例下按频道拆分后的任务。
      const firstInstanceId = Number(groups[0].instance.id);
      const instanceSelect = qs('#instanceSelect');
      if (instanceSelect && Number(instanceSelect.value) !== firstInstanceId) {
        instanceSelect.value = String(firstInstanceId);
        instanceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        qs('#btnRefreshTasks')?.click();
      }

      alert(`创建完成：${groups.length} 个实例，共 ${totalChannels} 个频道，已生成 ${totalChannels} 条独立任务。\n每个频道对应 1 条任务。`);
    } catch (error) {
      alert(`创建任务失败：${String(error?.message || error)}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '创建任务';
      }
    }
  }

  // app.js 已经为这几个按钮注册了旧的“按频道选择”逻辑。
  // 通过替换节点移除旧监听，再绑定新的“按实例选择”行为，不影响其它已有功能。
  const createButton = replaceButton('btnCreateTask');
  const selectAllButton = replaceButton('btnSelectAll');
  const saveButton = replaceButton('btnSaveTask');

  createButton?.addEventListener('click', () => openTaskDialog().catch(error => alert(String(error?.message || error))));
  selectAllButton?.addEventListener('click', () => {
    qsa('#taskChannelList .task-instance-checkbox:not(:disabled)').forEach(input => { input.checked = true; });
    updateSummary();
  });
  saveButton?.addEventListener('click', () => saveTask().catch(error => alert(String(error?.message || error))));

  // 文案直接在运行时调整，避免和频道级旧逻辑混淆。
  const targetHead = qs('#taskDialog .target-head strong');
  if (targetHead) targetHead.textContent = '选择目标实例（可多选）';
})();
