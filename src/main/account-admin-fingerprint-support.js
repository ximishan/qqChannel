const crypto = require('crypto');

const ADMIN_ROLE_RE = /管理员|频道主|创建者|群主|owner|admin/i;
const MAX_MEMBER_PAGES = 100;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function isAdminMember(member = {}) {
  const roleId = text(member.role_id ?? member.roleId);
  const roleName = text(member.role_name ?? member.roleName ?? member.title);
  // QQ频道默认管理员权限组通常为 2；同时兼容自定义管理员角色名。
  return roleId === '2' || ADMIN_ROLE_RE.test(roleName);
}

function normalizeGuild(item = {}) {
  return {
    guildId: text(item.guild_id ?? item.guildId),
    guildNumber: text(item.guild_number ?? item.guildNumber),
    name: text(item.name ?? item.guild_name ?? item.guildName)
  };
}

function normalizeAdmin(member = {}, guild = {}) {
  return {
    guildId: text(guild.guildId),
    guildNumber: text(guild.guildNumber),
    guildName: text(guild.name),
    tinyId: text(member.tiny_id ?? member.tinyId ?? member.user_id ?? member.userId),
    nickname: text(member.nickname ?? member.nick ?? member.name),
    roleId: text(member.role_id ?? member.roleId),
    roleName: text(member.role_name ?? member.roleName ?? member.title)
  };
}

function fingerprintKey(item) {
  return `${item.guildId}:${item.tinyId}`;
}

function identityFromAdmins(admins) {
  const source = [...new Set(admins.map(fingerprintKey).filter(Boolean))].sort().join('|');
  const hash = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  return {
    externalKey: `guild-admin:${hash}`,
    identityType: 'guild_admin_fingerprint',
    identityValue: hash,
    identityMeta: JSON.stringify({ adminCount: admins.length })
  };
}

async function listManagedGuilds(cli) {
  const data = await cli.run(['manage', 'get-my-join-guild-info', '--json'], {});
  const out = [];
  const seen = new Set();
  for (const groupName of ['created_guilds', 'managed_guilds']) {
    for (const raw of data[groupName] || []) {
      const guild = normalizeGuild(raw);
      if (!guild.guildId || seen.has(guild.guildId)) continue;
      seen.add(guild.guildId);
      out.push(guild);
    }
  }
  return out;
}

async function listGuildAdmins(cli, guild) {
  const admins = [];
  let nextToken = '';
  for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
    const payload = { guild_id: guild.guildId };
    if (nextToken) payload.next_token = nextToken;
    const data = await cli.run(['manage', 'get-guild-member-list', '--json'], payload);
    const members = data.members || data.member_list || data.memberList || [];
    for (const member of members) {
      if (!isAdminMember(member)) continue;
      const admin = normalizeAdmin(member, guild);
      if (admin.tinyId) admins.push(admin);
    }
    const finished = Boolean(data.finished ?? data.is_finished ?? data.isFinished);
    nextToken = text(data.next_token ?? data.nextToken);
    if (finished || !nextToken) break;
  }
  return admins;
}

async function collectAdminFingerprint(manager) {
  const cli = manager.getChannelCli();
  const guilds = await listManagedGuilds(cli);
  const all = [];
  for (const guild of guilds) {
    const admins = await listGuildAdmins(cli, guild);
    all.push(...admins);
  }
  const unique = new Map();
  for (const item of all) unique.set(fingerprintKey(item), item);
  return { guilds, admins: [...unique.values()] };
}

function bestDisplayName(admins, fallback = '') {
  const counts = new Map();
  for (const admin of admins) {
    if (!admin.tinyId) continue;
    const current = counts.get(admin.tinyId) || { count: 0, nickname: admin.nickname };
    current.count += 1;
    if (!current.nickname && admin.nickname) current.nickname = admin.nickname;
    counts.set(admin.tinyId, current);
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return text(best?.nickname || fallback);
}

module.exports = function installAccountAdminFingerprintSupport(DB, BrowserManager) {
  if (DB.prototype.__accountAdminFingerprintSupportInstalled) return;
  DB.prototype.__accountAdminFingerprintSupportInstalled = true;

  const originalInit = DB.prototype.init;
  DB.prototype.init = function initAccountAdminFingerprintSupport() {
    originalInit.call(this);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS qq_account_admin_fingerprints (
        account_id INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        guild_number TEXT,
        guild_name TEXT,
        tiny_id TEXT NOT NULL,
        nickname TEXT,
        role_id TEXT,
        role_name TEXT,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(account_id, guild_id, tiny_id)
      );
      CREATE INDEX IF NOT EXISTS idx_qq_admin_fp_lookup
        ON qq_account_admin_fingerprints(guild_id, tiny_id);
    `);
  };

  DB.prototype.findQQAccountByAdminFingerprint = function findQQAccountByAdminFingerprint(admins = []) {
    if (!admins.length) return null;
    const score = new Map();
    for (const admin of admins) {
      if (!admin.guildId || !admin.tinyId) continue;
      const rows = this.db.prepare(`
        SELECT account_id FROM qq_account_admin_fingerprints
        WHERE guild_id=? AND tiny_id=?
      `).all(admin.guildId, admin.tinyId);
      for (const row of rows) {
        const accountId = Number(row.account_id);
        score.set(accountId, (score.get(accountId) || 0) + 1);
      }
    }
    if (!score.size) return null;
    const [accountId, matches] = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
    const account = this.db.prepare('SELECT * FROM qq_accounts WHERE id=?').get(accountId);
    return account ? { account, matches } : null;
  };

  DB.prototype.saveQQAdminFingerprint = function saveQQAdminFingerprint(accountId, admins = []) {
    const id = Number(accountId);
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM qq_account_admin_fingerprints WHERE account_id=?').run(id);
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO qq_account_admin_fingerprints
          (account_id,guild_id,guild_number,guild_name,tiny_id,nickname,role_id,role_name,last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      `);
      for (const admin of admins) {
        if (!admin.guildId || !admin.tinyId) continue;
        insert.run(id, admin.guildId, admin.guildNumber || '', admin.guildName || '', admin.tinyId,
          admin.nickname || '', admin.roleId || '', admin.roleName || '');
      }
    });
    tx();
  };

  DB.prototype.activateExistingQQAccount = function activateExistingQQAccount(accountId, displayName = '') {
    const id = Number(accountId);
    const account = this.db.prepare('SELECT * FROM qq_accounts WHERE id=?').get(id);
    if (!account) throw new Error('本地 QQ 账号不存在');
    const name = text(displayName);
    this.db.prepare(`
      UPDATE qq_accounts
      SET display_name=CASE WHEN ?<>'' THEN ? ELSE display_name END,
          last_seen_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(name, name, id);
    const groupCount = this.db.prepare('SELECT COUNT(*) AS c FROM instances WHERE account_id=?').get(id).c;
    if (!groupCount) this.db.prepare('INSERT INTO instances(name,account_id) VALUES (?,?)').run('默认频道分组', id);
    this.setSetting('active_qq_account_id', String(id));
    this.setSetting('task_list_group_filter', '0');
    this.setSetting('task_list_channel_search', '');
    return this.db.prepare('SELECT * FROM qq_accounts WHERE id=?').get(id);
  };

  const originalBindLoggedInQQAccount = BrowserManager.prototype.bindLoggedInQQAccount;
  BrowserManager.prototype.bindLoggedInQQAccount = async function bindLoggedInQQAccountByAdminFingerprint(status = {}, options = {}) {
    if (!status?.loggedIn && !status?.valid && !status?.alreadyLoggedIn) {
      return originalBindLoggedInQQAccount.call(this, status, options);
    }

    const active = this.db.getActiveQQAccount?.();
    const shouldIdentify = Boolean(options.freshLogin) || !active;
    if (!shouldIdentify) return originalBindLoggedInQQAccount.call(this, status, options);

    try {
      const snapshot = await collectAdminFingerprint(this);
      if (snapshot.admins.length) {
        const matched = this.db.findQQAccountByAdminFingerprint(snapshot.admins);
        const fallbackName = text(status.nickname || status.display_name || status.name || '');
        const displayName = bestDisplayName(snapshot.admins, fallbackName);
        let account;
        let matchCount = 0;

        if (matched?.account) {
          account = this.db.activateExistingQQAccount(matched.account.id, displayName);
          matchCount = Number(matched.matches || 0);
          this.db.log('info', `QQ账号识别：管理员指纹命中本地账号 #${account.id}，匹配 ${matchCount} 项`);
        } else {
          const identity = identityFromAdmins(snapshot.admins);
          account = this.db.activateQQAccount(identity, displayName);
          this.db.log('info', `QQ账号识别：未找到已有管理员指纹，创建本地账号 #${account.id}`);
        }

        this.db.saveQQAdminFingerprint(account.id, snapshot.admins);
        return {
          ...status,
          loggedIn: true,
          accountId: Number(account.id),
          accountIdentityType: 'guild_admin_fingerprint',
          accountBindingRequired: false,
          adminFingerprintMatches: matchCount,
          adminFingerprintCount: snapshot.admins.length,
          managedGuildCount: snapshot.guilds.length,
          name: displayName || account.display_name || `QQ账号 #${account.id}`
        };
      }

      this.db.log('warn', 'QQ账号识别：已登录，但管理/创建的频道中没有读取到管理员成员，回退到原账号识别逻辑');
    } catch (error) {
      this.db.log('warn', `QQ账号识别：管理员指纹读取失败，回退到原账号识别逻辑：${String(error?.message || error)}`);
    }

    return originalBindLoggedInQQAccount.call(this, status, options);
  };
};
