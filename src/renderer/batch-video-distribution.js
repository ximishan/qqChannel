(() => {
  const qs = selector => document.querySelector(selector);
  const qsa = selector => [...document.querySelectorAll(selector)];
  const expandedBatchInstances = new Set();
  let batchTargetGroups = [];

  const escapeHtmlLocal = (value = '') => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function installBatchSelectorStyles() {
    if (document.querySelector('#batchTargetSelectorStyles')) return;
    const style = document.createElement('style');
    style.id = 'batchTargetSelectorStyles';
    style.textContent = `
      #batchVideoDialog{width:min(1180px,94vw);max-height:94vh}
      #batchVideoDialog .modal{max-height:94vh;overflow:hidden;display:flex;flex-direction:column}
      #batchVideoDialog .modal-grid{grid-template-columns:minmax(0,1.18fr) minmax(420px,.9fr);min-height:0;overflow:hidden;flex:1}
      #batchVideoDialog .form-area{min-width:0;overflow:auto;padding-right:4px}
      #batchVideoDialog .target-area{min-width:0;overflow:hidden;display:flex;flex-direction:column}
      #batchVideoDialog .target-head{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;margin-bottom:6px}
      #batchVideoDialog .target-head strong{min-width:0;white-space:normal;line-height:1.35}
      #batchVideoDialog .target-summary{margin:0;white-space:nowrap;text-align:right}
      #batchVideoDialog #btnBatchSelectAll{white-space:nowrap;min-width:68px}
      #batchVideoDialog #batchChannelList{min-width:0;overflow:auto;flex:1;padding-right:4px}
      #batchVideoDialog .batch-instance-checkbox,#batchVideoDialog .batch-channel-checkbox{width:16px!important;height:16px;padding:0;margin:0;flex:0 0 16px;min-width:16px;border-radius:3px;box-shadow:none}
      #batchVideoDialog .batch-instance-group{width:100%;min-width:0;border-bottom:1px solid #e7edf4}
      #batchVideoDialog .batch-instance-row{display:flex;align-items:center;gap:10px;padding:12px 6px}
      #batchVideoDialog .batch-instance-expand{flex:0 0 28px!important;width:28px!important;min-width:28px!important;height:28px;padding:0!important;margin:0!important;border:0;background:transparent;font-size:15px}
      #batchVideoDialog .batch-instance-expand-area{flex:1;min-width:0!important;overflow:hidden;cursor:pointer}
      #batchVideoDialog .batch-instance-expand-area strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px;line-height:1.4}
      #batchVideoDialog .batch-instance-expand-area small{display:block;margin-top:4px;color:#7b8ba0;line-height:1.45;white-space:nowrap!important;overflow:hidden;text-overflow:ellipsis}
      #batchVideoDialog .batch-instance-count{color:#1686ff;white-space:nowrap}
      #batchVideoDialog .batch-instance-channels{background:#fafcff}
      #batchVideoDialog .batch-channel-row{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 34px;border-top:1px solid #eef2f7;cursor:pointer;margin:0!important;min-width:0}
      #batchVideoDialog .batch-channel-row span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #batchVideoDialog .batch-channel-row small{color:#94a3b8;white-space:nowrap}
      @media (max-width:980px){
        #batchVideoDialog .modal-grid{grid-template-columns:1fr}
        #batchVideoDialog .target-area{border-left:0;border-top:1px solid var(--line);padding-left:0;padding-top:14px;min-height:300px}
        #batchVideoDialog .target-head{grid-template-columns:1fr auto}
        #batchVideoDialog .target-summary{grid-column:1/-1;grid-row:2;text-align:left}
      }
    `;
    document.head.appendChild(style);
  }

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

  function syncInstanceCheckbox(instanceId) {
    const groupInput = qs(`#batchChannelList .batch-instance-checkbox[value="${instanceId}"]`);
    if (!groupInput) return;
    const channels = qsa(`#batchChannelList .batch-channel-checkbox[data-instance-id="${instanceId}"]`);
    const checkedCount = channels.filter(input => input.checked).length;
    groupInput.checked = channels.length > 0 && checkedCount === channels.length;
    groupInput.indeterminate = checkedCount > 0 && checkedCount < channels.length;
  }

  function updateSummary() {
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

  function toggleInstance(instanceId) {
    if (!instanceId) return;
    if (expandedBatchInstances.has(instanceId)) expandedBatchInstances.delete(instanceId);
    else expandedBatchInstances.add(instanceId);
    const channels = qs(`#batchChannelList .batch-instance-channels[data-instance-id="${instanceId}"]`);
    const button = qs(`#batchChannelList .batch-instance-expand[data-instance-id="${instanceId}"]`);
    if (channels) channels.style.display = expandedBatchInstances.has(instanceId) ? 'block' : 'none';
    if (button) button.textContent = expandedBatchInstances.has(instanceId) ? '▼' : '▶';
  }

  function renderTargets() {
    const host = qs('#batchChannelList');
    if (!host) return;
    if (!batchTargetGroups.length) {
      host.innerHTML = '<div class="hint">暂无频道分组，请先新建频道分组并添加频道。</div>';
      updateSummary();
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
          <div class="batch-instance-channels" data-instance-id="${instanceId}" style="display:${expanded ? 'block' : 'none'}">
            ${channelsHtml || '<div class="hint" style="padding:8px 34px">暂无频道</div>'}
          </div>
        </div>`;
    }).join('');

    qsa('#batchChannelList .batch-instance-checkbox').forEach(input => input.addEventListener('change', () => {
      const instanceId = Number(input.value);
      qsa(`#batchChannelList .batch-channel-checkbox[data-instance-id="${instanceId}"]`).forEach(channel => { channel.checked = input.checked; });
      syncInstanceCheckbox(instanceId);
      updateSummary();
    }));
    qsa('#batchChannelList .batch-channel-checkbox').forEach(input => input.addEventListener('change', () => {
      syncInstanceCheckbox(Number(input.dataset.instanceId));
      updateSummary();
    }));
    qsa('#batchChannelList .batch-instance-expand').forEach(button => button.addEventListener('click', () => toggleInstance(Number(button.dataset.instanceId))));
    qsa('#batchChannelList .batch-instance-expand-area').forEach(area => area.addEventListener('click', () => toggleInstance(Number(area.dataset.instanceId))));

    for (const group of batchTargetGroups) syncInstanceCheckbox(Number(group.instance.id));
    updateSummary();
  }

  function buildAssignments(videos, channels) {
    if (!videos.length || !channels.length) return [];
    return channels.map((channel, index) => ({ channel, video: videos[index % videos.length] }));
  }

  function assignmentPreview(assignments, unusedCount) {
    const shown = assignments.slice(0, 8).map((item, index) => `${index + 1}. ${item.channel.instanceName} / ${item.channel.name} ← ${fileName(item.video)}`).join('\n');
    const more = assignments.length > 8 ? `\n……另有 ${assignments.length - 8} 个频道` : '';
    const unused = unusedCount > 0 ? `\n\n有 ${unusedCount} 个多余视频不会发布。` : '';
    return `${shown}${more}${unused}`;
  }

  function updateDescription() {
    const dialog = qs('#batchVideoDialog');
    if (!dialog) return;
    const subtitle = dialog.querySelector('.modal-head p');
    if (subtitle) subtitle.textContent = '每个频道只发布一次；视频少时循环平均分配，视频多时多余视频不发布。';
    const title = dialog.querySelector('.target-head strong');
    if (title) title.textContent = '选择目标频道分组 / 频道（可多选）';
  }

  async function openDialog(event) {
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
      renderTargets();
    } catch (error) {
      if (host) host.innerHTML = `<div class="hint">加载频道失败：${escapeHtmlLocal(error?.message || error)}</div>`;
    }
  }

  async function createTasks(event) {
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
        await window.api.createTask({
          instanceId: channel.instanceId,
          title: stem,
          body: bodyTemplate.replaceAll('{filename}', stem),
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
    installBatchSelectorStyles();
    updateDescription();

    const openButton = qs('#btnBatchVideo');
    if (openButton && openButton.dataset.groupSelectorInstalled !== '1') {
      openButton.dataset.groupSelectorInstalled = '1';
      openButton.addEventListener('click', event => openDialog(event).catch(error => alert(String(error?.message || error))), true);
    }

    const selectAllButton = qs('#btnBatchSelectAll');
    if (selectAllButton && selectAllButton.dataset.groupSelectorInstalled !== '1') {
      selectAllButton.dataset.groupSelectorInstalled = '1';
      selectAllButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        qsa('#batchChannelList .batch-channel-checkbox').forEach(input => { input.checked = true; });
        for (const group of batchTargetGroups) syncInstanceCheckbox(Number(group.instance.id));
        updateSummary();
      }, true);
    }

    const createButton = qs('#btnCreateBatchTasks');
    if (createButton && createButton.dataset.groupSelectorInstalled !== '1') {
      createButton.dataset.groupSelectorInstalled = '1';
      createButton.addEventListener('click', event => createTasks(event).catch(error => alert(String(error?.message || error))), true);
    }
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
