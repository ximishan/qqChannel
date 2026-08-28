const crypto = require('crypto');

const ADMIN_ROLE_RE = /管理员|频道主|创建者|群主|owner|admin/i;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function isAdminMember(member = {}) {
  const roleId = text(member.role_id ?? member.roleId);
  const roleName = text(member.role_name ?? member.roleName ?? member.title);
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
    guildId: guild.guildId,
    guildNumber: guild.guildNumber,
    guildName: guild.name,
    tinyId: text(member.tiny_id ?? member.tinyId ?? member.user_id ?? member.userId),
    nickname: text(member.nickname ?? member.nick ?? member.name),
    roleId: text(member.role_id ?? member.roleId),
    roleName: text(member.role_name ?? member.roleName ?? member.title)
  };
}

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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

async function getSingleGuildAdmin(cli, guild) {
  let nextToken = '';
  for (let page = 0; page < 100; page += 1) {
    const payload = { guild_id: guild.guildId };
    if (nextToken) payload.next_token = nextToken;
    const data = await cli.run(['manage', 'get-guild-member-list', '--json'], payload);
    const members = data.members || data.member_list || data.memberList || [];
    const admins = members.filter(isAdminMember).map(member => normalizeAdmin(member, guild)).filter(item => item.tinyId);
    if (admins.length) return admins[0];
    const finished = Boolean(data.finished ?? data.is_finished ?? data.isFinished);
    nextToken = text(data.next_token ?? data.nextToken);
    if (finished || !nextToken) break;
  }
  return null;
}

async function detectCurrentAdmin(manager) {
  const cli = manager.getChannelCli();
  const guilds = await listManagedGuilds(cli);
  if (!guilds.length) throw new Error('当前账号没有可管理的频道');

  const sampleSize = Math.min(guilds.length, guilds.length >= 3 ? 3 : guilds.length);
  const sampledGuilds = shuffle(guilds).slice(0, sampleSize);
  const admins = [];
  for (const guild of sampledGuilds) {
    const admin = await getSingleGuildAdmin(cli, guild);
    if (!admin) throw new Error(`频道“${guild.name || guild.guildNumber || guild.guildId}”没有读取到管理员`);
    admins.push(admin);
  }

  const tinyIds = [...new Set(admins.map(item => item.tinyId).filter(Boolean))];
  if (tinyIds.length !== 1) {
    throw new Error(`抽取的 ${admins.length} 个频道管理员不一致，无法识别当前账号`);
  }

  return {
    tinyId: tinyIds[0],
    nickname: admins.find(item => item.nickname)?.nickname || '',
    admins,
    sampledGuildCount: sampledGuilds.length,
    managedGuildCount: guilds.length
  };
}

module.exports = function installAccountAdminFingerprintSupport(DB, BrowserManager) {
  if (DB.prototype.__accountAdminFingerprintSupportInstalled) return;
  DB.prototype.__accountAdminFingerprintSupportInstalled = true;

  const originalInit = DB.prototype.init;
  DB.prototype.init = function initAccountAdminFingerprintSupport() {
    originalInit.call(this);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS qq_account_admin_identity (
        account_id INTEGER NOT NULL UNIQUE,
        tiny_id TEXT NOT NULL UNIQUE,
        nickname TEXT,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_qq_admin_identity_tiny_id
        ON qq_account_admin_identity(tiny_id);
    `);
  };

  DB.prototype.findQQAccountByAdminTinyId = function findQQAccountByAdminTinyId(tinyId) {
    const row = this.db.prepare(`
      SELECT q.* FROM qq_account_admin_identity i
      JOIN qq_accounts q ON q.id=i.account_id
      WHERE i.tiny_id=?
    `).get(text(tinyId));
    return row || null;
  };

  DB.prototype.saveQQAdminIdentity = function saveQQAdminIdentity(accountId, tinyId, nickname = '') {
    this.db.prepare(`
      INSERT INTO qq_account_admin_identity(account_id,tiny_id,nickname,last_seen_at)
      VALUES (?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(account_id) DO UPDATE SET
        tiny_id=excluded.tiny_id,
        nickname=CASE WHEN excluded.nickname<>'' THEN excluded.nickname ELSE qq_account_admin_identity.nickname END,
        last_seen_at=CURRENT_TIMESTAMP
    `).run(Number(accountId), text(tinyId), text(nickname));
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

  DB.prototype.bindAdminTinyIdToLegacyAccountIfNeeded = function bindAdminTinyIdToLegacyAccountIfNeeded(tinyId, nickname = '') {
    const identityCount = Number(this.db.prepare('SELECT COUNT(*) AS c FROM qq_account_admin_identity').get().c || 0);
    if (identityCount) return null;
    const accounts = this.db.prepare('SELECT * FROM qq_accounts ORDER BY id ASC').all();
    if (accounts.length !== 1) return null;
    const account = this.activateExistingQQAccount(accounts[0].id, nickname);
    this.saveQQAdminIdentity(account.id, tinyId, nickname);
    return account;
  };

  BrowserManager.prototype.bindLoggedInQQAccount = async function bindLoggedInQQAccountByAdminTinyId(status = {}, options = {}) {
    if (!status?.loggedIn && !status?.valid && !status?.alreadyLoggedIn) return status;

    const active = this.db.getActiveQQAccount?.();
    const shouldIdentify = Boolean(options.freshLogin) || !active;
    if (!shouldIdentify) {
      return {
        ...status,
        loggedIn: true,
        accountId: Number(active.id),
        accountIdentityType: active.identity_type,
        name: active.display_name || `QQ账号 #${active.id}`
      };
    }

    try {
      const detected = await detectCurrentAdmin(this);
      const tinyId = detected.tinyId;
      let account = this.db.findQQAccountByAdminTinyId(tinyId);

      if (account) {
        account = this.db.activateExistingQQAccount(account.id, detected.nickname);
        this.db.saveQQAdminIdentity(account.id, tinyId, detected.nickname);
        this.db.log('info', `QQ账号识别：管理员 tiny_id=${tinyId} 命中本地账号 #${account.id}`);
      } else {
        account = this.db.bindAdminTinyIdToLegacyAccountIfNeeded(tinyId, detected.nickname);
        if (account) {
          this.db.log('info', `QQ账号识别：首次启用管理员识别，已将 tiny_id=${tinyId} 绑定到原账号 #${account.id}`);
        } else {
          const identity = {
            externalKey: `admin:${tinyId}`,
            identityType: 'guild_admin_tiny_id',
            identityValue: tinyId,
            identityMeta: JSON.stringify({ sampledGuildCount: detected.sampledGuildCount })
          };
          account = this.db.activateQQAccount(identity, detected.nickname);
          this.db.saveQQAdminIdentity(account.id, tinyId, detected.nickname);
          this.db.log('info', `QQ账号识别：管理员 tiny_id=${tinyId} 未命中，创建新账号 #${account.id}`);
        }
      }

      return {
        ...status,
        loggedIn: true,
        accountId: Number(account.id),
        accountIdentityType: 'guild_admin_tiny_id',
        accountBindingRequired: false,
        adminTinyId: tinyId,
        sampledGuildCount: detected.sampledGuildCount,
        managedGuildCount: detected.managedGuildCount,
        name: detected.nickname || account.display_name || `QQ账号 #${account.id}`
      };
    } catch (error) {
      this.db.log('warn', `QQ账号识别失败：${String(error?.message || error)}`);
      return {
        ...status,
        loggedIn: true,
        accountId: null,
        accountIdentityType: 'unresolved',
        accountBindingRequired: true,
        message: `QQ已登录，但账号识别失败：${String(error?.message || error)}`,
        name: 'QQ账号'
      };
    }
  };
};
