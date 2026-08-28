(() => {
  function fileName(path = '') {
    return String(path).split(/[\\/]/).pop();
  }

  function fileStem(path = '') {
    const name = fileName(path);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }

  function selectedChannels() {
    return [...document.querySelectorAll('#batchChannelList input[type="checkbox"]:checked')].map(input => {
      const label = input.closest('label');
      return {
        id: Number(input.value),
        name: String(label?.querySelector('span')?.textContent || `频道 #${input.value}`).trim()
      };
    }).filter(item => Number.isInteger(item.id) && item.id > 0);
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
      `${index + 1}. ${item.channel.name} ← ${fileName(item.video)}`
    ).join('\n');
    const more = assignments.length > 8 ? `\n……另有 ${assignments.length - 8} 个频道` : '';
    const unused = unusedCount > 0 ? `\n\n有 ${unusedCount} 个多余视频不会发布。` : '';
    return `${shown}${more}${unused}`;
  }

  function updateDescription() {
    const dialog = document.querySelector('#batchVideoDialog');
    if (!dialog) return;
    const subtitle = dialog.querySelector('.modal-head p');
    if (subtitle) subtitle.textContent = '每个频道只发布一次；视频少时循环平均分配，视频多时多余视频不发布。';
  }

  function install() {
    updateDescription();

    const button = document.querySelector('#btnCreateBatchTasks');
    if (!button || button.dataset.distributionInstalled === '1') return;
    button.dataset.distributionInstalled = '1';

    // 使用 capture + stopImmediatePropagation 覆盖旧版“每个视频发到全部频道”的处理。
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();

      const videos = Array.isArray(batchVideoFiles) ? batchVideoFiles : [];
      const channels = selectedChannels();
      const bodyTemplate = String(document.querySelector('#batchBody')?.value || '');

      if (!videos.length) return alert('请先选择包含视频的目录');
      if (!channels.length) return alert('至少选择一个频道');

      const assignments = buildAssignments(videos, channels);
      const unusedCount = Math.max(0, videos.length - channels.length);
      const repeatedCount = Math.max(0, channels.length - videos.length);
      const distributionText = repeatedCount > 0
        ? `视频少于频道，将循环使用 ${repeatedCount} 次，使 ${channels.length} 个频道各发布 1 次。`
        : videos.length === channels.length
          ? `${videos.length} 个视频与 ${channels.length} 个频道一一对应。`
          : `只使用前 ${channels.length} 个视频，剩余 ${unusedCount} 个视频不发布。`;

      const preview = assignmentPreview(assignments, unusedCount);
      if (!confirm(`本次将创建 ${channels.length} 条任务，每个频道只发布 1 次。\n\n${distributionText}\n\n分配预览：\n${preview}\n\n是否继续？`)) return;

      button.disabled = true;
      try {
        for (const { channel, video } of assignments) {
          const stem = fileStem(video);
          const body = bodyTemplate.replaceAll('{filename}', stem);
          await window.api.createTask({
            instanceId: currentInstanceId,
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

        document.querySelector('#batchVideoDialog')?.close();
        document.querySelector('#btnRefreshTasks')?.click();
        await refreshSchedulerState();

        const extra = unusedCount > 0 ? `；${unusedCount} 个多余视频未创建任务` : '';
        alert(`已创建 ${assignments.length} 条任务，每个频道 1 条${extra}`);
      } catch (error) {
        alert(`批量创建失败：${String(error?.message || error)}`);
      } finally {
        button.disabled = false;
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
