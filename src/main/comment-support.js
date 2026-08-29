module.exports = function installCommentSupport(DB, BrowserManager) {
  const originalInit = DB.prototype.init;
  DB.prototype.init = function patchedInit() {
    originalInit.call(this);
    this.ensureColumn('tasks', 'comment', 'TEXT');
    this.ensureColumn('task_targets', 'post_published', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('task_targets', 'published_at', 'TEXT');
    this.ensureColumn('task_targets', 'post_url', 'TEXT');
    this.ensureColumn('task_targets', 'comment_status', "TEXT NOT NULL DEFAULT 'pending'");

    // 成功目标必然已经发帖。旧版的“帖子已发表，但评论发送失败”也要标记为
    // 已发帖，否则用户点击重试时会把同一个视频再次发布。
    this.db.prepare(`
      UPDATE task_targets
      SET post_published=1,
          published_at=COALESCE(published_at, CURRENT_TIMESTAMP),
          comment_status=CASE WHEN status='success' THEN 'success' ELSE 'failed' END
      WHERE status='success'
         OR (status='failed' AND last_error LIKE '帖子已发表，但评论发送失败：%')
    `).run();

    // 旧版把“评论”错误存进 body，导致它被写进帖子正文。
    // 只迁移尚未成功的任务，避免改动历史成功记录。
    this.db.prepare(`
      UPDATE tasks
      SET comment = CASE
            WHEN TRIM(COALESCE(comment,''))='' THEN COALESCE(body,'')
            ELSE comment
          END,
          body = CASE
            WHEN media_type='text' AND TRIM(COALESCE(title,'')) <> '' THEN title
            ELSE ''
          END
      WHERE status IN ('pending','failed') AND comment IS NULL
    `).run();

    const selectorInsert = this.db.prepare(`
      INSERT OR IGNORE INTO selector_configs(key,name,value,timeout)
      VALUES (?,?,?,?)
    `);
    selectorInsert.run(
      'comment_entry',
      '评论入口',
      '.bottom-input\n.feed-item:first-child .comment-container[dt-params*="sgrp_click_region=2"]\n.post-item:first-child .comment-container[dt-params*="sgrp_click_region=2"]\n.comment-container[dt-params*="sgrp_click_region=2"]',
      25000
    );
    selectorInsert.run(
      'comment_input',
      '评论输入框',
      '.comment-editor-container .ProseMirror[contenteditable="true"]\n.comment-editor-container [contenteditable="true"]',
      25000
    );
    selectorInsert.run(
      'comment_submit',
      '评论发送按钮',
      '.comment-editor-container button:has-text("发送")',
      15000
    );

    const oldCommentEntry = '.feed-item:first-child button:has-text("评论")\n.post-item:first-child button:has-text("评论")\nbutton:has-text("评论")\ntext=评论';
    const oldCommentInput = 'textarea[placeholder*="评论"]\ninput[placeholder*="评论"]\n[contenteditable="true"][data-placeholder*="评论"]\n[contenteditable="true"][aria-label*="评论"]';
    const oldCommentSubmit = 'button:has-text("发送")\nbutton:has-text("评论")';
    this.db.prepare(`UPDATE selector_configs SET value=?, timeout=25000 WHERE key='comment_entry' AND value=?`).run(
      '.bottom-input\n.feed-item:first-child .comment-container[dt-params*="sgrp_click_region=2"]\n.post-item:first-child .comment-container[dt-params*="sgrp_click_region=2"]\n.comment-container[dt-params*="sgrp_click_region=2"]',
      oldCommentEntry
    );
    this.db.prepare(`UPDATE selector_configs SET value=?, timeout=25000 WHERE key='comment_input' AND value=?`).run(
      '.comment-editor-container .ProseMirror[contenteditable="true"]\n.comment-editor-container [contenteditable="true"]',
      oldCommentInput
    );
    this.db.prepare(`UPDATE selector_configs SET value=? WHERE key='comment_submit' AND value=?`).run(
      '.comment-editor-container button:has-text("发送")',
      oldCommentSubmit
    );

    this.db.prepare(`UPDATE selector_configs SET name='帖子正文编辑器 ProseMirror' WHERE key='body_input'`).run();
  };

  DB.prototype.markTargetPostPublished = function markTargetPostPublished(id, postUrl = null) {
    this.db.prepare(`
      UPDATE task_targets
      SET post_published=1,
          published_at=COALESCE(published_at, CURRENT_TIMESTAMP),
          post_url=COALESCE(NULLIF(?, ''), post_url)
      WHERE id=?
    `).run(String(postUrl || ''), Number(id));
  };

  DB.prototype.setTargetPostUrl = function setTargetPostUrl(id, postUrl) {
    const normalized = String(postUrl || '').trim();
    if (!normalized) return;
    this.db.prepare('UPDATE task_targets SET post_url=? WHERE id=?').run(normalized, Number(id));
  };

  DB.prototype.setTargetCommentStatus = function setTargetCommentStatus(id, status) {
    this.db.prepare('UPDATE task_targets SET comment_status=? WHERE id=?').run(String(status || 'pending'), Number(id));
  };

  // 文本任务：任务标题就是发布内容。
  // 图片/视频任务：任务标题只做本地任务名，不写进帖子正文。
  // “评论”始终单独保存，帖子发布成功后再发送到评论区。
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
    const normalizedBody = type === 'text' ? normalizedTitle : '';

    if (type === 'text' && !normalizedBody) throw new Error('纯文本任务必须填写任务标题/发布内容');
    if (type === 'image' && !mediaPath) throw new Error('图片任务必须选择图片文件');
    if (type === 'video' && !mediaPath) throw new Error('视频任务必须选择视频文件');
    if (!Array.isArray(channelIds) || !channelIds.length) throw new Error('至少选择一个目标频道');
    this.getInstanceSummary(Number(instanceId));
    const ids = [...new Set(channelIds.map(Number).filter(Number.isInteger))];
    if (!ids.length) throw new Error('至少选择一个有效频道');
    const placeholders = ids.map(() => '?').join(',');
    const ownedCount = this.db.prepare(
      `SELECT COUNT(*) AS c FROM channels WHERE instance_id=? AND id IN (${placeholders})`
    ).get(Number(instanceId), ...ids).c;
    if (ownedCount !== ids.length) throw new Error('目标频道中包含不属于该账号实例的频道');

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
      for (const cid of ids) targetIns.run(r.lastInsertRowid, Number(cid));
      return r.lastInsertRowid;
    });
    return tx();
  };

  // 任务列表里的“评论”列继续使用 body 字段渲染，因此这里只在列表返回时映射为 comment。
  const originalListTasks = DB.prototype.listTasks;
  DB.prototype.listTasks = function listTasksWithComment(...args) {
    const result = originalListTasks.apply(this, args);
    result.items = (result.items || []).map(item => ({
      ...item,
      body: item.comment || ''
    }));
    return result;
  };

  BrowserManager.prototype.fillCommentControl = async function fillCommentControl(webContents, config, text) {
    const selectors = this.selectorCandidates(config).filter(selector => !selector.startsWith('text=') && !selector.includes(':has-text'));
    const source = `(() => {
      const selectors = ${JSON.stringify(selectors)};
      const visible = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      let el = null;
      for (const selector of selectors) {
        try {
          const matches = [...document.querySelectorAll(selector)];
          el = matches.find(visible) || el || matches[0] || null;
          if (el && visible(el)) break;
        } catch (_) {}
      }
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center' });
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      return { found: true };
    })()`;
    const focused = await webContents.executeJavaScript(source, true);
    if (!focused?.found) return focused;

    // 直接修改 textContent 只会改变画面，ProseMirror/Vue 的内部状态不会更新，
    // “发送”按钮仍然是 disabled。CDP Input.insertText 会产生真实的编辑输入，
    // 让编辑器事务和按钮状态同时更新。
    if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
    await webContents.debugger.sendCommand('Input.insertText', { text: String(text || '') });
    await new Promise(resolve => setTimeout(resolve, 200));

    return webContents.executeJavaScript(`(() => {
      const selectors = ${JSON.stringify(selectors)};
      const visible = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      for (const selector of selectors) {
        try {
          const el = [...document.querySelectorAll(selector)].find(visible);
          if (el) return { found: true, value: String(el.value || el.innerText || el.textContent || '') };
        } catch (_) {}
      }
      return { found: false };
    })()`, true);
  };

  BrowserManager.prototype.openCommentComposer = async function openCommentComposer(webContents, selectors) {
    const inputTimeout = Number(selectors.comment_input?.timeout || 25000);
    const entryTimeout = Number(selectors.comment_entry?.timeout || 25000);
    const deadline = Date.now() + Math.max(inputTimeout, entryTimeout);
    let feedEntryClicked = false;
    let detailEntryClicked = false;

    while (Date.now() < deadline) {
      const input = await this.elementAction(webContents, selectors.comment_input, 'inspect').catch(() => null);
      if (input?.found && input.visible) return input;

      // 帖子详情页底部先显示一条“发言要友善”的入口，点击后才创建
      // 没有 placeholder/aria-label 的 ProseMirror 评论编辑器。
      const detailEntry = await this.elementAction(webContents, ['.bottom-input'], 'inspect').catch(() => null);
      if (!detailEntryClicked && detailEntry?.found && detailEntry.visible) {
        await this.elementAction(webContents, ['.bottom-input'], 'click');
        detailEntryClicked = true;
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }

      // 频道首页先点最新帖子底部的评论区域，进入该帖详情页。
      const feedEntry = await this.elementAction(webContents, [
        '.feed-item:first-child .comment-container[dt-params*="sgrp_click_region=2"]',
        '.post-item:first-child .comment-container[dt-params*="sgrp_click_region=2"]',
        '.comment-container[dt-params*="sgrp_click_region=2"]'
      ], 'inspect').catch(() => null);
      if (!feedEntryClicked && feedEntry?.found && feedEntry.visible) {
        await this.elementAction(webContents, [feedEntry.selector], 'click');
        feedEntryClicked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`等待元素超时（${Math.max(inputTimeout, entryTimeout)}ms）：评论输入框`);
  };

  BrowserManager.prototype.postTaskComment = async function postTaskComment(webContents, selectors, comment) {
    const text = String(comment || '').trim();
    if (!text) return { skipped: true };

    await new Promise(resolve => setTimeout(resolve, 1200));

    try {
      await this.openCommentComposer(webContents, selectors);
    } catch (error) {
      error.postUrl = webContents.getURL();
      throw error;
    }

    const filled = await this.fillCommentControl(webContents, selectors.comment_input, text);
    if (!filled?.found) throw new Error('评论内容写入失败');

    const submit = await this.waitForElement(webContents, selectors.comment_submit, {
      visible: true,
      timeout: selectors.comment_submit?.timeout || 15000
    });
    if (submit.disabled) throw new Error('评论发送按钮不可用');
    await this.elementAction(webContents, selectors.comment_submit, 'click');
    await new Promise(resolve => setTimeout(resolve, 800));

    this.db.log('info', `评论发送完成：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`);
    return { skipped: false, postUrl: webContents.getURL() };
  };

  const originalPublishOneTarget = BrowserManager.prototype.publishOneTarget;
  BrowserManager.prototype.publishOneTarget = async function publishOneTargetWithComment(record, task, target, selectors, attempt) {
    const comment = String(task.comment || '').trim();
    const postAlreadyPublished = Number(target.post_published || 0) === 1;
    let result = true;

    if (!postAlreadyPublished) {
      result = await originalPublishOneTarget.call(this, record, task, target, selectors, attempt);
      this.db.markTargetPostPublished(target.id, result?.postUrl || '');
      if (result?.postUrl) {
        target.post_url = result.postUrl;
        await this.navigate(task.instance_id, result.postUrl);
      }
      target.post_published = 1;
    }

    if (!comment) {
      this.db.setTargetCommentStatus(target.id, 'skipped');
      this.db.setTargetStatus(target.id, 'success');
      return result;
    }

    try {
      if (postAlreadyPublished) {
        this.db.setTargetStatus(target.id, 'running');
        this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 帖子已发布，本次仅补发评论`);
        await this.navigate(task.instance_id, target.post_url || target.channel_url);
        const login = await this.getLoginStatus(task.instance_id, record);
        if (!login.loggedIn) throw new Error('QQ 登录状态已失效，请重新登录后继续');
      }

      const commentResult = await this.postTaskComment(record.view.webContents, selectors, comment);
      this.db.setTargetPostUrl(target.id, commentResult?.postUrl);
      target.post_url = commentResult?.postUrl || target.post_url;
      this.db.setTargetCommentStatus(target.id, 'success');
      this.db.setTargetStatus(target.id, 'success');
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 评论已发送`);
      return result;
    } catch (error) {
      const message = `帖子已发表，但评论发送失败：${String(error?.message || error)}`;
      const currentUrl = String(error?.postUrl || record.view.webContents.getURL() || '');
      if (currentUrl.includes('pd.qq.com/qqweb/qunpro/share')) {
        this.db.setTargetPostUrl(target.id, currentUrl);
        target.post_url = currentUrl;
      }
      this.db.setTargetCommentStatus(target.id, 'failed');
      const screenshot = await this.saveFailureScreenshot(record.view.webContents, task.id, target.id, attempt);
      const detail = screenshot ? `${message}\n截图：${screenshot}` : message;
      this.db.setTargetStatus(target.id, 'failed', detail);
      this.db.log('error', `任务 #${task.id} -> ${target.channel_name} ${message}${screenshot ? `；截图：${screenshot}` : ''}`);
      this.notifyPublishUpdate({
        type: 'target-finished',
        instanceId: task.instance_id,
        taskId: task.id,
        channelName: target.channel_name,
        status: 'failed'
      });
      const wrapped = new Error(message);
      // target.post_published 已经写入数据库；后续自动/手动重试只会补评论，
      // 所以评论阶段可以安全重试，绝不会重复发布图片或视频。
      wrapped.retryable = true;
      throw wrapped;
    }
  };
};
