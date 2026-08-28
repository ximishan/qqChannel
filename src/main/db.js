const Database = require('better-sqlite3');
const path = require('path');

class DB {
  constructor(userDataPath) {
    this.db = new Database(path.join(userDataPath, 'publisher.db'));
    this.init();
  }

  init() {
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER NOT NULL,
        title TEXT,
        body TEXT,
        media_path TEXT NOT NULL,
        media_type TEXT NOT NULL DEFAULT 'video',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS selector_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        timeout INTEGER NOT NULL DEFAULT 30000
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.ensureColumn('task_targets', 'retry_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('tasks', 'scheduled_at', 'TEXT');
    this.ensureColumn('tasks', 'interval_min_seconds', 'INTEGER');
    this.ensureColumn('tasks', 'interval_max_seconds', 'INTEGER');

    const count = this.db.prepare('SELECT COUNT(*) AS c FROM instances').get().c;
    if (!count) this.db.prepare('INSERT INTO instances(name) VALUES (?)').run('默认实例');

    // 这些默认值来自用户提供的真实 pd.qq.com 频道页 DOM。
    // value 支持用换行写多个候选选择器，BrowserManager 会按顺序尝试。
    // 视频任务必须优先匹配 video accept 的 input，不能先命中通用图片区 input。
    const defaults = [
      ['composer_entry', '发帖入口', 'text=期待你的分享\n[placeholder*="期待你的分享"]', 10000],
      ['file_input', '视频上传 input', 'input[type="file"][accept*="video"]\ninput[type="file"][accept*="video/mp4"]\n.image-video-container input[type="file"]', 30000],
      ['image_input', '图片上传 input', 'input[type="file"][accept*="image"]\ninput[type="file"][accept*="jpeg"]\ninput[type="file"][accept*="png"]', 30000],
      ['body_input', '评论编辑器 ProseMirror', '.editor-root-container .ProseMirror[contenteditable="true"]\n.ProseMirror[contenteditable="true"]', 30000],
      ['publish_button', '发表按钮', '.publish-button button\nbutton.g-button--primary', 30000],
      ['upload_preview', '上传预览区', '.image-video-container .preview-list', 120000],
      ['success_hint', '发布成功提示', 'text=发表成功\ntext=发布成功', 15000],
      ['logged_in_user', '已登录用户', '.app-login .user-info .name\n.app-login .user-card .name', 10000],
      ['login_button', '登录按钮', 'text=登录\nbutton:has-text("登录")', 10000],
      ['error_hint', '页面错误提示', '.publish-status-text.error\n.g-toast--error\n[role="alert"]', 5000]
    ];

    const ins = this.db.prepare(`
      INSERT OR IGNORE INTO selector_configs(key,name,value,timeout)
      VALUES (?,?,?,?)
    `);
    for (const item of defaults) ins.run(...item);

    // 兼容旧版默认选择器：只迁移明确的旧默认值，用户自定义值不覆盖。
    const migrations = [
      ['composer_entry', 'text=发布动态', '.editor-root-container .ProseMirror\n.ProseMirror[contenteditable="true"]'],
      ['composer_entry', '.editor-root-container .ProseMirror\n.ProseMirror[contenteditable="true"]', 'text=期待你的分享\n[placeholder*="期待你的分享"]'],
      ['file_input', 'input[type="file"]', 'input[type="file"][accept*="video"]\ninput[type="file"][accept*="video/mp4"]\n.image-video-container input[type="file"]'],
      ['file_input', '.image-video-container input[type="file"]\ninput[type="file"][accept*="video/mp4"]', 'input[type="file"][accept*="video"]\ninput[type="file"][accept*="video/mp4"]\n.image-video-container input[type="file"]'],
      ['body_input', 'textarea', '.editor-root-container .ProseMirror[contenteditable="true"]\n.ProseMirror[contenteditable="true"]'],
      ['publish_button', 'button:has-text("发布")', '.publish-button button:has-text("发表")\nbutton.g-button--primary:has-text("发表")'],
      ['publish_button', '.publish-button button:has-text("发表")\nbutton.g-button--primary:has-text("发表")', '.publish-button button\nbutton.g-button--primary'],
      ['success_hint', 'text=发布成功', 'text=发表成功\ntext=发布成功'],
      ['error_hint', '.g-toast--error\n[role="alert"]', '.publish-status-text.error\n.g-toast--error\n[role="alert"]']
    ];
    const migrate = this.db.prepare('UPDATE selector_configs SET value=? WHERE key=? AND value=?');
    for (const [key, oldValue, newValue] of migrations) migrate.run(newValue, key, oldValue);

    this.db.prepare(`
      UPDATE selector_configs
      SET name='发帖入口', timeout=10000
      WHERE key='composer_entry'
        AND name='发帖编辑区'
        AND value='text=期待你的分享\n[placeholder*="期待你的分享"]'
    `).run();

    this.db.prepare(`
      UPDATE selector_configs
      SET name='视频上传 input'
      WHERE key='file_input'
        AND name='图片/视频上传 input'
        AND value='input[type="file"][accept*="video"]\ninput[type="file"][accept*="video/mp4"]\n.image-video-container input[type="file"]'
    `).run();

    this.db.prepare(`UPDATE selector_configs SET name='评论编辑器 ProseMirror' WHERE key='body_input'`).run();

    const settingDefaults = [
      ['max_retries', '2'],
      ['upload_timeout_ms', '120000'],
      ['publish_verify_timeout_ms', '20000'],
      ['screenshot_on_error', '1'],
      ['interval_min_seconds', '180'],
      ['interval_max_seconds', '480'],
      ['target_interval_seconds', '70']
    ];
    const setDefault = this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
    for (const row of settingDefaults) setDefault.run(...row);

    // 软件异常退出时可能留下 running，启动后回到 pending，便于断点继续。
    this.resetInterruptedTasks();
  }

  ensureColumn(table, column, definition) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  resetInterruptedTasks() {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE tasks SET status='pending', finished_at=NULL WHERE status='running'`).run();
      this.db.prepare(`UPDATE task_targets SET status='pending' WHERE status='running'`).run();
    });
    tx();
  }

  listInstances() { return this.db.prepare('SELECT * FROM instances ORDER BY id ASC').all(); }
  createInstance(name) { return this.db.prepare('INSERT INTO instances(name) VALUES (?)').run(name); }
  updateInstanceName(id, name) {
    const normalizedId = Number(id);
    const normalizedName = String(name || '').trim();
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('实例不存在');
    if (!normalizedName) throw new Error('实例名称不能为空');
    const result = this.db.prepare('UPDATE instances SET name=? WHERE id=?').run(normalizedName, normalizedId);
    if (!result.changes) throw new Error('实例不存在');
    return { id: normalizedId, name: normalizedName };
  }
  getInstanceSummary(id) {
    const normalizedId = Number(id);
    const row = this.db.prepare(`
      SELECT i.id, i.name,
        (SELECT COUNT(*) FROM channels c WHERE c.instance_id=i.id) AS channel_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.instance_id=i.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.instance_id=i.id AND t.status='running') AS running_task_count
      FROM instances i WHERE i.id=?
    `).get(normalizedId);
    if (!row) throw new Error('实例不存在');
    return row;
  }
  deleteInstance(id) {
    const summary = this.getInstanceSummary(id);
    const normalizedId = Number(summary.id);
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_targets WHERE task_id IN (SELECT id FROM tasks WHERE instance_id=?)').run(normalizedId);
      this.db.prepare('DELETE FROM tasks WHERE instance_id=?').run(normalizedId);
      this.db.prepare('DELETE FROM channels WHERE instance_id=?').run(normalizedId);
      const result = this.db.prepare('DELETE FROM instances WHERE id=?').run(normalizedId);
      if (!result.changes) throw new Error('实例不存在');
    });
    tx();
    return {
      id: normalizedId,
      name: summary.name,
      deletedChannels: Number(summary.channel_count || 0),
      deletedTasks: Number(summary.task_count || 0)
    };
  }
  listChannels(instanceId) { return this.db.prepare('SELECT * FROM channels WHERE instance_id=? ORDER BY id ASC').all(instanceId); }
  addChannel(instanceId, name, url) {
    const normalizedInstanceId = Number(instanceId);
    const normalizedName = String(name || '').trim();
    const normalizedUrl = String(url || '').trim();
    this.getInstanceSummary(normalizedInstanceId);
    if (!normalizedName) throw new Error('频道名称不能为空');
    if (!/^https:\/\/pd\.qq\.com\/g\//i.test(normalizedUrl)) throw new Error('腾讯频道 URL 无效');
    return this.db.prepare('INSERT INTO channels(instance_id,name,url) VALUES (?,?,?)').run(normalizedInstanceId, normalizedName, normalizedUrl);
  }
  updateChannelName(id, name) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) throw new Error('频道名称不能为空');
    return this.db.prepare('UPDATE channels SET name=? WHERE id=?').run(normalizedName, id);
  }
  deleteChannel(id) { this.db.prepare('DELETE FROM task_targets WHERE channel_id=?').run(id); return this.db.prepare('DELETE FROM channels WHERE id=?').run(id); }

  listTasks(instanceId, page = 1, pageSize = 10) {
    const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 10)));
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE instance_id=?').get(instanceId).c;
    const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
    const normalizedPage = Math.min(totalPages, Math.max(1, Math.floor(Number(page) || 1)));
    const offset = (normalizedPage - 1) * normalizedPageSize;
    const tasks = this.db.prepare('SELECT * FROM tasks WHERE instance_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(instanceId, normalizedPageSize, offset);
    const getTargets = this.db.prepare(`SELECT tt.*, c.name AS channel_name, c.url AS channel_url FROM task_targets tt JOIN channels c ON c.id = tt.channel_id WHERE tt.task_id=? ORDER BY tt.id ASC`);
    return {
      items: tasks.map(t => ({ ...t, targets: getTargets.all(t.id) })),
      page: normalizedPage,
      pageSize: normalizedPageSize,
      total,
      totalPages
    };
  }

  createTask(instanceId, title, body, mediaPath, channelIds, mediaType = 'video', scheduledAt = null, intervalMinSeconds = null, intervalMaxSeconds = null) {
    const type = ['text', 'image', 'video'].includes(mediaType) ? mediaType : 'video';
    const normalizedBody = body || title || '';
    if (type === 'text' && !normalizedBody.trim()) throw new Error('纯文本任务必须填写评论或标题');
    if (type === 'image' && !mediaPath) throw new Error('图片任务必须选择图片文件');
    if (type === 'video' && !mediaPath) throw new Error('视频任务必须选择视频文件');
    const normalizedScheduledAt = scheduledAt ? new Date(scheduledAt).toISOString() : null;
    let minSeconds = intervalMinSeconds === '' || intervalMinSeconds == null ? null : Math.max(0, Math.floor(Number(intervalMinSeconds) || 0));
    let maxSeconds = intervalMaxSeconds === '' || intervalMaxSeconds == null ? null : Math.max(0, Math.floor(Number(intervalMaxSeconds) || 0));
    if (minSeconds != null && maxSeconds == null) maxSeconds = minSeconds;
    if (maxSeconds != null && minSeconds == null) minSeconds = maxSeconds;
    if (minSeconds != null && maxSeconds < minSeconds) [minSeconds, maxSeconds] = [maxSeconds, minSeconds];
    const tx = this.db.transaction(() => {
      const r = this.db.prepare(`INSERT INTO tasks(instance_id,title,body,media_path,media_type,status,scheduled_at,interval_min_seconds,interval_max_seconds) VALUES (?,?,?,?,?, 'pending',?,?,?)`).run(
        instanceId,
        title || '',
        normalizedBody,
        type === 'text' ? '' : mediaPath,
        type,
        normalizedScheduledAt,
        minSeconds,
        maxSeconds
      );
      const targetIns = this.db.prepare(`INSERT INTO task_targets(task_id,channel_id,status) VALUES (?,?, 'pending')`);
      for (const cid of channelIds) targetIns.run(r.lastInsertRowid, cid);
      return r.lastInsertRowid;
    });
    return tx();
  }

  getTask(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!task) return null;
    task.targets = this.db.prepare(`SELECT tt.*, c.name AS channel_name, c.url AS channel_url FROM task_targets tt JOIN channels c ON c.id = tt.channel_id WHERE tt.task_id=? ORDER BY tt.id ASC`).all(id);
    return task;
  }

  getNextPendingTask(instanceId) {
    const row = this.db.prepare(`
      SELECT id FROM tasks
      WHERE instance_id=? AND status='pending'
        AND (scheduled_at IS NULL OR datetime(scheduled_at) <= datetime('now'))
      ORDER BY CASE WHEN scheduled_at IS NULL THEN 0 ELSE 1 END, datetime(scheduled_at) ASC, id ASC
      LIMIT 1
    `).get(instanceId);
    return row ? this.getTask(row.id) : null;
  }

  getNextScheduledAt(instanceId) {
    const row = this.db.prepare(`
      SELECT scheduled_at FROM tasks
      WHERE instance_id=? AND status='pending' AND scheduled_at IS NOT NULL
        AND datetime(scheduled_at) > datetime('now')
      ORDER BY datetime(scheduled_at) ASC LIMIT 1
    `).get(instanceId);
    return row?.scheduled_at || null;
  }

  getPendingTaskSummary(instanceId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS task_count FROM tasks WHERE instance_id=? AND status='pending'`).get(instanceId);
    const channels = this.db.prepare(`
      SELECT DISTINCT c.name
      FROM tasks t
      JOIN task_targets tt ON tt.task_id=t.id
      JOIN channels c ON c.id=tt.channel_id
      WHERE t.instance_id=? AND t.status='pending' AND tt.status!='success'
      ORDER BY c.name COLLATE NOCASE
    `).all(instanceId).map(item => item.name);
    return { taskCount: row.task_count, channels };
  }

  countPendingTasks(instanceId) {
    return this.db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE instance_id=? AND status='pending'`).get(instanceId).c;
  }

  setTaskStatus(id, status) {
    const finished = ['success','failed'].includes(status) ? new Date().toISOString() : null;
    this.db.prepare('UPDATE tasks SET status=?, finished_at=CASE WHEN ? IS NULL THEN finished_at ELSE ? END WHERE id=?').run(status, finished, finished, id);
  }

  setTargetStatus(id, status, lastError='') {
    this.db.prepare('UPDATE task_targets SET status=?, last_error=? WHERE id=?').run(status, lastError || '', id);
  }

  incrementTargetRetry(id) {
    this.db.prepare('UPDATE task_targets SET retry_count=retry_count+1 WHERE id=?').run(id);
  }

  resetFailedTargets(taskId) {
    this.db.prepare(`UPDATE task_targets SET status='pending', last_error='' WHERE task_id=? AND status='failed'`).run(taskId);
    this.db.prepare(`UPDATE tasks SET status='pending', finished_at=NULL WHERE id=?`).run(taskId);
  }

  deleteTasks(taskIds) {
    const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return { deletedCount: 0, skippedRunningCount: 0 };
    const placeholders = ids.map(() => '?').join(',');
    const deletableIds = this.db.prepare(`SELECT id FROM tasks WHERE id IN (${placeholders}) AND status!='running'`).all(...ids).map(row => row.id);
    if (!deletableIds.length) return { deletedCount: 0, skippedRunningCount: ids.length };
    const deletePlaceholders = deletableIds.map(() => '?').join(',');
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM task_targets WHERE task_id IN (${deletePlaceholders})`).run(...deletableIds);
      this.db.prepare(`DELETE FROM tasks WHERE id IN (${deletePlaceholders})`).run(...deletableIds);
    });
    tx();
    return { deletedCount: deletableIds.length, skippedRunningCount: ids.length - deletableIds.length };
  }

  getSelectors() { return this.db.prepare('SELECT * FROM selector_configs ORDER BY id ASC').all(); }
  saveSelector(key, value, timeout) { return this.db.prepare('UPDATE selector_configs SET value=?, timeout=? WHERE key=?').run(value, timeout, key); }
  getSelectorMap() { const map = {}; for (const r of this.getSelectors()) map[r.key] = r; return map; }

  getSetting(key, fallback=null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
  }

  listSettings() { return this.db.prepare('SELECT key,value FROM settings ORDER BY key').all(); }

  log(level, message) { this.db.prepare('INSERT INTO logs(level,message) VALUES (?,?)').run(level, message); }
  listLogs(limit=300) { return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit).reverse(); }
}

module.exports = DB;
