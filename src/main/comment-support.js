module.exports = function installCommentSupport(DB, BrowserManager) {
  const originalInit = DB.prototype.init;
  DB.prototype.init = function patchedInit() {
    originalInit.call(this);
    this.ensureColumn('tasks', 'comment', 'TEXT');

    // 旧版把“评论”错误存进 body，导致它被写进帖子正文。
    // 只迁移尚未成功的任务，避免改动历史成功记录的展示语义。
    this.db.prepare(`
      UPDATE tasks
      SET comment = COALESCE(comment, body),
          body = CASE WHEN TRIM(COALESCE(title,'')) <> '' THEN title ELSE '' END
      WHERE status IN ('pending','failed') AND comment IS NULL
    `).run();

    const selectorInsert = this.db.prepare(`
      INSERT OR IGNORE INTO selector_configs(key,name,value,timeout)
      VALUES (?,?,?,?)
    `);
    selectorInsert.run(
      'comment_entry',
      '评论入口',
      '.feed-item:first-child button:has-text("评论")\n.post-item:first-child button:has-text("评论")\nbutton:has-text("评论")\ntext=评论',
      15000
    );
    selectorInsert.run(
      'comment_input',
      '评论输入框',
      'textarea[placeholder*="评论"]\ninput[placeholder*="评论"]\n[contenteditable="true"][data-placeholder*="评论"]\n[contenteditable="true"][aria-label*="评论"]',
      15000
    );
    selectorInsert.run(
      'comment_submit',
      '评论发送按钮',
      'button:has-text("发送")\nbutton:has-text("评论")',
      15000
    );

    this.db.prepare(`UPDATE selector_configs SET name='帖子正文编辑器 ProseMirror' WHERE key='body_input'`).run();
  };

  // 新任务：任务标题作为帖子正文；“评论”单独保存，发布成功后再发送到评论区。
  DB.prototype.createTask = function createTaskWithComment(
    instanceId,
    title,
    comment,
    mediaPath,
    channelIds,
    mediaType = 'video',
    scheduledAt = null,
    intervalMinSeconds = null,
    intervalMaxSeconds = null
  ) {
    const type = ['text', 'image', 'video'].includes(mediaType) ? mediaType : 'video';
    const normalizedTitle = String(title || '').trim();
    const normalizedComment = String(comment || '').trim();
    const normalizedBody = normalizedTitle;

    if (type === 'text' && !normalizedBody) throw new Error('纯文本任务必须填写任务标题/发布内容');
    if (type === 'image' && !mediaPath) throw new Error('图片任务必须选择图片文件');
    if (type === 'video' && !mediaPath) throw new Error('视频任务必须选择视频文件');
    if (!Array.isArray(channelIds) || !channelIds.length) throw new Error('至少选择一个目标频道');

    const normalizedScheduledAt = scheduledAt ? new Date(scheduledAt).toISOString() : null;
    let minSeconds = intervalMinSeconds === '' || intervalMinSeconds == null ? null : Math.max(0, Math.floor(Number(intervalMinSeconds) || 0));
    let maxSeconds = intervalMaxSeconds === '' || intervalMaxSeconds == null ? null : Math.max(0, Math.floor(Number(intervalMaxSeconds) || 0));
    if (minSeconds != null && maxSeconds == null) maxSeconds = minSeconds;
    if (maxSeconds != null && minSeconds == null) minSeconds = maxSeconds;
    if (minSeconds != null && maxSeconds < minSeconds) [minSeconds, maxSeconds] = [maxSeconds, minSeconds];

    const tx = this.db.transaction(() => {
      const r = this.db.prepare(`
        INSERT INTO tasks(
          instance_id,title,body,comment,media_path,media_type,status,
          scheduled_at,interval_min_seconds,interval_max_seconds
        ) VALUES (?,?,?,?,?,?, 'pending',?,?,?)
      `).run(
        Number(instanceId),
        normalizedTitle,
        normalizedBody,
        normalizedComment,
        type === 'text' ? '' : mediaPath,
        type,
        normalizedScheduledAt,
        minSeconds,
        maxSeconds
      );
      const targetIns = this.db.prepare(`INSERT INTO task_targets(task_id,channel_id,status) VALUES (?,?, 'pending')`);
      for (const cid of channelIds) targetIns.run(r.lastInsertRowid, Number(cid));
      return r.lastInsertRowid;
    });
    return tx();
  };

  // 渲染任务列表时，“评论”列读取 comment；浏览器执行 getTask() 时仍能拿到真正的 body。
  const originalListTasks = DB.prototype.listTasks;
  DB.prototype.listTasks = function listTasksWithComment(...args) {
    const result = originalListTasks.apply(this, args);
    result.items = (result.items || []).map(item => ({
      ...item,
      body: item.comment || ''
    }));
    return result;
  };

  BrowserManager.prototype.postTaskComment = async function postTaskComment(webContents, selectors, comment) {
    const text = String(comment || '').trim();
    if (!text) return { skipped: true };

    // 等待刚发表的帖子回到频道流中。
    await new Promise(resolve => setTimeout(resolve, 1200));

    let input = await this.elementAction(webContents, selectors.comment_input, 'inspect').catch(() => null);
    if (!input?.found || !input.visible) {
      const entry = await this.waitForElement(webContents, selectors.comment_entry, {
        visible: true,
        timeout: selectors.comment_entry?.timeout || 15000
      });
      if (!entry?.found) throw new Error('找不到评论入口');
      await this.elementAction(webContents, selectors.comment_entry, 'click');
      input = await this.waitForElement(webContents, selectors.comment_input, {
        visible: true,
        timeout: selectors.comment_input?.timeout || 15000
      });
    }

    const filled = await this.elementAction(webContents, selectors.comment_input, 'fill', text);
    if (!filled?.found) throw new Error('评论内容写入失败');

    const submit = await this.waitForElement(webContents, selectors.comment_submit, {
      visible: true,
      timeout: selectors.comment_submit?.timeout || 15000
    });
    if (submit.disabled) throw new Error('评论发送按钮不可用');
    await this.elementAction(webContents, selectors.comment_submit, 'click');
    await new Promise(resolve => setTimeout(resolve, 800));

    this.db.log('info', `评论发送完成：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`);
    return { skipped: false };
  };

  const originalPublishOneTarget = BrowserManager.prototype.publishOneTarget;
  BrowserManager.prototype.publishOneTarget = async function publishOneTargetWithComment(record, task, target, selectors, attempt) {
    const result = await originalPublishOneTarget.call(this, record, task, target, selectors, attempt);
    const comment = String(task.comment || '').trim();
    if (!comment) return result;

    try {
      await this.postTaskComment(record.view.webContents, selectors, comment);
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 评论已发送`);
      return result;
    } catch (error) {
      const message = `帖子已发表，但评论发送失败：${String(error?.message || error)}`;
      this.db.setTargetStatus(target.id, 'failed', message);
      this.db.log('error', `任务 #${task.id} -> ${target.channel_name} ${message}`);
      this.notifyPublishUpdate({
        type: 'target-finished',
        instanceId: task.instance_id,
        taskId: task.id,
        channelName: target.channel_name,
        status: 'failed'
      });
      const wrapped = new Error(message);
      // 帖子已经成功发表，绝不能自动重试，否则会重复发帖。
      wrapped.retryable = false;
      throw wrapped;
    }
  };
};
