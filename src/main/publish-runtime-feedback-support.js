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
    proto.qqcSetFile = async function qqcSetFileWithStage(webContents, mediaPath) {
      const ctx = context(this);
      const type = ctx?.task?.media_type === 'image' ? '图片' : '视频';
      emit(this, `选择${type}`, '正在把本地素材交给 QQ 上传控件');
      const result = await previousSetFile.call(this, webContents, mediaPath);
      emit(this, `等待${type}上传`, type === 'image' ? '通常几秒内完成，最长等待 45 秒' : '等待 QQ 完成视频上传');
      return result;
    };
  }

  // QQ 页面自己会在素材未上传完成时禁用“发表”按钮，因此“发表按钮可用 + 上传遮罩消失”
  // 是比某个固定预览 class 更可靠的完成信号。旧逻辑强制要求命中 preview class，QQ DOM
  // 一变化就会白等完整个 upload_timeout_ms（默认 120 秒）。
  proto.qqcWaitReady = async function qqcWaitReadyRobust(webContents, hasMedia) {
    const ctx = context(this);
    const mediaType = String(ctx?.task?.media_type || '');
    const configured = Math.max(15000, Number(this.db.getSetting('upload_timeout_ms', '120000')) || 120000);
    const timeout = hasMedia && mediaType === 'image' ? Math.min(configured, 45000) : configured;
    const startedAt = Date.now();
    let consecutiveReady = 0;
    let lastState = null;

    while (Date.now() - startedAt < timeout) {
      const state = await webContents.executeJavaScript(`(() => {
        const visible = el => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
        };
        const box = document.querySelector('.publish-editor-container');
        const button = box?.querySelector('.publish-button button');
        const masks = [...(box?.querySelectorAll('.image-mask,[class*="upload"][class*="mask"],[class*="uploading"]') || [])];
        const visibleMask = masks.some(visible);
        const input = box?.querySelector('input[type=file]');
        const fileCount = Number(input?.files?.length || 0);
        const previewCount = box ? box.querySelectorAll([
          '.image-draggable-preview',
          '.preview-list img',
          '.preview-list video',
          '.image-video-preview',
          'img[src^="blob:"]',
          'video[src^="blob:"]',
          '[class*="preview"] img',
          '[class*="preview"] video'
        ].join(',')).length : 0;
        const enabled = !!(button && visible(button) && !button.disabled && !button.classList.contains('disabled') && button.getAttribute('aria-disabled') !== 'true');
        return { enabled, visibleMask, fileCount, previewCount, hasButton: !!button };
      })()`, true).catch(() => null);

      lastState = state;
      const ready = !!state?.enabled && !state?.visibleMask;
      if (ready) consecutiveReady += 1;
      else consecutiveReady = 0;

      // 连续两次检测都可发表，避免页面状态切换瞬间误点。
      if (consecutiveReady >= 2) {
        const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        emit(this, '素材已就绪', hasMedia ? `QQ 发表按钮已可用，用时 ${elapsed} 秒` : '发表按钮已可用');
        return true;
      }
      await sleep(250);
    }

    const summary = lastState
      ? `button=${lastState.hasButton ? '有' : '无'}, enabled=${lastState.enabled ? '是' : '否'}, mask=${lastState.visibleMask ? '有' : '无'}, files=${lastState.fileCount || 0}, previews=${lastState.previewCount || 0}`
      : '未读取到页面状态';
    throw new Error(`油猴DOM：等待${hasMedia ? '媒体上传和' : ''}发表按钮可用超时（${Math.round(timeout / 1000)}秒；${summary}）`);
  };

  if (typeof previousPublish === 'function') {
    proto.qqcPublish = async function qqcPublishWithStage(webContents, before) {
      emit(this, '正在发表', '已准备点击发表，并等待新帖子出现');
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