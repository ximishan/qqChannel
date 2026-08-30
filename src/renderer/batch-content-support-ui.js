(() => {
  const qs = selector => document.querySelector(selector);
  const qsa = selector => [...document.querySelectorAll(selector)];

  function fileName(path = '') {
    return String(path).split(/[\\/]/).pop();
  }

  function fileStem(path = '') {
    const name = fileName(path);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }

  function notify(message, type = '') {
    if (typeof window.qqToast === 'function') {
      window.qqToast(message, type ? { type } : undefined);
      return;
    }
    window.alert(message);
  }

  function installContentField() {
    const dialog = qs('#batchVideoDialog');
    const comment = qs('#batchBody');
    if (!dialog || !comment || qs('#batchContent')) return;

    const parent = comment.parentElement;
    if (!parent) return;

    const commentLabel = [...parent.querySelectorAll('label')].find(label =>
      label.getAttribute('for') === 'batchBody' || label.nextElementSibling === comment
    );
    if (commentLabel) {
      commentLabel.textContent = '统一评论（可选）';
      commentLabel.setAttribute('for', 'batchBody');
    }

    const label = document.createElement('label');
    label.setAttribute('for', 'batchContent');
    label.textContent = '统一内容（可选）';

    const textarea = document.createElement('textarea');
    textarea.id = 'batchContent';
    textarea.rows = 4;
    textarea.placeholder = '发布到频道的正文内容；可使用 {filename} 代表不含扩展名的视频文件名';

    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '内容会写入帖子正文；每个视频可用 {filename} 自动替换自己的文件名。';

    const anchor = commentLabel || comment;
    parent.insertBefore(label, anchor);
    parent.insertBefore(textarea, anchor);
    parent.insertBefore(hint, anchor);
  }

  function selectedChannels() {
    return qsa('#batchChannelList .batch-channel-checkbox:checked').map(input => {
      const row = input.closest('.batch-channel-row');
      const group = input.closest('.batch-instance-group');
      return {
        id: Number(input.value),
        name: String(row?.querySelector('span')?.textContent || `频道 #${input.value}`).trim(),
        instanceId: Number(input.dataset.instanceId || group?.dataset.instanceId || 0),
        instanceName: String(group?.querySelector('.batch-instance-expand-area strong')?.textContent || '').trim()
      };
    }).filter(item => item.id > 0 && item.instanceId > 0);
  }

  function getBatchVideos() {
    try {
      return Array.isArray(batchVideoFiles) ? [...batchVideoFiles] : [];
    } catch (_) {
      return [];
    }
  }

  function getRuntimeSettings() {
    try {
      return runtimeSettings && typeof runtimeSettings === 'object' ? runtimeSettings : {};
    } catch (_) {
      return {};
    }
  }

  function buildAssignments(videos, channels) {
    if (!videos.length || !channels.length) return [];
    return channels.map((channel, index) => ({
      channel,
      video: videos[index % videos.length]
    }));
  }

  function assignmentPreview(assignments, unusedCount) {
    const shown = assignments.slice(0, 8).map((item, index) =>
      `${index + 1}. ${item.channel.instanceName || `实例 #${item.channel.instanceId}`} / ${item.channel.name} ← ${fileName(item.video)}`
    ).join('\n');
    const more = assignments.length > 8 ? `\n……另有 ${assignments.length - 8} 个频道` : '';
    const unused = unusedCount > 0 ? `\n\n有 ${unusedCount} 个多余视频不会发布。` : '';
    return `${shown}${more}${unused}`;
  }

  async function createBatchTasks(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const button = event.currentTarget;
    const videos = getBatchVideos();
    const channels = selectedChannels();
    const contentTemplate = String(qs('#batchContent')?.value || '');
    const commentTemplate = String(qs('#batchBody')?.value || '');

    if (!videos.length) {
      notify('请先选择包含视频的目录', 'error');
      return;
    }
    if (!channels.length) {
      notify('至少选择一个频道', 'error');
      return;
    }

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

    if (!window.confirm(
      `已选择 ${groupCount} 个实例中的 ${channels.length} 个频道。\n\n` +
      `本次将创建 ${channels.length} 条任务，每个频道只发布 1 次。\n\n` +
      `${distributionText}\n\n分配预览：\n${preview}\n\n是否继续？`
    )) return;

    button.disabled = true;
    button.textContent = '创建中...';

    try {
      const settings = getRuntimeSettings();
      let created = 0;

      for (const { channel, video } of assignments) {
        created += 1;
        button.textContent = `创建中 ${created}/${assignments.length}`;
        const stem = fileStem(video);

        await window.api.createTask({
          instanceId: channel.instanceId,
          title: stem,
          body: {
            content: contentTemplate.replaceAll('{filename}', stem),
            comment: commentTemplate.replaceAll('{filename}', stem)
          },
          mediaPath: video,
          mediaType: 'video',
          channelIds: [channel.id],
          scheduledAt: null,
          intervalMinSeconds: Number(settings.interval_min_seconds ?? 180),
          intervalMaxSeconds: Number(settings.interval_max_seconds ?? 480)
        });
      }

      qs('#batchVideoDialog')?.close();
      qs('#btnRefreshTasks')?.click();
      try {
        if (typeof refreshSchedulerState === 'function') await refreshSchedulerState();
      } catch (_) {}

      const extra = unusedCount > 0 ? `；${unusedCount} 个多余视频未创建任务` : '';
      notify(`已创建 ${assignments.length} 条批量视频任务${extra}`, 'success');
    } catch (error) {
      notify(`批量任务创建失败：${String(error?.message || error)}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '批量创建任务';
    }
  }

  function replaceCreateButton() {
    const oldButton = qs('#btnCreateBatchTasks');
    if (!oldButton || oldButton.dataset.batchContentSupport === '1') return;

    // 原批量脚本使用 capture + stopImmediatePropagation，直接 clone 按钮移除旧监听器，
    // 再绑定支持“内容 + 评论”的新版创建逻辑，避免同一次点击创建两批任务。
    const button = oldButton.cloneNode(true);
    button.dataset.batchContentSupport = '1';
    oldButton.replaceWith(button);
    button.addEventListener('click', event => {
      createBatchTasks(event).catch(error => notify(String(error?.message || error), 'error'));
    }, true);
  }

  function installOpenReset() {
    document.addEventListener('click', event => {
      if (!event.target.closest?.('#btnBatchVideo')) return;
      installContentField();
      const content = qs('#batchContent');
      if (content) content.value = '';
    }, true);
  }

  function install() {
    installContentField();
    replaceCreateButton();
    installOpenReset();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
