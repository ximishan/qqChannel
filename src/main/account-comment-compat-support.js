module.exports = function installAccountCommentCompatSupport(DB) {
  if (DB.prototype.__accountCommentCompatSupportInstalled) return;
  DB.prototype.__accountCommentCompatSupportInstalled = true;

  const originalInit = DB.prototype.init;
  const originalListTasks = DB.prototype.listTasks;

  // 修复旧版批量任务：account-workspace-support 曾把视频/图片评论写进 body，
  // comment 留空。启动时把尚未完成的旧任务迁回真正的 comment 字段。
  DB.prototype.init = function initAccountCommentCompatSupport() {
    originalInit.call(this);
    this.ensureColumn('tasks', 'comment', 'TEXT');

    this.db.prepare(`
      UPDATE tasks
      SET comment = body,
          body = ''
      WHERE status IN ('pending','failed')
        AND media_type IN ('video','image')
        AND TRIM(COALESCE(comment,'')) = ''
        AND TRIM(COALESCE(body,'')) <> ''
    `).run();
  };

  // account-workspace-support 会在 comment-support 之后再次覆盖 createTask。
  // 这里作为最后一层兼容补丁，同时保留 account_id 隔离和 comment 独立字段。
  DB.prototype.createTask = function createTaskForAccountWithComment(
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
    const accountId = this.getActiveAccountId();
    if (!accountId) throw new Error('请先登录 QQ');

    this.getInstanceSummary(instanceId);

    const ids = [...new Set((channelIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) throw new Error('至少选择一个频道');

    const placeholders = ids.map(() => '?').join(',');
    const ownedCount = this.db.prepare(
      `SELECT COUNT(*) AS c FROM channels WHERE account_id=? AND id IN (${placeholders})`
    ).get(accountId, ...ids).c;
    if (ownedCount !== ids.length) throw new Error('目标频道中包含不属于当前 QQ 的频道');

    const type = ['text', 'image', 'video'].includes(mediaType) ? mediaType : 'video';
    const normalizedTitle = String(title || '').trim();
    const normalizedComment = String(comment || '').trim();
    const normalizedBody = type === 'text' ? normalizedTitle : '';

    if (type === 'text' && !normalizedBody) throw new Error('纯文本任务必须填写任务标题/发布内容');
    if (type === 'image' && !mediaPath) throw new Error('图片任务必须选择图片文件');
    if (type === 'video' && !mediaPath) throw new Error('视频任务必须选择视频文件');

    const normalizedScheduledAt = scheduledAt ? new Date(scheduledAt).toISOString() : null;
    let minSeconds = intervalMinSeconds === '' || intervalMinSeconds == null
      ? null
      : Math.max(0, Math.floor(Number(intervalMinSeconds) || 0));
    let maxSeconds = intervalMaxSeconds === '' || intervalMaxSeconds == null
      ? null
      : Math.max(0, Math.floor(Number(intervalMaxSeconds) || 0));

    if (minSeconds != null && maxSeconds == null) maxSeconds = minSeconds;
    if (maxSeconds != null && minSeconds == null) minSeconds = maxSeconds;
    if (minSeconds != null && maxSeconds < minSeconds) [minSeconds, maxSeconds] = [maxSeconds, minSeconds];

    const tx = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO tasks(
          instance_id,account_id,title,body,comment,media_path,media_type,status,
          scheduled_at,interval_min_seconds,interval_max_seconds
        ) VALUES (?,?,?,?,?,?,?,'pending',?,?,?)
      `).run(
        Number(instanceId),
        accountId,
        normalizedTitle,
        normalizedBody,
        normalizedComment,
        type === 'text' ? '' : mediaPath,
        type,
        normalizedScheduledAt,
        minSeconds,
        maxSeconds
      );

      const targetInsert = this.db.prepare(
        "INSERT INTO task_targets(task_id,channel_id,status) VALUES (?,?,'pending')"
      );
      for (const channelId of ids) targetInsert.run(result.lastInsertRowid, channelId);
      return result.lastInsertRowid;
    });

    return tx();
  };

  // 前端任务列表历史上读取 body 作为“评论”列。
  // 这里作为最终兜底，优先把 comment 映射到 body，确保列表立即显示真实评论。
  DB.prototype.listTasks = function listTasksWithAccountCommentCompat(...args) {
    const result = originalListTasks.apply(this, args);
    result.items = (result.items || []).map(item => ({
      ...item,
      body: String(item.comment || item.body || '')
    }));
    return result;
  };
};
