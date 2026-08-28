function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeGuild(item = {}) {
  return {
    guildId: text(item.guild_id ?? item.guildId),
    guildNumber: text(item.guild_number ?? item.guildNumber),
    name: text(item.name ?? item.guild_name ?? item.guildName)
  };
}

function normalizeOwner(member = {}, guild = {}) {
  const user = member.user && typeof member.user === 'object' ? member.user : member;
  return {
    guildId: guild.guildId,
    guildNumber: guild.guildNumber,
    guildName: guild.name,
    tinyId: text(user.tiny_id ?? user.tinyId ?? user.user_id ?? user.userId ?? member.tiny_id ?? member.tinyId),
    nickname: text(user.nickname ?? user.nick ?? user.name ?? member.nickname ?? member.nick ?? member.name)
  };
}

async function getOneCreatedGuild(cli) {
  const data = await cli.run(['manage', 'get-my-join-guild-info', '--json'], {});
  for (const raw of data.created_guilds || []) {
    const guild = normalizeGuild(raw);
    if (guild.guildId) return guild;
  }
  return null;
}

async function getGuildOwner(manager, guild) {
  const cli = manager.getChannelCli();
  let nextPageToken = '';
  for (let page = 0; page < 100; page += 1) {
    const payload = { guild_id: guild.guildId };
    if (nextPageToken) payload.next_page_token = nextPageToken;
    const data = await cli.run(['manage', 'get-guild-member-list', '--json'], payload);

    try {
      manager.db.log(
        'info',
        `[QQ账号诊断] get-guild-member-list 频道=${guild.name || guild.guildNumber || guild.guildId} ` +
        `guild_id=${guild.guildId} page=${page + 1} 原始返回=${JSON.stringify(data)}`
      );
    } catch (_) {}

    const owners = Array.isArray(data.owners) ? data.owners : [];
    const owner = owners.map(member => normalizeOwner(member, guild)).find(item => item.tinyId);
    if (owner) return owner;

    nextPageToken = text(data.next_page_token ?? data.nextPageToken);
    if (!nextPageToken) break;
  }
  return null;
}

async function detectCurrentOwner(manager) {
  const cli = manager.getChannelCli();
  const guild = await getOneCreatedGuild(cli);
  if (!guild) throw new Error('当前账号没有创建过频道，无法识别账号');
  const owner = await getGuildOwner(manager, guild);
  if (!owner) throw new Error(`频道“${guild.name || guild.guildNumber || guild.guildId}”没有读取到频道主`);
  return { ...owner, sampledGuildCount: 1 };
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

  BrowserManager.prototype.bindLoggedInQQAccount = async function bindLoggedInQQAccountByGuildOwner(status = {}, options = {}) {
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
      const detected = await detectCurrentOwner(this);
      const tinyId = detected.tinyId;
      let account = this.db.findQQAccountByAdminTinyId(tinyId);

      if (account) {
        account = this.db.activateExistingQQAccount(account.id, detected.nickname);
        this.db.saveQQAdminIdentity(account.id, tinyId, detected.nickname);
        this.db.log('info', `QQ账号识别：频道主 tiny_id=${tinyId} 命中本地账号 #${account.id}`);
      } else {
        account = this.db.bindAdminTinyIdToLegacyAccountIfNeeded(tinyId, detected.nickname);
        if (account) {
          this.db.log('info', `QQ账号识别：首次启用频道主识别，已将 tiny_id=${tinyId} 绑定到原账号 #${account.id}`);
        } else {
          const identity = {
            externalKey: `owner:${tinyId}`,
            identityType: 'guild_owner_tiny_id',
            identityValue: tinyId,
            identityMeta: JSON.stringify({ guildId: detected.guildId, guildNumber: detected.guildNumber })
          };
          account = this.db.activateQQAccount(identity, detected.nickname);
          this.db.saveQQAdminIdentity(account.id, tinyId, detected.nickname);
          this.db.log('info', `QQ账号识别：频道主 tiny_id=${tinyId} 未命中，创建新账号 #${account.id}`);
        }
      }

      return {
        ...status,
        loggedIn: true,
        accountId: Number(account.id),
        accountIdentityType: 'guild_owner_tiny_id',
        accountBindingRequired: false,
        ownerTinyId: tinyId,
        ownerGuildId: detected.guildId,
        ownerGuildNumber: detected.guildNumber,
        sampledGuildCount: 1,
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
