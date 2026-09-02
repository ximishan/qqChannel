(() => {
  const qs = selector => document.querySelector(selector);
  const qsa = selector => [...document.querySelectorAll(selector)];
  let targetGroups = [];
  const expandedInstances = new Set();

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
    targetGroups = await Promise.all((instances || []).map(async instance => ({
      instance,
      channels: await window.api.listChannels(Number(instance.id))
    })));
  }

  function selectedTargets() {
    const selectedIds = new Set(qsa('#taskChannelList .task-channel-checkbox:checked').map(input => Number(input.value)));
    const targets = [];
    for (const group of targetGroups) {
      for (const channel of group.channels) {
        if (selectedIds.has(Number(channel.id))) targets.push({ instance: group.instance, channel });
      }
    }
    return targets;
  }

  function updateSummary() {
    const targets = selectedTargets();
    const instanceCount = new Set(targets.map(item => Number(item.instance.id))).size;
    const summary = qs('#taskTargetSummary');
    if (summary) summary.textContent = `已选 ${instanceCount} 个实例 · ${targets.length} 个频道 · 将创建 ${targets.length} 条任务`;
  }

  function syncInstanceCheckbox(instanceId) {
    const instanceInput = qs(`#taskChannelList .task-instance-checkbox[value="${instanceId}"]`);
    if (!instanceInput) return;
    const channels = qsa(`#taskChannelList .task-channel-checkbox[data-instance-id="${instanceId}"]`);
    const checkedCount = channels.filter(input => input.checked).length;
    instanceInput.checked = channels.length > 0 && checkedCount === channels.length;
    instanceInput.indeterminate = checkedCount > 0 && checkedCount < channels.length;
  }

  function toggleInstance(instanceId) {
    if (!instanceId) return;
    if (expandedInstances.has(instanceId)) expandedInstances.delete(instanceId);
    else expandedInstances.add(instanceId);
    const box = qs(`#taskChannelList .task-instance-channels[data-instance-id="${instanceId}"]`);
    const button = qs(`#taskChannelList .task-instance-expand[data-instance-id="${instanceId}"]`);
    if (box) box.style.display = expandedInstances.has(instanceId) ? 'block' : 'none';
    if (button) button.textContent = expandedInstances.has(instanceId) ? '▼' : '▶';
  }

  function renderInstanceTargets() {
    const host = qs('#taskChannelList');
    if (!host) return;
    if (!targetGroups.length) {
      host.innerHTML = '<div class="hint">暂无实例，请先新建实例并登录 QQ。</div>';
      updateSummary();
      return;
    }

    host.innerHTML = targetGroups.map(group => {
      const instanceId = Number(group.instance.id);
      const disabled = group.channels.length === 0;
      const expanded = expandedInstances.has(instanceId);
      const preview = group.channels.length
        ? group.channels.slice(0, 4).map(channel => escapeHtmlLocal(channel.name)).join('、') + (group.channels.length > 4 ? ` 等 ${group.channels.length} 个频道` : '')
        : '该实例暂未同步到频道';
      const channelsHtml = group.channels.map(channel => `
        <label class="task-channel-row">
          <input type="checkbox" class="task-channel-checkbox" data-instance-id="${instanceId}" value="${Number(channel.id)}">
          <span>${escapeHtmlLocal(channel.name)}</span>
          <small>单独创建 1 条任务</small>
        </label>`).join('');

      return `
        <div class="instance-target-group" data-instance-id="${instanceId}">
          <div class="task-instance-row">
            <input type="checkbox" class="task-instance-checkbox" value="${instanceId}" ${disabled ? 'disabled' : ''}>
            <button type="button" class="task-instance-expand" data-instance-id="${instanceId}" ${disabled ? 'disabled' : ''}>${expanded ? '▼' : '▶'}</button>
            <div class="task-instance-expand-area" data-instance-id="${instanceId}">
              <strong>${escapeHtmlLocal(group.instance.name)}</strong>
              <small>${preview}</small>
            </div>
            <span class="task-instance-count">${group.channels.length} 个频道</span>
          </div>
          <div class="task-instance-channels" data-instance-id="${instanceId}" style="display:${expanded ? 'block' : 'none'}">
            ${channelsHtml || '<div class="hint" style="padding:8px 34px">暂无频道</div>'}
          </div>
        </div>`;
    }).join('');

    qsa('#taskChannelList .task-instance-checkbox').forEach(input => input.addEventListener('change', () => {
      const instanceId = Number(input.value);
      qsa(`#taskChannelList .task-channel-checkbox[data-instance-id="${instanceId}"]`).forEach(channel => { channel.checked = input.checked; });
      syncInstanceCheckbox(instanceId);
      updateSummary();
    }));
    qsa('#taskChannelList .task-channel-checkbox').forEach(input => input.addEventListener('change', () => {
      syncInstanceCheckbox(Number(input.dataset.instanceId));
      updateSummary();
    }));
    qsa('#taskChannelList .task-instance-expand').forEach(button => button.addEventListener('click', () => toggleInstance(Number(button.dataset.instanceId))));
    qsa('#taskChannelList .task-instance-expand-area').forEach(area => area.addEventListener('click', () => toggleInstance(Number(area.dataset.instanceId))));

    for (const group of targetGroups) syncInstanceCheckbox(Number(group.instance.id));
    updateSummary();
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
      expandedInstances.clear();
      await loadTargetGroups();
      renderInstanceTargets();
    } catch (error) {
      if (host) host.innerHTML = `<div class="hint">加载实例失败：${escapeHtmlLocal(error?.message || error)}</div>`;
    }
  }

  const createButton = replaceButton('btnCreateTask');
  const selectAllButton = replaceButton('btnSelectAll');

  createButton?.addEventListener('click', () => openTaskDialog().catch(error => alert(String(error?.message || error))));
  selectAllButton?.addEventListener('click', () => {
    qsa('#taskChannelList .task-channel-checkbox').forEach(input => { input.checked = true; });
    for (const group of targetGroups) syncInstanceCheckbox(Number(group.instance.id));
    updateSummary();
  });

  const targetHead = qs('#taskDialog .target-head strong');
  if (targetHead) targetHead.textContent = '选择目标实例 / 频道（可多选）';

  const statusText = { pending: '待发布', running: '发布中', success: '成功', failed: '失败' };
  const queueStatusText = { idle: '空闲', running: '发布中', waiting: '等待中', paused: '已暂停', stopped: '已停止', error: '异常' };

  function normalizeTaskTablePresentation() {
    qsa('#taskBody tr').forEach(row => {
      const cells = row.children;
      if (cells.length < 9) return;
      const channelCell = cells[3];
      const statusCell = cells[8];
      const chips = [...channelCell.querySelectorAll('.target-status-chip')];
      let targetState = '';
      chips.forEach(chip => {
        if (!targetState) targetState = ['pending', 'running', 'success', 'failed'].find(key => chip.classList.contains(key)) || '';
        const channelName = String(chip.textContent || '').split('·')[0].trim();
        chip.textContent = channelName;
        chip.classList.remove('pending', 'running', 'success', 'failed');
        chip.classList.add('channel-name-only');
      });
      const rawTaskState = String(statusCell.textContent || '').trim();
      const state = targetState || rawTaskState;
      const localized = statusText[state] || rawTaskState;
      if (localized) statusCell.textContent = localized;
    });
  }

  function normalizeQueuePresentation() {
    const queue = qs('#queueStatus');
    if (!queue) return;
    const original = String(queue.textContent || '');
    queue.textContent = original.replace(/队列：(idle|running|waiting|paused|stopped|error)/, (_, state) => `队列：${queueStatusText[state] || state}`);
  }

  const taskBody = qs('#taskBody');
  if (taskBody) new MutationObserver(normalizeTaskTablePresentation).observe(taskBody, { childList: true, subtree: true, characterData: true });
  const queueStatus = qs('#queueStatus');
  if (queueStatus) new MutationObserver(normalizeQueuePresentation).observe(queueStatus, { childList: true, subtree: true, characterData: true });
  normalizeTaskTablePresentation();
  normalizeQueuePresentation();
})();