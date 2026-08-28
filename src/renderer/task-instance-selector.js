(() => {
  const qs = (selector) => document.querySelector(selector);
  const qsa = (selector) => [...document.querySelectorAll(selector)];
  let targetGroups = [];
  const expandedInstances = new Set();

  const escapeHtmlLocal = (value = '') => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function beijingLocalToISOString(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    // datetime-local 没有时区信息。这里固定把用户输入解释为北京时间（UTC+8），
    // 不再依赖 Windows 当前系统时区。
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) throw new Error('开始时间格式无效');
    const [, y, m, d, hh, mm, ss = '00'] = match;
    const utcMs = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) - 8, Number(mm), Number(ss));
    return new Date(utcMs).toISOString();
  }

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

  function channelCheckboxId(instanceId, channelId) {
    return `task-channel-${Number(instanceId)}-${Number(channelId)}`;
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
      const instanceId = Number(group.instance.id);
      const disabled = group.channels.length === 0;
      const expanded = expandedInstances.has(instanceId);
      const preview = group.channels.length
        ? group.channels.slice(0, 4).map(channel => escapeHtmlLocal(channel.name)).join('、') + (group.channels.length > 4 ? ` 等 ${group.channels.length} 个频道` : '')
        : '该实例暂未绑定频道';

      const channelsHtml = group.channels.map(channel => `
        <label style="display:flex;align-items:center;gap:10px;padding:8px 10px 8px 34px;border-top:1px solid #eef2f7;cursor:pointer;">
          <input type="checkbox" class="task-channel-checkbox" data-instance-id="${instanceId}" value="${Number(channel.id)}" id="${channelCheckboxId(instanceId, channel.id)}">
          <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtmlLocal(channel.name)}</span>
          <small style="color:#94a3b8;">单独创建 1 条任务</small>
        </label>`).join('');

      return `
        <div class="instance-target-group" data-instance-id="${instanceId}" style="border-bottom:1px solid #e7edf4;">
          <div style="display:flex;align-items:center;gap:10px;padding:12px 6px;">
            <input type="checkbox" class="task-instance-checkbox" value="${instanceId}" ${disabled ? 'disabled' : ''}>
            <button type="button" class="task-instance-expand" data-instance-id="${instanceId}" ${disabled ? 'disabled' : ''}
              style="border:0;background:transparent;padding:2px 4px;font-size:15px;min-width:24px;">
              ${expanded ? '▼' : '▶'}
            </button>
            <div class="task-instance-expand-area" data-instance-id="${instanceId}" style="flex:1;min-width:0;cursor:${disabled ? 'default' : 'pointer'};">
              <strong>${escapeHtmlLocal(group.instance.name)}</strong>
              <small style="display:block;margin-top:4px;color:#7b8ba0;line-height:1.45;white-space:normal;">${preview}</small>
            </div>
            <span style="color:${disabled ? '#9aa7b8' : '#1686ff'};white-space:nowrap;">${group.channels.length} 个频道</span>
          </div>
          <div class="task-instance-channels" data-instance-id="${instanceId}" style="display:${expanded ? 'block' : 'none'};background:#fafcff;">
            ${channelsHtml || '<div class="hint" style="padding:8px 34px;">暂无频道</div>'}
          </div>
        </div>`;
    }).join('');

    qsa('#taskChannelList .task-instance-checkbox').forEach(input => {
      input.addEventListener('change', () => {
        const instanceId = Number(input.value);
        qsa(`#taskChannelList .task-channel-checkbox[data-instance-id="${instanceId}"]`).forEach(channelInput => {
          channelInput.checked = input.checked;
        });
        syncInstanceCheckbox(instanceId);
        updateSummary();
      });
    });

    qsa('#taskChannelList .task-channel-checkbox').forEach(input => {
      input.addEventListener('change', () => {
        syncInstanceCheckbox(Number(input.dataset.instanceId));
        updateSummary();
      });
    });

    const toggleInstance = (instanceId) => {
      if (!instanceId) return;
      if (expandedInstances.has(instanceId)) expandedInstances.delete(instanceId);
      else expandedInstances.add(instanceId);
      const box = qs(`#taskChannelList .task-instance-channels[data-instance-id="${instanceId}"]`);
      const button = qs(`#taskChannelList .task-instance-expand[data-instance-id="${instanceId}"]`);
      if (box) box.style.display = expandedInstances.has(instanceId) ? 'block' : 'none';
      if (button) button.textContent = expandedInstances.has(instanceId) ? '▼' : '▶';
    };

    qsa('#taskChannelList .task-instance-expand').forEach(button => {
      button.addEventListener('click', () => toggleInstance(Number(button.dataset.instanceId)));
    });
    qsa('#taskChannelList .task-instance-expand-area').forEach(area => {
      area.addEventListener('click', () => toggleInstance(Number(area.dataset.instanceId)));
    });

    for (const group of targetGroups) syncInstanceCheckbox(Number(group.instance.id));
    updateSummary();
  }

  function syncInstanceCheckbox(instanceId) {
    const instanceInput = qs(`#taskChannelList .task-instance-checkbox[value="${instanceId}"]`);
    if (!instanceInput) return;
    const channels = qsa(`#taskChannelList .task-channel-checkbox[data-instance-id="${instanceId}"]`);
    const checkedCount = channels.filter(input => input.checked).length;
    instanceInput.checked = channels.length > 0 && checkedCount === channels.length;
    instanceInput.indeterminate = checkedCount > 0 && checkedCount < channels.length;
  }

  function selectedTargets() {
    const selectedIds = new Set(qsa('#taskChannelList .task-channel-checkbox:checked').map(input => Number(input.value)));
    const targets = [];
    for (const group of targetGroups) {
      for (const channel of group.channels) {
        if (selectedIds.has(Number(channel.id))) {
          targets.push({ instance: group.instance, channel });
        }
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

  async function saveTask() {
    const mediaType = qs('#taskMediaType')?.value || 'text';
    const mediaPath = qs('#mediaPath')?.value.trim() || '';
    const title = qs('#taskTitle')?.value.trim() || '';
    const comment = qs('#taskBodyText')?.value.trim() || '';
    const startTimeValue = qs('#taskStartTime')?.value || '';
    let intervalMinSeconds = Number(qs('#taskIntervalMin')?.value || 0);
    let intervalMaxSeconds = Number(qs('#taskIntervalMax')?.value || 0);
    const targets = selectedTargets();

    if (mediaType === 'image' && !mediaPath) return alert('请选择图片');
    if (mediaType === 'video' && !mediaPath) return alert('请选择视频');
    if (!targets.length) return alert('至少选择一个频道');
    if (!Number.isFinite(intervalMinSeconds) || !Number.isFinite(intervalMaxSeconds) || intervalMinSeconds < 0 || intervalMaxSeconds < 0) {
      return alert('随机间隔必须是大于或等于 0 的秒数');
    }
    if (intervalMaxSeconds < intervalMinSeconds) [intervalMinSeconds, intervalMaxSeconds] = [intervalMaxSeconds, intervalMinSeconds];

    const scheduledAt = startTimeValue ? beijingLocalToISOString(startTimeValue) : null;
    if (!title && mediaType === 'text') return alert('纯文本任务必须填写任务标题/发布内容');

    const instanceCount = new Set(targets.map(item => Number(item.instance.id))).size;
    if (!confirm(`已选择 ${instanceCount} 个实例中的 ${targets.length} 个频道。\n\n每个频道会单独创建 1 条任务，共 ${targets.length} 条任务。\n\n是否继续？`)) return;

    const button = qs('#btnSaveTask');
    if (button) {
      button.disabled = true;
      button.textContent = '创建中...';
    }

    try {
      let createdCount = 0;
      for (const target of targets) {
        createdCount += 1;
        if (button) button.textContent = `创建中 ${createdCount}/${targets.length}`;
        await window.api.createTask({
          instanceId: Number(target.instance.id),
          title,
          body: comment,
          mediaPath,
          mediaType,
          channelIds: [Number(target.channel.id)],
          scheduledAt,
          intervalMinSeconds,
          intervalMaxSeconds
        });
      }

      qs('#taskDialog')?.close();
      if (qs('#mediaPath')) qs('#mediaPath').value = '';
      if (qs('#taskTitle')) qs('#taskTitle').value = '';
      if (qs('#taskBodyText')) qs('#taskBodyText').value = '';

      const firstInstanceId = Number(targets[0].instance.id);
      const instanceSelect = qs('#instanceSelect');
      if (instanceSelect && Number(instanceSelect.value) !== firstInstanceId) {
        instanceSelect.value = String(firstInstanceId);
        instanceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        qs('#btnRefreshTasks')?.click();
      }

      alert(`创建完成：已生成 ${targets.length} 条独立任务，每个频道对应 1 条任务。`);
    } catch (error) {
      alert(`创建任务失败：${String(error?.message || error)}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '创建任务';
      }
    }
  }

  const createButton = replaceButton('btnCreateTask');
  const selectAllButton = replaceButton('btnSelectAll');
  const saveButton = replaceButton('btnSaveTask');

  createButton?.addEventListener('click', () => openTaskDialog().catch(error => alert(String(error?.message || error))));
  selectAllButton?.addEventListener('click', () => {
    qsa('#taskChannelList .task-channel-checkbox').forEach(input => { input.checked = true; });
    for (const group of targetGroups) syncInstanceCheckbox(Number(group.instance.id));
    updateSummary();
  });
  saveButton?.addEventListener('click', () => saveTask().catch(error => alert(String(error?.message || error))));

  const targetHead = qs('#taskDialog .target-head strong');
  if (targetHead) targetHead.textContent = '选择目标实例 / 频道（可多选）';
})();
