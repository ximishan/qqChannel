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
    this.ensureColumn('instances', 'login_name', 'TEXT');
    this.ensureColumn('instances', 'login_status', "TEXT NOT NULL DEFAULT 'unknown'");
    this.ensureColumn('instances', 'last_login_check_at', 'TEXT');
    // 这些字段由旧版 CLI 模式创建。DOM 模式不依赖它们，但保留字段可让旧数据
    // 无损升级，也避免任务列表读取旧频道记录时出现列不存在。
    this.ensureColumn('channels', 'guild_id', 'TEXT');
    this.ensureColumn('channels', 'guild_number', 'TEXT');
    this.ensureColumn('channels', 'post_channel_id', 'TEXT');
    this.ensureColumn('channels', 'post_channel_name', 'TEXT');

    const count = this.db.prepare('SELECT COUNT(*) AS c FROM instances').get().c;
    if (!count) this.db.prepare('INSERT INTO instances(name) VALUES (?)').run('账号实例 1');

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

    const ins = this.db.prepare(`INSERT OR IGNORE INTO selector_configs(key,name,value,timeout) VALUES (?,?,?,?)`);
    for (const item of defaults) ins.run(...item);

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

    this.resetInterruptedTasks();
  }

  ensureColumn(table, column, definition) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
  setInstanceLoginState(id, loggedIn, loginName = '') {
    const status = loggedIn ? 'logged_in' : 'logged_out';
    this.db.prepare(`
      UPDATE instances
      SET login_status=?, login_name=?, last_login_check_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(status, loggedIn ? String(loginName || '').trim() : '', Number(id));
  }
  updateInstanceName(id, name) {
    const normalizedId = Number(id);
    const normalizedName = String(name || '').trim();
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('频道分组不存在');
    if (!normalizedName) throw new Error('频道分组名称不能为空');
    const result = this.db.prepare('UPDATE instances SET name=? WHERE id=?').run(normalizedName, normalizedId);
    if (!result.changes) throw new Error('频道分组不存在');
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
    if (!row) throw new Error('频道分组不存在');
    return row;
  }
  deleteInstance(id) {
    const summary = this.getInstanceSummary(id);
    const normalizedId = Number(summary.id);
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_targets WHERE task_id IN (SELECT id FROM tasks WHERE instance_id=?)').run(normalizedId);
      this.db.prepare('DELETE FROM tasks WHERE instance_id=?').run(normalizedId);
      this.db.prepare('DELETE FROM channels WHERE instance_id=?').run(normalizedId);
      this.db.prepare('DELETE FROM instances WHERE id=?').run(normalizedId);
    });
    tx();
    return { id: normalizedId, name: summary.name, deletedChannels: Number(summary.channel_count || 0), deletedTasks: Number(summary.task_count || 0) };
  }

  listChannels(instanceId) { return this.db.prepare('SELECT * FROM channels WHERE instance_id=? ORDER BY id ASC').all(instanceId); }
  listChannelAssignments() {
    return this.db.prepare(`
      SELECT c.*, i.name AS instance_name
      FROM channels c
      JOIN instances i ON i.id=c.instance_id
      ORDER BY i.id ASC, c.id ASC
    `).all();
  }
  moveChannel(id, instanceId) {
    const channelId = Number(id);
    const targetInstanceId = Number(instanceId);
    if (!Number.isInteger(channelId) || channelId <= 0) throw new Error('频道不存在');
    const target = this.getInstanceSummary(targetInstanceId);
    const channel = this.db.prepare('SELECT * FROM channels WHERE id=?').get(channelId);
    if (!channel) throw new Error('频道不存在');
    this.db.prepare('UPDATE channels SET instance_id=? WHERE id=?').run(targetInstanceId, channelId);
    return { id: channelId, name: channel.name, instanceId: targetInstanceId, instanceName: target.name };
  }
  addChannel(instanceId, name, url) {
    const normalizedInstanceId = Number(instanceId);
    const normalizedName = String(name || '').trim();
    const normalizedUrl = String(url || '').trim();
    this.getInstanceSummary(normalizedInstanceId);
    if (!normalizedName) throw new Error('频道名称不能为空');
    if (!/^https:\/\/pd\.qq\.com\/g\//i.test(normalizedUrl)) throw new Error('腾讯频道 URL 无效');
    return this.db.prepare('INSERT INTO channels(instance_id,name,url) VALUES (?,?,?)').run(normalizedInstanceId, normalizedName, normalizedUrl);
  }
  importRemoteChannels(instanceId, channels = []) {
    const normalizedInstanceId = Number(instanceId);
    this.getInstanceSummary(normalizedInstanceId);
    if (!Array.isArray(channels) || !channels.length) throw new Error('请至少选择一个频道');

    const find = this.db.prepare(`
      SELECT id FROM channels
      WHERE instance_id=? AND (url=? OR (COALESCE(guild_number,'')<>'' AND guild_number=?))
      ORDER BY id ASC LIMIT 1
    `);
    const insert = this.db.prepare(`
      INSERT INTO channels(instance_id,name,url,enabled,guild_number)
      VALUES (?,?,?,1,?)
    `);
    const update = this.db.prepare(`
      UPDATE channels SET name=?,url=?,enabled=1,guild_number=? WHERE id=?
    `);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const transaction = this.db.transaction(() => {
      for (const item of channels) {
        const name = String(item?.name || '').trim();
        const url = String(item?.url || '').trim();
        const guildNumber = String(item?.guildNumber || '').trim() || url.match(/\/g\/([^/?#]+)/i)?.[1] || '';
        if (!name || !/^https:\/\/pd\.qq\.com\/g\//i.test(url)) {
          skipped += 1;
          continue;
        }
        const existing = find.get(normalizedInstanceId, url, guildNumber);
        if (existing) {
          update.run(name, url, guildNumber, existing.id);
          updated += 1;
        } else {
          insert.run(normalizedInstanceId, name, url, guildNumber);
          created += 1;
        }
      }
    });
    transaction();
    return { created, updated, skipped };
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
    const getTargets = this.db.prepare(`SELECT tt.*, c.name AS channel_name, c.url AS channel_url, c.guild_id, c.guild_number, c.post_channel_id, c.post_channel_name FROM task_targets tt JOIN channels c ON c.id = tt.channel_id WHERE tt.task_id=? ORDER BY tt.id ASC`);
    return { items: tasks.map(t => ({ ...t, targets: getTargets.all(t.id) })), page: normalizedPage, pageSize: normalizedPageSize, total, totalPages };
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
      const r = this.db.prepare(`INSERT INTO tasks(instance_id,title,body,media_path,media_type,status,scheduled_at,interval_min_seconds,interval_max_seconds) VALUES (?,?,?,?,?, 'pending',?,?,?)`).run(instanceId, title || '', normalizedBody, type === 'text' ? '' : mediaPath, type, normalizedScheduledAt, minSeconds, maxSeconds);
      const targetIns = this.db.prepare(`INSERT INTO task_targets(task_id,channel_id,status) VALUES (?,?, 'pending')`);
      for (const cid of channelIds) targetIns.run(r.lastInsertRowid, cid);
      return r.lastInsertRowid;
    });
    return tx();
  }

  getTask(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!task) return null;
    task.targets = this.db.prepare(`SELECT tt.*, c.name AS channel_name, c.url AS channel_url, c.guild_id, c.guild_number, c.post_channel_id, c.post_channel_name FROM task_targets tt JOIN channels c ON c.id = tt.channel_id WHERE tt.task_id=? ORDER BY tt.id ASC`).all(id);
    return task;
  }
  getNextPendingTask(instanceId) {
    const row = this.db.prepare(`SELECT id FROM tasks WHERE instance_id=? AND status='pending' AND (scheduled_at IS NULL OR datetime(scheduled_at) <= datetime('now')) ORDER BY CASE WHEN scheduled_at IS NULL THEN 0 ELSE 1 END, datetime(scheduled_at) ASC, id ASC LIMIT 1`).get(instanceId);
    return row ? this.getTask(row.id) : null;
  }
  getNextScheduledAt(instanceId) {
    const row = this.db.prepare(`SELECT scheduled_at FROM tasks WHERE instance_id=? AND status='pending' AND scheduled_at IS NOT NULL AND datetime(scheduled_at) > datetime('now') ORDER BY datetime(scheduled_at) ASC LIMIT 1`).get(instanceId);
    return row?.scheduled_at || null;
  }
  getPendingTaskSummary(instanceId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS task_count FROM tasks WHERE instance_id=? AND status='pending'`).get(instanceId);
    const channels = this.db.prepare(`SELECT DISTINCT c.name FROM tasks t JOIN task_targets tt ON tt.task_id=t.id JOIN channels c ON c.id=tt.channel_id WHERE t.instance_id=? AND t.status='pending' AND tt.status!='success' ORDER BY c.name COLLATE NOCASE`).all(instanceId).map(item => item.name);
    return { taskCount: row.task_count, channels };
  }
  countPendingTasks(instanceId) { return this.db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE instance_id=? AND status='pending'`).get(instanceId).c; }
  setTaskStatus(id, status) { const finished = ['success','failed'].includes(status) ? new Date().toISOString() : null; this.db.prepare('UPDATE tasks SET status=?, finished_at=CASE WHEN ? IS NULL THEN finished_at ELSE ? END WHERE id=?').run(status, finished, finished, id); }
  setTargetStatus(id, status, lastError='') { this.db.prepare('UPDATE task_targets SET status=?, last_error=? WHERE id=?').run(status, lastError || '', id); }
  incrementTargetRetry(id) { this.db.prepare('UPDATE task_targets SET retry_count=retry_count+1 WHERE id=?').run(id); }
  resetFailedTargets(taskId) { this.db.prepare(`UPDATE task_targets SET status='pending', last_error='' WHERE task_id=? AND status='failed'`).run(taskId); this.db.prepare(`UPDATE tasks SET status='pending', finished_at=NULL WHERE id=?`).run(taskId); }
  deleteTasks(taskIds) {
    const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return { deletedCount: 0, skippedRunningCount: 0 };
    const placeholders = ids.map(() => '?').join(',');
    const deletableIds = this.db.prepare(`SELECT id FROM tasks WHERE id IN (${placeholders}) AND status!='running'`).all(...ids).map(row => row.id);
    if (!deletableIds.length) return { deletedCount: 0, skippedRunningCount: ids.length };
    const deletePlaceholders = deletableIds.map(() => '?').join(',');
    const tx = this.db.transaction(() => { this.db.prepare(`DELETE FROM task_targets WHERE task_id IN (${deletePlaceholders})`).run(...deletableIds); this.db.prepare(`DELETE FROM tasks WHERE id IN (${deletePlaceholders})`).run(...deletableIds); });
    tx();
    return { deletedCount: deletableIds.length, skippedRunningCount: ids.length - deletableIds.length };
  }

  getSelectors() { return this.db.prepare('SELECT * FROM selector_configs ORDER BY id ASC').all(); }
  saveSelector(key, value, timeout) { return this.db.prepare('UPDATE selector_configs SET value=?, timeout=? WHERE key=?').run(value, timeout, key); }
  getSelectorMap() { const map = {}; for (const r of this.getSelectors()) map[r.key] = r; return map; }
  getSetting(key, fallback=null) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? row.value : fallback; }
  setSetting(key, value) { this.db.prepare(`INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value)); }
  listSettings() { return this.db.prepare('SELECT key,value FROM settings ORDER BY key').all(); }
  log(level, message) { this.db.prepare('INSERT INTO logs(level,message) VALUES (?,?)').run(level, message); }
  listLogs(limit=300) { return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit).reverse(); }
}

module.exports = DB;
