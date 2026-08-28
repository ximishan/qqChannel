const crypto = require('crypto');

function normalizeIdValue(value) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  if (!text || text === '0' || text === 'null' || text === 'undefined') return '';
  return text;
}

function findStableIdentity(status = {}) {
  const preferredKeys = [
    'uin', 'qq', 'qqnumber', 'qq_number', 'openid', 'open_id', 'unionid', 'union_id',
    'userid', 'user_id', 'uid', 'accountid', 'account_id', 'memberid', 'member_id'
  ];
  const wanted = new Set(preferredKeys.map(key => key.replace(/[^a-z0-9]/gi, '').toLowerCase()));
  const found = [];

  function walk(value, path = [], depth = 0) {
    if (!value || typeof value !== 'object' || depth > 4) return;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
      const childPath = [...path, key];
      if (wanted.has(normalizedKey)) {
        const id = normalizeIdValue(child);
        if (id) found.push({ key: normalizedKey, value: id, path: childPath.join('.') });
      }
      if (child && typeof child === 'object') walk(child, childPath, depth + 1);
    }
  }

  walk(status);
  if (!found.length) return null;
  const priority = key => {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const idx = preferredKeys.map(item => item.replace(/[^a-z0-9]/gi, '').toLowerCase()).indexOf(normalized);
    return idx < 0 ? 999 : idx;
  };
  found.sort((a, b) => priority(a.key) - priority(b.key));
  const best = found[0];
  return {
    externalKey: `qqid:${best.key}:${best.value}`,
    identityType: best.key,
    identityValue: best.value,
    identityMeta: JSON.stringify({ path: best.path })
  };
}

function safeShape(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) return typeof value;
  if (Array.isArray(value)) return [`array(${value.length})`];
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|cookie|credential|secret|keychain|authorization/i.test(key)) {
      result[key] = '[sensitive]';
    } else if (child && typeof child === 'object') {
      result[key] = safeShape(child, depth + 1);
    } else {
      result[key] = typeof child;
    }
  }
  return result;
}

module.exports = function installAccountWorkspaceSupport(DB, BrowserManager) {
  if (DB.prototype.__accountWorkspaceSupportInstalled) return;
  DB.prototype.__accountWorkspaceSupportInstalled = true;

  const originalInit = DB.prototype.init;
  const originalListSettings = DB.prototype.listSettings;

  DB.prototype.init = function initAccountWorkspaceSupport() {
    originalInit.call(this);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS qq_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_key TEXT NOT NULL UNIQUE,
        identity_type TEXT NOT NULL,
        identity_value TEXT NOT NULL,
        identity_meta TEXT,
        display_name TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.ensureColumn('instances', 'account_id', 'INTEGER');
    this.ensureColumn('channels', 'account_id', 'INTEGER');
    this.ensureColumn('tasks', 'account_id', 'INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_instances_account_id ON instances(account_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_channels_account_id ON channels(account_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id)');
  };

  DB.prototype.getActiveAccountId = function getActiveAccountId() {
    const raw = this.getSetting('active_qq_account_id', '0');
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : 0;
  };

  DB.prototype.getActiveQQAccount = function getActiveQQAccount() {
    const id = this.getActiveAccountId();
    return id ? this.db.prepare('SELECT * FROM qq_accounts WHERE id=?').get(id) || null : null;
  };

  DB.prototype.activateQQAccount = function activateQQAccount(identity, displayName = '') {
    if (!identity?.externalKey) throw new Error('无法识别当前 QQ 的唯一账号标识');
    let account = this.db.prepare('SELECT * FROM qq_accounts WHERE external_key=?').get(identity.externalKey);
    const tx = this.db.transaction(() => {
      if (!account) {
        const result = this.db.prepare(`
          INSERT INTO qq_accounts(external_key,identity_type,identity_value,identity_meta,display_name)
          VALUES (?,?,?,?,?)
        `).run(
          identity.externalKey,
          identity.identityType || 'unknown',
          identity.identityValue || identity.externalKey,
          identity.identityMeta || '',
          String(displayName || '').trim()
        );
        account = this.db.prepare('SELECT * FROM qq_accounts WHERE id=?').get(Number(result.lastInsertRowid));
      } else {
        this.db.prepare(`
          UPDATE qq_accounts
          SET identity_meta=?, display_name=CASE WHEN ?<>'' THEN ? ELSE display_name END, last_seen_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(identity.identityMeta || account.identity_meta || '', String(displayName || '').trim(), String(displayName || '').trim(), account.id);
      }

      const accountId = Number(account.id);
      // 只在数据库里尚未存在任何已归属账号数据时迁移旧版未归属数据。
      // 不能在每次登录时都把 account_id=NULL 的数据归给当前账号，否则切换账号会串数据。
      const ownedRows = this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM instances WHERE account_id IS NOT NULL AND account_id<>0) +
          (SELECT COUNT(*) FROM channels WHERE account_id IS NOT NULL AND account_id<>0) +
          (SELECT COUNT(*) FROM tasks WHERE account_id IS NOT NULL AND account_id<>0) AS c
      `).get().c;
      if (!ownedRows) {
        this.db.prepare('UPDATE instances SET account_id=? WHERE account_id IS NULL OR account_id=0').run(accountId);
        this.db.prepare('UPDATE channels SET account_id=? WHERE account_id IS NULL OR account_id=0').run(accountId);
        this.db.prepare('UPDATE tasks SET account_id=? WHERE account_id IS NULL OR account_id=0').run(accountId);
      }

      const groupCount = this.db.prepare('SELECT COUNT(*) AS c FROM instances WHERE account_id=?').get(accountId).c;
      if (!groupCount) this.db.prepare('INSERT INTO instances(name,account_id) VALUES (?,?)').run('默认频道分组', accountId);

      this.setSetting('active_qq_account_id', String(accountId));
      this.setSetting('task_list_group_filter', '0');
      this.setSetting('task_list_channel_search', '');
    });
    tx();
    return this.db.prepare('SELECT * FROM qq_accounts WHERE id=?').get(Number(account.id));
  };

  DB.prototype.deactivateQQAccount = function deactivateQQAccount() {
    this.setSetting('active_qq_account_id', '0');
    this.setSetting('task_list_group_filter', '0');
    this.setSetting('task_list_channel_search', '');
  };

  DB.prototype.listQQAccounts = function listQQAccounts() {
    return this.db.prepare('SELECT id,external_key,identity_type,display_name,created_at,last_seen_at FROM qq_accounts ORDER BY id ASC').all();
  };

  DB.prototype.listInstances = function listInstancesForAccount() {
    const accountId = this.getActiveAccountId();
    if (!accountId) return [];
    return this.db.prepare('SELECT * FROM instances WHERE account_id=? ORDER BY id ASC').all(accountId);
  };

  DB.prototype.createInstance = function createInstanceForAccount(name) {
    const accountId = this.getActiveAccountId();
    if (!accountId) throw new Error('请先登录 QQ，再新建频道分组');
    return this.db.prepare('INSERT INTO instances(name,account_id) VALUES (?,?)').run(name, accountId);
  };

  DB.prototype.updateInstanceName = function updateInstanceNameForAccount(id, name) {
    const accountId = this.getActiveAccountId();
    const normalizedName = String(name || '').trim();
    if (!accountId) throw new Error('请先登录 QQ');
    if (!normalizedName) throw new Error('频道分组名称不能为空');
    const result = this.db.prepare('UPDATE instances SET name=? WHERE id=? AND account_id=?').run(normalizedName, Number(id), accountId);
    if (!result.changes) throw new Error('频道分组不存在或不属于当前 QQ');
    return { id: Number(id), name: normalizedName };
  };

  DB.prototype.getInstanceSummary = function getInstanceSummaryForAccount(id) {
    const accountId = this.getActiveAccountId();
    if (!accountId) throw new Error('请先登录 QQ');
    const row = this.db.prepare(`
      SELECT i.id, i.name,
        (SELECT COUNT(*) FROM channels c WHERE c.instance_id=i.id AND c.account_id=?) AS channel_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.instance_id=i.id AND t.account_id=?) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.instance_id=i.id AND t.account_id=? AND t.status='running') AS running_task_count
      FROM instances i WHERE i.id=? AND i.account_id=?
    `).get(accountId, accountId, accountId, Number(id), accountId);
    if (!row) throw new Error('频道分组不存在或不属于当前 QQ');
    return row;
  };

  DB.prototype.deleteInstance = function deleteInstanceForAccount(id) {
    const summary = this.getInstanceSummary(id);
    const accountId = this.getActiveAccountId();
    const instanceId = Number(summary.id);
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_targets WHERE task_id IN (SELECT id FROM tasks WHERE instance_id=? AND account_id=?)').run(instanceId, accountId);
      this.db.prepare('DELETE FROM tasks WHERE instance_id=? AND account_id=?').run(instanceId, accountId);
      this.db.prepare('DELETE FROM channels WHERE instance_id=? AND account_id=?').run(instanceId, accountId);
      this.db.prepare('DELETE FROM instances WHERE id=? AND account_id=?').run(instanceId, accountId);
    });
    tx();
    return { id: instanceId, name: summary.name, deletedChannels: Number(summary.channel_count || 0), deletedTasks: Number(summary.task_count || 0) };
  };

  DB.prototype.listChannels = function listChannelsForAccount(instanceId) {
    const accountId = this.getActiveAccountId();
    if (!accountId) return [];
    return this.db.prepare('SELECT * FROM channels WHERE instance_id=? AND account_id=? ORDER BY id ASC').all(Number(instanceId), accountId);
  };

  DB.prototype.listChannelAssignments = function listChannelAssignmentsForAccount() {
    const accountId = this.getActiveAccountId();
    if (!accountId) return [];
    return this.db.prepare(`
      SELECT c.*, i.name AS instance_name
      FROM channels c
      JOIN instances i ON i.id=c.instance_id AND i.account_id=c.account_id
      WHERE c.account_id=?
      ORDER BY i.id ASC, c.id ASC
    `).all(accountId);
  };

  DB.prototype.moveChannel = function moveChannelForAccount(id, instanceId) {
    const accountId = this.getActiveAccountId();
    if (!accountId) throw new Error('请先登录 QQ');
    const target = this.getInstanceSummary(instanceId);
    const channel = this.db.prepare('SELECT * FROM channels WHERE id=? AND account_id=?').get(Number(id), accountId);
    if (!channel) throw new Error('频道不存在或不属于当前 QQ');
    this.db.prepare('UPDATE channels SET instance_id=? WHERE id=? AND account_id=?').run(Number(instanceId), Number(id), accountId);
    return { id: Number(id), name: channel.name, instanceId: Number(instanceId), instanceName: target.name };
  };

  DB.prototype.addChannel = function addChannelForAccount(instanceId, name, url) {
    const accountId = this.getActiveAccountId();
    const normalizedName = String(name || '').trim();
    const normalizedUrl = String(url || '').trim();
    if (!accountId) throw new Error('请先登录 QQ');
    this.getInstanceSummary(instanceId);
    if (!normalizedName) throw new Error('频道名称不能为空');
    if (!/^https:\/\/pd\.qq\.com\/g\//i.test(normalizedUrl)) throw new Error('腾讯频道 URL 无效');
    return this.db.prepare('INSERT INTO channels(instance_id,account_id,name,url) VALUES (?,?,?,?)').run(Number(instanceId), accountId, normalizedName, normalizedUrl);
  };

  DB.prototype.updateChannelName = function updateChannelNameForAccount(id, name) {
    const accountId = this.getActiveAccountId();
    const normalizedName = String(name || '').trim();
    if (!accountId) throw new Error('请先登录 QQ');
    if (!normalizedName) throw new Error('频道名称不能为空');
    return this.db.prepare('UPDATE channels SET name=? WHERE id=? AND account_id=?').run(normalizedName, Number(id), accountId);
  };

  DB.prototype.deleteChannel = function deleteChannelForAccount(id) {
    const accountId = this.getActiveAccountId();
    if (!accountId) throw new Error('请先登录 QQ');
    const channel = this.db.prepare('SELECT id FROM channels WHERE id=? AND account_id=?').get(Number(id), accountId);
    if (!channel) throw new Error('频道不存在或不属于当前 QQ');
    this.db.prepare('DELETE FROM task_targets WHERE channel_id=?').run(Number(id));
    return this.db.prepare('DELETE FROM channels WHERE id=? AND account_id=?').run(Number(id), accountId);
  };

  DB.prototype.createTask = function createTaskForAccount(instanceId, title, body, mediaPath, channelIds, mediaType = 'video', scheduledAt = null, intervalMinSeconds = null, intervalMaxSeconds = null) {
    const accountId = this.getActiveAccountId();
    if (!accountId) throw new Error('请先登录 QQ');
    this.getInstanceSummary(instanceId);
    const ids = [...new Set((channelIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) throw new Error('至少选择一个频道');
    const placeholders = ids.map(() => '?').join(',');
    const ownedCount = this.db.prepare(`SELECT COUNT(*) AS c FROM channels WHERE account_id=? AND id IN (${placeholders})`).get(accountId, ...ids).c;
    if (ownedCount !== ids.length) throw new Error('目标频道中包含不属于当前 QQ 的频道');

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
      const result = this.db.prepare(`
        INSERT INTO tasks(instance_id,account_id,title,body,media_path,media_type,status,scheduled_at,interval_min_seconds,interval_max_seconds)
        VALUES (?,?,?,?,?,?,'pending',?,?,?)
      `).run(Number(instanceId), accountId, title || '', normalizedBody, type === 'text' ? '' : mediaPath, type, normalizedScheduledAt, minSeconds, maxSeconds);
      const targetInsert = this.db.prepare("INSERT INTO task_targets(task_id,channel_id,status) VALUES (?,?,'pending')");
      for (const channelId of ids) targetInsert.run(result.lastInsertRowid, channelId);
      return result.lastInsertRowid;
    });
    return tx();
  };

  DB.prototype.getTask = function getTaskForAccount(id) {
    const accountId = this.getActiveAccountId();
    if (!accountId) return null;
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=? AND account_id=?').get(Number(id), accountId);
    if (!task) return null;
    task.targets = this.db.prepare(`
      SELECT tt.*, c.name AS channel_name, c.url AS channel_url, c.guild_id, c.guild_number, c.post_channel_id, c.post_channel_name
      FROM task_targets tt JOIN channels c ON c.id=tt.channel_id
      WHERE tt.task_id=? AND c.account_id=? ORDER BY tt.id ASC
    `).all(Number(id), accountId);
    return task;
  };

  DB.prototype.listSettings = function listSettingsWithAccountInfo() {
    const rows = originalListSettings.call(this);
    const account = this.getActiveQQAccount();
    if (account) rows.push({ key: 'active_qq_account_id', value: String(account.id) });
    return rows;
  };

  function newProvisionalIdentity(source, status = {}) {
    const nonce = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    return {
      externalKey: `session:${nonce}`,
      identityType: 'login_session',
      identityValue: nonce,
      identityMeta: JSON.stringify({ source, shape: safeShape(status) })
    };
  }

  async function resolveIdentity(manager, status, options = {}) {
    const direct = findStableIdentity(status);
    if (direct) return direct;

    // 重要：绝不能再使用“加入/管理的频道集合”作为账号唯一标识。
    // 两个 QQ 可能加入完全相同的频道，之前正是因此把第二个 QQ 错认成第一个账号。
    // 新扫码登录但 CLI 未返回稳定用户 ID 时，宁可创建一个新的临时本地账号，也不能复用旧账号数据。
    if (options.freshLogin) return newProvisionalIdentity(options.source || 'fresh-login', status);

    // 同一程序会话内，已经绑定过账号时，login status 只用于续验，不重新猜账号。
    const active = manager.db.getActiveQQAccount?.();
    if (active) {
      return {
        externalKey: active.external_key,
        identityType: active.identity_type,
        identityValue: active.identity_value,
        identityMeta: active.identity_meta || ''
      };
    }

    // 未绑定账号且 status 又没有稳定身份时，禁止自动拿旧账号兜底。
    // 等用户走一次扫码流程，由 poll-token 建立新的隔离工作区。
    manager.db.log('warn', `QQ 登录状态有效，但 CLI 未返回稳定账号ID；未自动绑定旧工作区。status结构=${JSON.stringify(safeShape(status))}`);
    return null;
  }

  BrowserManager.prototype.bindLoggedInQQAccount = async function bindLoggedInQQAccount(status = {}, options = {}) {
    if (!status?.loggedIn && !status?.valid && !status?.alreadyLoggedIn) return status;
    const identity = await resolveIdentity(this, status, options);
    if (!identity) {
      return {
        ...status,
        loggedIn: true,
        accountId: null,
        accountIdentityType: 'unresolved',
        accountBindingRequired: true,
        name: String(status.nickname || status.display_name || status.name || 'QQ账号').trim() || 'QQ账号'
      };
    }
    const displayName = String(status.nickname || status.display_name || status.name || '').trim();
    const account = this.db.activateQQAccount(identity, displayName);
    return {
      ...status,
      loggedIn: true,
      accountId: Number(account.id),
      accountIdentityType: account.identity_type,
      name: displayName || account.display_name || `QQ账号 #${account.id}`
    };
  };

  const originalGetPublishingLoginStatus = BrowserManager.prototype.getPublishingLoginStatus;
  BrowserManager.prototype.getPublishingLoginStatus = async function getPublishingLoginStatusWithAccount() {
    const status = await originalGetPublishingLoginStatus.call(this);
    if (!status?.loggedIn) return status;
    return this.bindLoggedInQQAccount(status, { freshLogin: false, source: 'status' });
  };

  const originalBeginPublishingLogin = BrowserManager.prototype.beginPublishingLogin;
  BrowserManager.prototype.beginPublishingLogin = async function beginPublishingLoginWithAccount() {
    const result = await originalBeginPublishingLogin.call(this);
    if (result?.alreadyLoggedIn || result?.loggedIn || result?.valid) {
      return this.bindLoggedInQQAccount(result, { freshLogin: false, source: 'begin-existing' });
    }
    return result;
  };

  const originalPollPublishingLogin = BrowserManager.prototype.pollPublishingLogin;
  BrowserManager.prototype.pollPublishingLogin = async function pollPublishingLoginWithAccount() {
    const result = await originalPollPublishingLogin.call(this);
    if (result?.loggedIn || result?.valid) {
      return this.bindLoggedInQQAccount(result, { freshLogin: true, source: 'poll-token' });
    }
    return result;
  };
};
