(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  let folderPath = '';
  let folderVideos = [];

  function fileName(value = '') {
    return String(value || '').split(/[\\/]/).pop() || '';
  }

  function fileStem(value = '') {
    const name = fileName(value);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }

  function replaceFilename(template, stem) {
    return String(template || '').replaceAll('{filename}', String(stem || ''));
  }

  function notify(message, type = 'info') {
    if (typeof window.qqToast === 'function') window.qqToast(message, { type });
    else console[type === 'error' ? 'error' : 'log'](message);
  }

  function installStyles() {
    if ($('#taskVideoFolderIntegrationStyle')) return;
    const style = document.createElement('style');
    style.id = 'taskVideoFolderIntegrationStyle';
    style.textContent = `
      #taskVideoSourceRow{margin:0 0 10px}
      #taskVideoSourceRow select{width:100%}
      #taskVideoFolderRow{margin-bottom:10px}
      #taskVideoFolderPreview{margin-top:7px;max-height:86px;overflow:auto;padding:7px 9px;border:1px solid #e6edf5;border-radius:8px;background:#fafcff;color:#65758b;font-size:12px;line-height:1.55}
      #taskVideoFolderPreview:empty{display:none}
      #taskDialog .batch-placeholder-hint{margin-top:5px;color:#7b8ba0;font-size:12px;line-height:1.5}
    `;
    document.head.appendChild(style);
  }

  function ensureControls() {
    const mediaRow = $('#taskMediaRow');
    const mediaLabel = $('#taskMediaLabel');
    const singleFileRow = mediaLabel?.nextElementSibling;
    if (!mediaRow || !mediaLabel || !singleFileRow) return false;

    if (!$('#taskVideoSourceRow')) {
      const sourceRow = document.createElement('div');
      sourceRow.id = 'taskVideoSourceRow';
      sourceRow.className = 'hidden';
      sourceRow.innerHTML = `
        <label for="taskVideoSourceMode">视频选择方式</label>
        <select id="taskVideoSourceMode">
          <option value="single">单个视频</option>
          <option value="folder">视频目录批量</option>
        </select>
      `;
      mediaRow.insertBefore(sourceRow, mediaLabel);
      $('#taskVideoSourceMode')?.addEventListener('change', syncMediaUi);
    }

    if (!$('#taskVideoFolderRow')) {
      const folderRow = document.createElement('div');
      folderRow.id = 'taskVideoFolderRow';
      folderRow.className = 'hidden';
      folderRow.innerHTML = `
        <label>视频目录</label>
        <div class="file-row">
          <input id="taskVideoFolderPath" readonly placeholder="请选择包含视频的目录">
          <button type="button" id="btnTaskPickVideoFolder">浏览...</button>
        </div>
        <div id="taskVideoFolderSummary" class="field-hint">选择目录后会自动识别其中的视频文件</div>
        <div id="taskVideoFolderPreview"></div>
      `;
      singleFileRow.insertAdjacentElement('afterend', folderRow);
      $('#btnTaskPickVideoFolder')?.addEventListener('click', pickFolder);
    }

    const content = $('#taskContent');
    const comment = $('#taskBodyText');
    if (content && !content.parentElement?.querySelector('.batch-placeholder-hint[data-for="content"]')) {
      const hint = document.createElement('div');
      hint.className = 'batch-placeholder-hint';
      hint.dataset.for = 'content';
      hint.textContent = '视频目录批量模式支持 {filename}，会自动替换为每个视频的不含扩展名文件名。';
      content.insertAdjacentElement('afterend', hint);
    }
    if (comment && !comment.parentElement?.querySelector('.batch-placeholder-hint[data-for="comment"]')) {
      const hint = document.createElement('div');
      hint.className = 'batch-placeholder-hint';
      hint.dataset.for = 'comment';
      hint.textContent = '评论同样支持 {filename}。';
      comment.insertAdjacentElement('afterend', hint);
    }

    return true;
  }

  function resetFolder() {
    folderPath = '';
    folderVideos = [];
    const pathInput = $('#taskVideoFolderPath');
    const summary = $('#taskVideoFolderSummary');
    const preview = $('#taskVideoFolderPreview');
    if (pathInput) pathInput.value = '';
    if (summary) summary.textContent = '选择目录后会自动识别其中的视频文件';
    if (preview) preview.textContent = '';
  }

  async function pickFolder() {
    const result = await window.api.pickVideoFolder();
    if (!result) return;
    folderPath = String(result.folder || '');
    folderVideos = Array.isArray(result.files) ? result.files : [];

    const pathInput = $('#taskVideoFolderPath');
    const summary = $('#taskVideoFolderSummary');
    const preview = $('#taskVideoFolderPreview');
    if (pathInput) pathInput.value = folderPath;
    if (summary) summary.textContent = `识别到 ${folderVideos.length} 个视频文件`;
    if (preview) {
      const shown = folderVideos.slice(0, 8).map((file, index) => `${index + 1}. ${fileName(file)}`);
      if (folderVideos.length > 8) shown.push(`……另有 ${folderVideos.length - 8} 个视频`);
      preview.textContent = shown.join('\n');
    }
    if (!folderVideos.length) notify('这个目录中没有识别到支持的视频文件', 'warning');
  }

  function currentVideoMode() {
    return $('#taskMediaType')?.value === 'video'
      ? ($('#taskVideoSourceMode')?.value || 'single')
      : 'single';
  }

  function syncMediaUi() {
    ensureControls();
    const mediaType = $('#taskMediaType')?.value || 'text';
    const sourceRow = $('#taskVideoSourceRow');
    const folderRow = $('#taskVideoFolderRow');
    const mediaLabel = $('#taskMediaLabel');
    const singleFileRow = mediaLabel?.nextElementSibling;
    const folderMode = mediaType === 'video' && currentVideoMode() === 'folder';

    if (sourceRow) sourceRow.classList.toggle('hidden', mediaType !== 'video');
    if (folderRow) folderRow.classList.toggle('hidden', !folderMode);
    if (singleFileRow) singleFileRow.classList.toggle('hidden', folderMode);

    if (mediaLabel) {
      if (mediaType === 'image') mediaLabel.textContent = '图片文件';
      else if (mediaType === 'video') mediaLabel.textContent = '视频文件';
      else mediaLabel.textContent = '素材文件';
      mediaLabel.classList.toggle('hidden', folderMode);
    }
  }

  function selectedTargets() {
    const specific = $$('#taskChannelList .task-channel-checkbox:checked');
    const inputs = specific.length
      ? specific
      : $$('#taskChannelList input[type="checkbox"]:checked').filter(input => !input.classList.contains('task-instance-checkbox'));
    const fallbackInstanceId = Number($('#instanceSelect')?.value || 0);
    return inputs.map(input => ({
      channelId: Number(input.value),
      instanceId: Number(input.dataset.instanceId || fallbackInstanceId),
      channelName: input.closest('label')?.querySelector('span')?.textContent?.trim() || `频道 #${input.value}`
    })).filter(item => item.channelId > 0 && item.instanceId > 0);
  }

  function beijingLocalToISOString(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) throw new Error('开始时间格式无效');
    const [, y, m, d, hh, mm, ss = '00'] = match;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) - 8, Number(mm), Number(ss))).toISOString();
  }

  function deriveSingleTitle(title, content, mediaPath, mediaType) {
    const explicit = String(title || '').trim();
    if (explicit) return explicit;
    const normalizedContent = String(content || '').replace(/\s+/g, ' ').trim();
    if (normalizedContent) return normalizedContent.slice(0, 80);
    const stem = fileStem(mediaPath);
    return stem || (mediaType === 'image' ? '图片任务' : mediaType === 'video' ? '视频任务' : '文本任务');
  }

  function folderAssignments(targets) {
    return targets.map((target, index) => ({ target, video: folderVideos[index % folderVideos.length] }));
  }

  function folderPreview(assignments, unusedCount) {
    const shown = assignments.slice(0, 8).map((item, index) => `${index + 1}. ${item.target.channelName} ← ${fileName(item.video)}`);
    if (assignments.length > 8) shown.push(`……另有 ${assignments.length - 8} 个频道`);
    if (unusedCount > 0) shown.push(`另有 ${unusedCount} 个多余视频不会发布`);
    return shown.join('\n');
  }

  async function createTasksIntegrated() {
    const mediaType = $('#taskMediaType')?.value || 'text';
    const videoMode = currentVideoMode();
    const mediaPath = $('#mediaPath')?.value.trim() || '';
    const contentTemplate = $('#taskContent')?.value.trim() || '';
    const commentTemplate = $('#taskBodyText')?.value.trim() || '';
    const titleTemplate = $('#taskTitle')?.value.trim() || '';
    const targets = selectedTargets();
    const startValue = $('#taskStartTime')?.value || '';
    let intervalMinSeconds = Number($('#taskIntervalMin')?.value || 0);
    let intervalMaxSeconds = Number($('#taskIntervalMax')?.value || 0);

    if (mediaType === 'text' && !contentTemplate) return notify('纯文本任务必须填写“内容”', 'warning');
    if (mediaType === 'image' && !mediaPath) return notify('请选择图片', 'warning');
    if (mediaType === 'video' && videoMode === 'single' && !mediaPath) return notify('请选择视频', 'warning');
    if (mediaType === 'video' && videoMode === 'folder' && !folderVideos.length) return notify('请选择包含视频的目录', 'warning');
    if (!targets.length) return notify('至少选择一个频道', 'warning');
    if (!Number.isFinite(intervalMinSeconds) || !Number.isFinite(intervalMaxSeconds) || intervalMinSeconds < 0 || intervalMaxSeconds < 0) {
      return notify('随机间隔必须是大于或等于 0 的秒数', 'warning');
    }
    if (intervalMaxSeconds < intervalMinSeconds) [intervalMinSeconds, intervalMaxSeconds] = [intervalMaxSeconds, intervalMinSeconds];

    const scheduledAt = startValue ? beijingLocalToISOString(startValue) : null;
    const instanceCount = new Set(targets.map(item => item.instanceId)).size;
    const isFolder = mediaType === 'video' && videoMode === 'folder';

    let assignments = [];
    let unusedCount = 0;
    let confirmText = '';

    if (isFolder) {
      assignments = folderAssignments(targets);
      unusedCount = Math.max(0, folderVideos.length - targets.length);
      const repeatedCount = Math.max(0, targets.length - folderVideos.length);
      const distribution = repeatedCount > 0
        ? `视频少于频道，将循环分配 ${repeatedCount} 次。`
        : folderVideos.length === targets.length
          ? `${folderVideos.length} 个视频与 ${targets.length} 个频道一一对应。`
          : `使用前 ${targets.length} 个视频，剩余 ${unusedCount} 个视频不发布。`;
      confirmText = `已选择 ${instanceCount} 个实例中的 ${targets.length} 个频道。\n\n视频目录：${folderVideos.length} 个视频\n${distribution}\n正文内容：${contentTemplate ? '有' : '无'}\n自动评论：${commentTemplate ? '有' : '无'}\n\n分配预览：\n${folderPreview(assignments, unusedCount)}\n\n是否继续？`;
    } else {
      confirmText = `已选择 ${instanceCount} 个实例中的 ${targets.length} 个频道。\n\n正文内容：${contentTemplate ? '有' : '无'}\n自动评论：${commentTemplate ? '有' : '无'}\n\n每个频道会单独创建 1 条任务，共 ${targets.length} 条任务。是否继续？`;
    }

    if (!confirm(confirmText)) return;

    const button = $('#btnSaveTask');
    if (button) {
      button.disabled = true;
      button.textContent = '创建中...';
    }

    try {
      if (isFolder) {
        for (let i = 0; i < assignments.length; i++) {
          const { target, video } = assignments[i];
          const stem = fileStem(video);
          if (button) button.textContent = `创建中 ${i + 1}/${assignments.length}`;
          const title = titleTemplate ? replaceFilename(titleTemplate, stem) : stem;
          await window.api.createTask({
            instanceId: target.instanceId,
            title,
            body: { content: replaceFilename(contentTemplate, stem), comment: replaceFilename(commentTemplate, stem) },
            mediaPath: video,
            mediaType: 'video',
            channelIds: [target.channelId],
            scheduledAt,
            intervalMinSeconds,
            intervalMaxSeconds
          });
        }
      } else {
        const title = deriveSingleTitle(titleTemplate, contentTemplate, mediaPath, mediaType);
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i];
          if (button) button.textContent = `创建中 ${i + 1}/${targets.length}`;
          await window.api.createTask({
            instanceId: target.instanceId,
            title,
            body: { content: contentTemplate, comment: commentTemplate },
            mediaPath,
            mediaType,
            channelIds: [target.channelId],
            scheduledAt,
            intervalMinSeconds,
            intervalMaxSeconds
          });
        }
      }

      $('#taskDialog')?.close();
      if ($('#mediaPath')) $('#mediaPath').value = '';
      if ($('#taskTitle')) $('#taskTitle').value = '';
      if ($('#taskContent')) $('#taskContent').value = '';
      if ($('#taskBodyText')) $('#taskBodyText').value = '';
      resetFolder();
      if ($('#taskVideoSourceMode')) $('#taskVideoSourceMode').value = 'single';
      syncMediaUi();
      $('#btnRefreshTasks')?.click();
      if (typeof refreshSchedulerState === 'function') await refreshSchedulerState().catch(() => {});

      const extra = isFolder && unusedCount > 0 ? `，${unusedCount} 个多余视频未创建任务` : '';
      notify(`创建完成：${targets.length} 条任务已保存${extra}`, 'success');
    } catch (error) {
      notify(`创建任务失败：${String(error?.message || error)}`, 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '创建任务';
      }
    }
  }

  function replaceSaveButton() {
    const oldButton = $('#btnSaveTask');
    if (!oldButton || oldButton.dataset.folderIntegrated === '1') return;
    const newButton = oldButton.cloneNode(true);
    newButton.dataset.folderIntegrated = '1';
    oldButton.replaceWith(newButton);
    newButton.addEventListener('click', () => createTasksIntegrated().catch(error => notify(String(error?.message || error), 'error')));
  }

  function updateDialogCopy() {
    const subtitle = $('#taskDialog .modal-head p');
    if (subtitle) subtitle.textContent = '支持纯文本、图片、单个视频，以及视频目录批量创建任务';
  }

  function resetOnOpen() {
    resetFolder();
    if ($('#taskVideoSourceMode')) $('#taskVideoSourceMode').value = 'single';
    setTimeout(syncMediaUi, 0);
  }

  function install() {
    installStyles();
    ensureControls();
    updateDialogCopy();
    replaceSaveButton();
    syncMediaUi();

    $('#taskMediaType')?.addEventListener('change', () => setTimeout(syncMediaUi, 0));
    $('#btnCreateTask')?.addEventListener('click', resetOnOpen);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
