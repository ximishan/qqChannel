module.exports = function installTaskListFilterSupport(DB) {
  if (DB.prototype.__taskListFilterSupportInstalled) return;
  DB.prototype.__taskListFilterSupportInstalled = true;

  const originalGetNextPendingTask = DB.prototype.getNextPendingTask;
  const originalGetNextScheduledAt = DB.prototype.getNextScheduledAt;
  const originalCountPendingTasks = DB.prototype.countPendingTasks;
  const originalGetPendingTaskSummary = DB.prototype.getPendingTaskSummary;

  DB.prototype.listTasks = function listTasksGlobal(_instanceId, page = 1, pageSize = 10) {
    const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 10)));
    const groupId = Math.max(0, Math.floor(Number(this.getSetting('task_list_group_filter', '0')) || 0));
    const channelSearch = String(this.getSetting('task_list_channel_search', '') || '').trim();

    const where = [];
    const params = [];

    if (groupId > 0) {
      where.push('t.instance_id=?');
      params.push(groupId);
    }

    if (channelSearch) {
      where.push(`EXISTS (
        SELECT 1
        FROM task_targets search_tt
        JOIN channels search_c ON search_c.id=search_tt.channel_id
        WHERE search_tt.task_id=t.id
          AND (
            search_c.name LIKE ?
            OR COALESCE(search_c.guild_number, '') LIKE ?
            OR COALESCE(search_c.url, '') LIKE ?
          )
      )`);
      const like = `%${channelSearch}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS c FROM tasks t ${whereSql}`).get(...params).c;
    const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
    const normalizedPage = Math.min(totalPages, Math.max(1, Math.floor(Number(page) || 1)));
    const offset = (normalizedPage - 1) * normalizedPageSize;

    const tasks = this.db.prepare(`
      SELECT t.*
      FROM tasks t
      ${whereSql}
      ORDER BY t.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, normalizedPageSize, offset);

    const getTargets = this.db.prepare(`
      SELECT tt.*, c.name AS channel_name, c.url AS channel_url,
             c.guild_id, c.guild_number, c.post_channel_id, c.post_channel_name
      FROM task_targets tt
      JOIN channels c ON c.id=tt.channel_id
      WHERE tt.task_id=?
      ORDER BY tt.id ASC
    `);

    return {
      items: tasks.map(task => ({ ...task, targets: getTargets.all(task.id) })),
      page: normalizedPage,
      pageSize: normalizedPageSize,
      total,
      totalPages,
      filters: { groupId, channelSearch }
    };
  };

  // instanceId=0 表示“全部频道分组”的全局发布队列。
  // 搜索框只负责列表查找，不限制队列实际要发布的任务，避免搜索关键词误伤待发任务。
  DB.prototype.getNextPendingTask = function getNextPendingTaskWithGlobalScope(instanceId) {
    const id = Number(instanceId);
    if (id > 0) return originalGetNextPendingTask.call(this, id);
    const row = this.db.prepare(`
      SELECT id FROM tasks
      WHERE status='pending'
        AND (scheduled_at IS NULL OR datetime(scheduled_at) <= datetime('now'))
      ORDER BY CASE WHEN scheduled_at IS NULL THEN 0 ELSE 1 END, datetime(scheduled_at) ASC, id ASC
      LIMIT 1
    `).get();
    return row ? this.getTask(row.id) : null;
  };

  DB.prototype.getNextScheduledAt = function getNextScheduledAtWithGlobalScope(instanceId) {
    const id = Number(instanceId);
    if (id > 0) return originalGetNextScheduledAt.call(this, id);
    const row = this.db.prepare(`
      SELECT scheduled_at FROM tasks
      WHERE status='pending' AND scheduled_at IS NOT NULL
        AND datetime(scheduled_at) > datetime('now')
      ORDER BY datetime(scheduled_at) ASC LIMIT 1
    `).get();
    return row?.scheduled_at || null;
  };

  DB.prototype.countPendingTasks = function countPendingTasksWithGlobalScope(instanceId) {
    const id = Number(instanceId);
    if (id > 0) return originalCountPendingTasks.call(this, id);
    return this.db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status='pending'`).get().c;
  };

  DB.prototype.getPendingTaskSummary = function getPendingTaskSummaryWithGlobalScope(instanceId) {
    const id = Number(instanceId);
    if (id > 0) return originalGetPendingTaskSummary.call(this, id);
    const row = this.db.prepare(`SELECT COUNT(*) AS task_count FROM tasks WHERE status='pending'`).get();
    const channels = this.db.prepare(`
      SELECT DISTINCT c.name
      FROM tasks t
      JOIN task_targets tt ON tt.task_id=t.id
      JOIN channels c ON c.id=tt.channel_id
      WHERE t.status='pending' AND tt.status!='success'
      ORDER BY c.name COLLATE NOCASE
    `).all().map(item => item.name);
    return { taskCount: row.task_count, channels };
  };
};
