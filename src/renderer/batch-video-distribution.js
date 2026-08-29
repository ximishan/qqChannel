(() => {
  const qs = selector => document.querySelector(selector);
  const qsa = selector => [...document.querySelectorAll(selector)];
  const expandedBatchInstances = new Set();
  let batchTargetGroups = [];

  const escapeHtmlLocal = (value = '') => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function fileName(path = '') {
    return String(path).split(/[\\/]/).pop();
  }

  function fileStem(path = '') {
    const name = fileName(path);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }

  async function loadBatchTargetGroups() {
    const instances = await window.api.listInstances();
    batchTargetGroups = await Promise.all((instances || []).map(async instance => ({
      instance,
      channels: await window.api.listChannels(Number(instance.id))
    })));
    return batchTargetGroups;
  }

  function syncBatchInstanceCheckbox(instanceId) {
    const instanceInput = qs(`#batchChannelList .batch-instance-checkbox[value="${instanceId}"]`);
    if (!instanceInput) return;
    const channels = qsa(`#batchChannelList .batch-channel-checkbox[data-instance-id="${instanceId}"]`);
    const checkedCount = channels.filter(input => input.checked).length;
    instanceInput.checked = channels.length > 0 && checkedCount === channels.length;
    instanceInput.indeterminate = checkedCount > 0 && checkedCount < channels.length;
  }

  function selectedChannels() {
    const selectedIds = new Set(qsa('#batchChannelList .batch-channel-checkbox:checked').map(input => Number(input.value)));
    const result = [];
    for (const group of batchTargetGroups) {
      for (const channel of group.channels) {
        if (!selectedIds.has(Number(channel.id))) continue;
        result.push({
          id: Number(channel.id),
          name: String(channel.name || `频道 #${channel.id}`),
          instanceId: Number(group.instance.id),
          instanceName: String(group.instance.name || `频道分组 #${group.instance.id}`)
        });
      }
    }
    return result;
  }

  function updateBatchSelectionSummary() {
    const channels = selectedChannels();
    const groupCount = new Set(channels.map(item => item.instanceId)).size;
    let summary = qs('#batchTargetSummary');
    const head = qs('#batchVideoDialog .target-head');
    if (!summary && head) {
      summary = document.createElement('span');
      summary.id = 'batchTargetSummary';
      summary.className = 'target-summary';
      head.insertBefore(summary, qs('#btnBatchSelectAll'));
    }
    if (summary) summary.textContent = `已选 ${groupCount} 个频道分组 · ${channels.length} 个频道`;
  }

  function toggleBatchInstance(instanceId) {
    if (!instanceId) return;
    if (expandedBatchInstances.has(instanceId)) expandedBatchInstances.delete(instanceId);
    else expandedBatchInstances.add(instanceId);
    const box = qs(`#batchChannelList .batch-instance-channels[data-instance-id="${instanceId}"]`);
    const button = qs(`#batchChannelList .batch-instance-expand[data-instance-id="${instanceId}"]`);
    if (box) box.style.display = expandedBatchInstances.has(instanceId) ? 'block' : 'none';
    if (button) button.textContent = expandedBatchInstances.has(instanceId) ? '▼' : '▶';
  }

  function renderBatchTargets() {
    const host = qs('#batchChannelList');
    if (!host) return;

    if (!batchTargetGroups.length) {
      host.innerHTML = '<div class="hint">暂无频道分组，请先新建频道分组并添加频道。</div>';
      updateBatchSelectionSummary();
      return;
    }

    host.innerHTML = batchTargetGroups.map(group => {
      const instanceId = Number(group.instance.id);
      const disabled = group.channels.length === 0;
      const expanded = expandedBatchInstances.has(instanceId);
      const preview = group.channels.length
        ? group.channels.slice(0, 4).map(channel => escapeHtmlLocal(channel.name)).join('、') + (group.channels.length > 4 ? ` 等 ${group.channels.length} 个频道` : '')
        : '该频道分组暂未绑定频道';

      const channelsHtml = group.channels.map(channel => `
        <label class="batch-channel-row">
          <input type="checkbox" class="batch-channel-checkbox" data-instance-id="${instanceId}" value="${Number(channel.id)}">
          <span>${escapeHtmlLocal(channel.name)}</span>
          <small>单独创建 1 条任务</small>
        </label>`).join('');

      return `
        <div class="batch-instance-group" data-instance-id="${instanceId}">
          <div class="batch-instance-row">
            <input type="checkbox" class="batch-instance-checkbox" value="${instanceId}" ${disabled ? 'disabled' : ''}>
            <button type="button" class="batch-instance-expand" data-instance-id="${instanceId}" ${disabled ? 'disabled' : ''}>${expanded ? '▼' : '▶'}</button>
            <div class="batch-instance-expand-area" data-instance-id="${instanceId}">
              <strong>${escapeHtmlLocal(group.instance.name)}</strong>
              <small>${preview}</small>
            </div>
            <span class="batch-instance-count">${group.channels.length} 个频道</span>
          </div>
          <div class="batch-instance-channels" data-instance-id="${instanceId}" style="display:${expanded ? 'block' : 'none'};">
            ${channelsHtml || '<div class="hint" style="padding:8px 34px;">暂无频道</div>'}
          </div>
        </div>`;
    }).join('');

    qsa('#batchChannelList .batch-instance-checkbox').forEach(input => {
      input.addEventListener('change', () => {
        const instanceId = Number(input.value);
        qsa(`#batchChannelList .batch-channel-checkbox[data-instance-id="${instanceId}"]`).forEach(channelInput => {
          channelInput.checked = input.checked;
        });
        syncBatchInstanceCheckbox(instanceId);
        updateBatchSelectionSummary();
      });
    });

    qsa('#batchChannelList .batch-channel-checkbox').forEach(input => {
      input.addEventListener('change', () => {
        syncBatchInstanceCheckbox(Number(input.dataset.instanceId));
        updateBatchSelectionSummary();
      });
    });

    qsa('#batchChannelList .batch-instance-expand').forEach(button => {
      button.addEventListener('click', () => toggleBatchInstance(Number(button.dataset.instanceId)));
    });
    qsa('#batchChannelList .batch-instance-expand-area').forEach(area => {
      area.addEventListener('click', () => toggleBatchInstance(Number(area.dataset.instanceId)));
    });

    for (const group of batchTargetGroups) syncBatchInstanceCheckbox(Number(group.instance.id));
    updateBatchSelectionSummary();
  }

  function buildAssignments(videos, channels) {
    if (!videos.length || !channels.length) return [];
    // 每个频道只创建一个发布任务。
    // 视频少于频道：按顺序循环使用视频，尽量平均分配到所有频道。
    // 视频不少于频道：前 N 个视频与 N 个频道一一对应，多余视频不创建任务。
    return channels.map((channel, index) => ({
      channel,
      video: videos[index % videos.length]
    }));
  }

  function assignmentPreview(assignments, unusedCount) {
    const shown = assignments.slice(0, 8).map((item, index) =>
      `${index + 1}. ${item.channel.instanceName} / ${item.channel.name} ← ${fileName(item.video)}`
    ).join('\n');
    const more = assignments.length > 8 ? `\n……另有 ${assignments.length - 8} 个频道` : '';
    const unused = unusedCount > 0 ? `\n\n有 ${unusedCount} 个多余视频不会发布。` : '';
    return `${shown}${more}${unused}`;
  }

  function updateDescription() {
    const dialog = qs('#batchVideoDialog');
    if (!dialog) return;
    const subtitle = dialog.querySelector('.modal-head p');
    if (subtitle) subtitle.textContent = '每个频道只发布一次；视频少时循环平均分配，视频多时多余视频不发布。';
    const targetTitle = dialog.querySelector('.target-head strong');
    if (targetTitle) targetTitle.textContent = '选择目标频道分组 / 频道（可多选）';
  }

  async function openBatchDialog(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    batchVideoFiles = [];
    if (qs('#batchFolder')) qs('#batchFolder').value = '';
    if (qs('#batchVideoSummary')) qs('#batchVideoSummary').textContent = '尚未选择目录';
    if (qs('#batchVideoFiles')) qs('#batchVideoFiles').innerHTML = '';

    try {
      const settings = Object.fromEntries((await window.api.listSettings()).map(item => [item.key, item.value]));
      runtimeSettings = { ...runtimeSettings, ...settings };
      if (qs('#batchBody')) qs('#batchBody').value = settings.default_comment ?? '迅雷搜《孟德精选》';
    } catch (_) {
      if (qs('#batchBody')) qs('#batchBody').value = '迅雷搜《孟德精选》';
    }

    const host = qs('#batchChannelList');
    if (host) host.innerHTML = '<div class="hint">正在加载频道分组和频道...</div>';
    qs('#batchVideoDialog')?.showModal();

    try {
      expandedBatchInstances.clear();
      await loadBatchTargetGroups();
      renderBatchTargets();
    } catch (error) {
      if (host) host.innerHTML = `<div class="hint">加载频道失败：${escapeHtmlLocal(error?.message || error)}</div>`;
    }
  }

  async function createBatchTasks(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const button = qs('#btnCreateBatchTasks');
    const videos = Array.isArray(batchVideoFiles) ? batchVideoFiles : [];
    const channels = selectedChannels();
    const bodyTemplate = String(qs('#batchBody')?.value || '');

    if (!videos.length) return alert('请先选择包含视频的目录');
    if (!channels.length) return alert('至少选择一个频道');

    const assignments = buildAssignments(videos, channels);
    const unusedCount = Math.max(0, videos.length - channels.length);
    const repeatedCount = Math.max(0, channels.length - videos.length);
    const groupCount = new Set(channels.map(item => item.instanceId)).size;
    const distributionText = repeatedCount > 0
      ? `视频少于频道，将循环使用 ${repeatedCount} 次，使 ${channels.length} 个频道各发布 1 次。`
      : videos.length === channels.length
        ? `${videos.length} 个视频与 ${channels.length} 个频道一一对应。`
        : `只使用前 ${channels.length} 个视频，剩余 ${unusedCount} 个视频不发布。`;

    const preview = assignmentPreview(assignments, unusedCount);
    if (!confirm(`已选择 ${groupCount} 个频道分组中的 ${channels.length} 个频道。\n\n本次将创建 ${channels.length} 条任务，每个频道只发布 1 次。\n\n${distributionText}\n\n分配预览：\n${preview}\n\n是否继续？`)) return;

    button.disabled = true;
    button.textContent = '创建中...';
    try {
      let created = 0;
      for (const { channel, video } of assignments) {
        created += 1;
        button.textContent = `创建中 ${created}/${assignments.length}`;
        const stem = fileStem(video);
        const body = bodyTemplate.replaceAll('{filename}', stem);
        await window.api.createTask({
          instanceId: channel.instanceId,
          title: stem,
          body,
          mediaPath: video,
          mediaType: 'video',
          channelIds: [channel.id],
          scheduledAt: null,
          intervalMinSeconds: Number(runtimeSettings.interval_min_seconds ?? 180),
          intervalMaxSeconds: Number(runtimeSettings.interval_max_seconds ?? 480)
        });
      }

      qs('#batchVideoDialog')?.close();

      const firstInstanceId = assignments[0]?.channel?.instanceId;
      const instanceSelect = qs('#instanceSelect');
      if (firstInstanceId && instanceSelect && Number(instanceSelect.value) !== Number(firstInstanceId)) {
        instanceSelect.value = String(firstInstanceId);
        instanceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        qs('#btnRefreshTasks')?.click();
      }
      await refreshSchedulerState();

      const extra = unusedCount > 0 ? `；${unusedCount} 个多余视频未创建任务` : '';
      alert(`已创建 ${assignments.length} 条任务，覆盖 ${groupCount} 个频道分组，每个频道 1 条${extra}`);
    } catch (error) {
      alert(`批量创建失败：${String(error?.message || error)}`);
    } finally {
      button.disabled = false;
      button.textContent = '批量创建任务';
    }
  }

  function install() {
    updateDescription();

    const openButton = qs('#btnBatchVideo');
    if (openButton && openButton.dataset.groupSelectorInstalled !== '1') {
      openButton.dataset.groupSelectorInstalled = '1';
      openButton.addEventListener('click', event => {
        openBatchDialog(event).catch(error => alert(String(error?.message || error)));
      }, true);
    }

    const selectAllButton = qs('#btnBatchSelectAll');
    if (selectAllButton && selectAllButton.dataset.groupSelectorInstalled !== '1') {
      selectAllButton.dataset.groupSelectorInstalled = '1';
      selectAllButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        qsa('#batchChannelList .batch-channel-checkbox').forEach(input => { input.checked = true; });
        for (const group of batchTargetGroups) syncBatchInstanceCheckbox(Number(group.instance.id));
        updateBatchSelectionSummary();
      }, true);
    }

    const createButton = qs('#btnCreateBatchTasks');
    if (createButton && createButton.dataset.groupSelectorInstalled !== '1') {
      createButton.dataset.groupSelectorInstalled = '1';
      createButton.addEventListener('click', event => {
        createBatchTasks(event).catch(error => alert(String(error?.message || error)));
      }, true);
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
