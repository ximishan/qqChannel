module.exports = function installPublishingDataSupport(DB) {
  const originalInit = DB.prototype.init;

  DB.prototype.init = function initPublishingData() {
    originalInit.call(this);

    this.ensureColumn('tasks', 'comment', 'TEXT');
    this.ensureColumn('task_targets', 'post_published', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('task_targets', 'published_at', 'TEXT');
    this.ensureColumn('task_targets', 'post_url', 'TEXT');
    this.ensureColumn('task_targets', 'comment_status', "TEXT NOT NULL DEFAULT 'pending'");

    // 兼容历史数据：成功目标必然已经发帖；旧版“帖子已发表但评论失败”的目标
    // 也必须保留已发布标记，避免用户重试评论时重复发帖。
    this.db.prepare(`
      UPDATE task_targets
      SET post_published=1,
          published_at=COALESCE(published_at, CURRENT_TIMESTAMP),
          comment_status=CASE WHEN status='success' THEN 'success' ELSE 'failed' END
      WHERE status='success'
         OR (status='failed' AND last_error LIKE '帖子已发表，但评论发送失败：%')
    `).run();

    // 仅迁移旧版本尚未完成、且 comment 为空的任务。旧版本曾把评论放在 body。
    this.db.prepare(`
      UPDATE tasks
      SET comment=COALESCE(body, ''),
          body=CASE
            WHEN media_type='text' AND TRIM(COALESCE(title,''))<>'' THEN title
            ELSE ''
          END
      WHERE status IN ('pending','failed') AND comment IS NULL
    `).run();
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
    this.db.prepare('UPDATE task_targets SET comment_status=? WHERE id=?')
      .run(String(status || 'pending'), Number(id));
  };

  DB.prototype.createTask = function createPublishingTask(
    instanceId,
    title,
    payload,
    mediaPath,
    channelIds,
    mediaType = 'video',
    scheduledAt = null,
    intervalMinSeconds = null,
    intervalMaxSeconds = null
  ) {
    const type = ['text', 'image', 'video'].includes(mediaType) ? mediaType : 'video';
    const normalizedInstanceId = Number(instanceId);

    let content = '';
    let comment = '';
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      content = String(payload.content || '').trim();
      comment = String(payload.comment || '').trim();
    } else {
      // 兼容旧 UI：字符串 payload 代表评论；纯文本任务则使用标题作为正文。
      comment = String(payload || '').trim();
    }

    let normalizedTitle = String(title || '').trim();
    if (!content && type === 'text') content = normalizedTitle;
    if (!normalizedTitle && content) normalizedTitle = content.replace(/\s+/g, ' ').slice(0, 80);
    if (!normalizedTitle && mediaPath) {
      const fileName = String(mediaPath).split(/[\\/]/).pop() || '';
      normalizedTitle = fileName.replace(/\.[^.]+$/, '') || (type === 'image' ? '图片任务' : '视频任务');
    }

    if (type === 'text' && !content) throw new Error('纯文本任务必须填写“内容”');
    if (type === 'image' && !mediaPath) throw new Error('图片任务必须选择图片文件');
    if (type === 'video' && !mediaPath) throw new Error('视频任务必须选择视频文件');
    if (!Array.isArray(channelIds) || !channelIds.length) throw new Error('至少选择一个目标频道');

    this.getInstanceSummary(normalizedInstanceId);
    const ids = [...new Set(channelIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (!ids.length) throw new Error('至少选择一个有效频道');
    const placeholders = ids.map(() => '?').join(',');
    const ownedCount = this.db.prepare(
      `SELECT COUNT(*) AS c FROM channels WHERE instance_id=? AND id IN (${placeholders})`
    ).get(normalizedInstanceId, ...ids).c;
    if (ownedCount !== ids.length) throw new Error('目标频道中包含不属于该账号实例的频道');

    const normalizedScheduledAt = scheduledAt ? new Date(scheduledAt).toISOString() : null;
    let minSeconds = intervalMinSeconds === '' || intervalMinSeconds == null
      ? null : Math.max(0, Math.floor(Number(intervalMinSeconds) || 0));
    let maxSeconds = intervalMaxSeconds === '' || intervalMaxSeconds == null
      ? null : Math.max(0, Math.floor(Number(intervalMaxSeconds) || 0));
    if (minSeconds != null && maxSeconds == null) maxSeconds = minSeconds;
    if (maxSeconds != null && minSeconds == null) minSeconds = maxSeconds;
    if (minSeconds != null && maxSeconds < minSeconds) [minSeconds, maxSeconds] = [maxSeconds, minSeconds];

    const tx = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO tasks(
          instance_id,title,body,comment,media_path,media_type,status,
          scheduled_at,interval_min_seconds,interval_max_seconds
        ) VALUES (?,?,?,?,?,?, 'pending',?,?,?)
      `).run(
        normalizedInstanceId,
        normalizedTitle,
        content,
        comment,
        type === 'text' ? '' : String(mediaPath || ''),
        type,
        normalizedScheduledAt,
        minSeconds,
        maxSeconds
      );

      const insertTarget = this.db.prepare(
        `INSERT INTO task_targets(task_id,channel_id,status) VALUES (?,?, 'pending')`
      );
      for (const channelId of ids) insertTarget.run(result.lastInsertRowid, channelId);
      return Number(result.lastInsertRowid);
    });

    return tx();
  };

  // 现有任务表第 6 列仍显示“评论”。保留真正正文到 content，body 映射为评论
  // 仅用于列表展示；发布执行使用 getTask()，读取数据库原始 body/comment。
  const originalListTasks = DB.prototype.listTasks;
  DB.prototype.listTasks = function listPublishingTasks(...args) {
    const result = originalListTasks.apply(this, args);
    result.items = (result.items || []).map(item => ({
      ...item,
      content: item.body || '',
      body: item.comment || ''
    }));
    return result;
  };
};
