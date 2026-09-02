module.exports = function installPublishRuntimeFeedbackSupport(BrowserManager) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const proto = BrowserManager.prototype;

  const previousPublishOneTarget = proto.publishOneTarget;
  const previousOpenEditor = proto.qqcOpenEditor;
  const previousSetFile = proto.qqcSetFile;
  const previousPublish = proto.qqcPublish;
  const previousComment = proto.qqcComment;

  function context(manager) {
    return manager.__qqchannelPublishStageContext || null;
  }

  function emit(manager, stage, detail = '') {
    const ctx = context(manager);
    if (!ctx) return;
    const payload = {
      type: 'target-stage',
      instanceId: Number(ctx.task?.instance_id || 0),
      taskId: Number(ctx.task?.id || 0),
      channelName: String(ctx.target?.channel_name || ''),
      attempt: Number(ctx.attempt || 1),
      stage: String(stage || ''),
      detail: String(detail || '')
    };
    manager.notifyPublishUpdate?.(payload);
    manager.db?.log?.(
      'info',
      `任务 #${payload.taskId} -> ${payload.channelName} [${payload.stage}]${payload.detail ? ` ${payload.detail}` : ''}`
    );
  }

  async function waitForPage(webContents, source, timeout, interval = 120) {
    const end = Date.now() + timeout;
    let last = null;
    while (Date.now() < end) {
      last = await webContents.executeJavaScript(source, true).catch(() => null);
      if (last) return last;
      await sleep(interval);
    }
    return null;
  }

  proto.publishOneTarget = async function publishOneTargetWithStageContext(record, task, target, selectors, attempt) {
    const old = this.__qqchannelPublishStageContext;
    this.__qqchannelPublishStageContext = { task, target, attempt };
    emit(this, '准备发布', `第 ${Number(attempt) || 1} 次尝试`);
    try {
      return await previousPublishOneTarget.call(this, record, task, target, selectors, attempt);
    } finally {
      this.__qqchannelPublishStageContext = old || null;
    }
  };

  if (typeof previousOpenEditor === 'function') {
    proto.qqcOpenEditor = async function qqcOpenEditorWithStage(webContents) {
      emit(this, '打开发布框', '正在寻找并展开正文编辑器');
      const result = await previousOpenEditor.call(this, webContents);
      emit(this, '发布框已打开');
      return result;
    };
  }

  if (typeof previousSetFile === 'function') {
    proto.qqcSetFile = async function qqcSetFileWithUserscriptEvents(webContents, mediaPath) {
      const ctx = context(this);
      const type = ctx?.task?.media_type === 'image' ? '图片' : '视频';
      emit(this, `选择${type}`, '正在把本地素材交给 QQ 上传控件');

      // 油猴脚本的关键不是“input.files 最终必须还能读到”，而是 QQ 前端收到
      // 文件选择事件后开始生成预览/上传。React 处理 change 后可能立即重建 input，
      // 此时重新 querySelector 得到的新 input.files 为 0 是正常现象，不能据此判失败。
      await webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.publish-editor-container input[type=file]');
        window.__QQC_FILE_EVENT_STATE__ = { input: 0, change: 0 };
        if (!input) return false;
        input.addEventListener('input', () => { window.__QQC_FILE_EVENT_STATE__.input += 1; });
        input.addEventListener('change', () => { window.__QQC_FILE_EVENT_STATE__.change += 1; });
        return true;
      })()`, true).catch(() => false);

      // Electron 通过 CDP 选择真实本地文件。Chromium 通常会自行触发 input/change。
      await previousSetFile.call(this, webContents, mediaPath);
      await sleep(80);

      let eventState = await webContents.executeJavaScript(`(() => ({
        input: Number(window.__QQC_FILE_EVENT_STATE__?.input || 0),
        change: Number(window.__QQC_FILE_EVENT_STATE__?.change || 0)
      }))()`, true).catch(() => ({ input: 0, change: 0 }));

      // 只有 CDP 没有产生任何文件选择事件时，才补发油猴脚本同款 change。
      // 不检查 input.files，因为 QQ 可能已消费文件并替换了 input 节点。
      if (!eventState.input && !eventState.change) {
        const fallback = await webContents.executeJavaScript(`(() => {
          const input = document.querySelector('.publish-editor-container input[type=file]');
          if (!input) return false;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`, true).catch(() => false);
        if (!fallback) throw new Error('油猴DOM：设置文件后找不到发布媒体 input[type=file]');
        eventState = { input: 1, change: 1, fallback: true };
      }

      emit(
        this,
        `等待${type}上传`,
        eventState.fallback
          ? 'CDP 未观察到事件，已补发油猴脚本同款 input/change，开始等待媒体预览'
          : `QQ 已收到文件选择事件（input=${eventState.input}, change=${eventState.change}），开始等待媒体预览`
      );
      return eventState;
    };
  }

  // 严格按用户原始油猴脚本 attachFiles() + post() 的顺序执行：
  // 1. 等 pubPreview 出现；2. 等 image-mask 消失（超时可忽略）；
  // 3. 单独最多 15 秒等待“发表”按钮可用。
  proto.qqcWaitReady = async function qqcWaitReadyUserscriptExact(webContents, hasMedia) {
    const ctx = context(this);
    const mediaType = String(ctx?.task?.media_type || '');

    if (hasMedia) {
      const uploadTimeout = Math.max(15000, Number(this.db.getSetting('upload_timeout_ms', '180000')) || 180000);
      const previewSelector = '.publish-editor-container .image-draggable-preview, .publish-editor-container .preview-list img, .publish-editor-container .preview-list video';

      // 当前工具每个任务只注入一个素材，所以按原脚本至少等待 1 个 pubPreview。
      // 不再用 input.files.length 计算 need，因为 QQ/React 可能已消费并重建 input。
      const preview = await waitForPage(
        webContents,
        `(() => {
          const count = document.querySelectorAll(${JSON.stringify(previewSelector)}).length;
          return count >= 1 ? { count } : null;
        })()`,
        uploadTimeout,
        120
      );

      if (!preview) {
        throw new Error(`油猴DOM：等待媒体上传完成超时（${Math.round(uploadTimeout / 1000)}秒，未出现原脚本 pubPreview）`);
      }
      emit(this, '媒体预览已出现', `检测到 ${preview.count} 个预览`);

      // 与原脚本一致：等待 image-mask 消失，但这一段失败不阻止后续按钮判断。
      await waitForPage(
        webContents,
        `(() => {
          const m = document.querySelector('.publish-editor-container .image-mask');
          return (!m || m.offsetParent === null) ? true : null;
        })()`,
        uploadTimeout,
        120
      ).catch(() => null);
      emit(this, '媒体上传完成', mediaType === 'image' ? '图片处理完成' : '视频处理完成');
    }

    const enabled = await waitForPage(
      webContents,
      `(() => {
        const b = document.querySelector('.publish-editor-container .publish-button button');
        return b && !b.disabled && !/disabled/i.test(String(b.className || '')) ? true : null;
      })()`,
      15000,
      120
    );
    if (!enabled) throw new Error('油猴DOM：等待发布按钮可用超时（15秒）');

    emit(this, '发表按钮已可用', '准备提交发布');
    return true;
  };

  if (typeof previousPublish === 'function') {
    proto.qqcPublish = async function qqcPublishWithStage(webContents, before) {
      emit(this, '正在发表', '点击发表，并按油猴脚本最多等待 40 秒识别新帖');
      const result = await previousPublish.call(this, webContents, before);
      emit(this, '帖子已发布', result?.feedId ? `已识别新帖子 ${result.feedId}` : '已识别新帖子');
      return result;
    };
  }

  if (typeof previousComment === 'function') {
    proto.qqcComment = async function qqcCommentWithStage(webContents, postUrl, text) {
      emit(this, '正在评论', '打开评论输入框并发送评论');
      const result = await previousComment.call(this, webContents, postUrl, text);
      emit(this, '评论成功');
      return result;
    };
  }
};
