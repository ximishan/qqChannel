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
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS selector_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        timeout INTEGER NOT NULL DEFAULT 30000
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const count = this.db.prepare('SELECT COUNT(*) AS c FROM instances').get().c;
    if (!count) this.db.prepare('INSERT INTO instances(name) VALUES (?)').run('默认实例');

    const defaults = [
      ['composer_entry', '发帖入口', 'text=发布动态', 30000],
      ['file_input', '媒体上传 input', 'input[type="file"]', 30000],
      ['title_input', '标题输入框', 'input[placeholder*="标题"]', 30000],
      ['body_input', '正文输入框', 'textarea', 30000],
      ['publish_button', '发布按钮', 'button:has-text("发布")', 30000],
      ['success_hint', '成功提示', 'text=发布成功', 30000]
    ];
    const ins = this.db.prepare('INSERT OR IGNORE INTO selector_configs(key,name,value,timeout) VALUES (?,?,?,?)');
    for (const item of defaults) ins.run(...item);
  }

  listInstances() { return this.db.prepare('SELECT * FROM instances ORDER BY id ASC').all(); }
  createInstance(name) { return this.db.prepare('INSERT INTO instances(name) VALUES (?)').run(name); }
  listChannels(instanceId) { return this.db.prepare('SELECT * FROM channels WHERE instance_id=? ORDER BY id ASC').all(instanceId); }
  addChannel(instanceId, name, url) { return this.db.prepare('INSERT INTO channels(instance_id,name,url) VALUES (?,?,?)').run(instanceId, name, url); }
  deleteChannel(id) { this.db.prepare('DELETE FROM task_targets WHERE channel_id=?').run(id); return this.db.prepare('DELETE FROM channels WHERE id=?').run(id); }

  listTasks(instanceId) {
    const tasks = this.db.prepare('SELECT * FROM tasks WHERE instance_id=? ORDER BY id DESC').all(instanceId);
    const getTargets = this.db.prepare(`SELECT tt.*, c.name AS channel_name, c.url AS channel_url FROM task_targets tt JOIN channels c ON c.id = tt.channel_id WHERE tt.task_id=? ORDER BY tt.id ASC`);
    return tasks.map(t => ({ ...t, targets: getTargets.all(t.id) }));
  }

  createTask(instanceId, title, body, mediaPath, channelIds) {
    const tx = this.db.transaction(() => {
      const r = this.db.prepare(`INSERT INTO tasks(instance_id,title,body,media_path,media_type,status) VALUES (?,?,?,?, 'video', 'pending')`).run(instanceId, title || '', body || '', mediaPath);
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

  setTaskStatus(id, status) {
    const finished = ['success','failed'].includes(status) ? new Date().toISOString() : null;
    this.db.prepare('UPDATE tasks SET status=?, finished_at=COALESCE(?,finished_at) WHERE id=?').run(status, finished, id);
  }

  setTargetStatus(id, status, lastError='') { this.db.prepare('UPDATE task_targets SET status=?, last_error=? WHERE id=?').run(status, lastError || '', id); }
  getSelectors() { return this.db.prepare('SELECT * FROM selector_configs ORDER BY id ASC').all(); }
  saveSelector(key, value, timeout) { return this.db.prepare('UPDATE selector_configs SET value=?, timeout=? WHERE key=?').run(value, timeout, key); }
  getSelectorMap() { const map = {}; for (const r of this.getSelectors()) map[r.key] = r; return map; }
  log(level, message) { this.db.prepare('INSERT INTO logs(level,message) VALUES (?,?)').run(level, message); }
  listLogs(limit=300) { return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit).reverse(); }
}

module.exports = DB;
