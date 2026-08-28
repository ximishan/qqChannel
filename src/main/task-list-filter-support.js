module.exports = function installTaskListFilterSupport(DB) {
  if (DB.prototype.__taskListFilterSupportInstalled) return;
  DB.prototype.__taskListFilterSupportInstalled = true;

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
};
