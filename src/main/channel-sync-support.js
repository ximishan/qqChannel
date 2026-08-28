const { app, ipcMain } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const { getActiveAccountId, getAccountCli } = require('./multi-account-support');

function getCli() {
  const accountId = getActiveAccountId();
  if (!accountId) throw new Error('请先选择QQ账号');
  return getAccountCli(app.getPath('userData'), accountId);
}

function openDb() {
  return new Database(path.join(app.getPath('userData'), 'publisher.db'));
}

function normalizeRemoteGuilds(data = {}) {
  const sourceMeta = {
    created_guilds: { source: 'created', sourceLabel: '我创建的', selectable: true, priority: 3 },
    managed_guilds: { source: 'managed', sourceLabel: '我管理的', selectable: true, priority: 2 },
    joined_guilds: { source: 'joined', sourceLabel: '普通加入', selectable: false, priority: 1 }
  };
  const byId = new Map();
  for (const key of Object.keys(sourceMeta)) {
    const meta = sourceMeta[key];
    for (const item of data[key] || []) {
      const guildId = String(item.guild_id || '').trim();
      if (!guildId) continue;
      const previous = byId.get(guildId);
      if (previous && previous.priority >= meta.priority) continue;
      const guildNumber = String(item.guild_number || '').trim();
      byId.set(guildId, {
        guildId,
        guildNumber,
        name: String(item.name || '未命名频道').trim() || '未命名频道',
        role: String(item.role || '').trim(),
        source: meta.source,
        sourceLabel: meta.sourceLabel,
        selectable: meta.selectable,
        priority: meta.priority,
        url: guildNumber ? `https://pd.qq.com/g/${guildNumber}` : ''
      });
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name, 'zh-CN'))
    .map(({ priority, ...item }) => item);
}

async function fetchRemoteGuilds() {
  const channelCli = getCli();
  const login = await channelCli.loginStatus();
  if (!login.loggedIn) throw new Error('当前QQ账号未登录或授权已失效，请先点击“登录QQ”完成扫码授权');
  const data = await channelCli.run(['manage', 'get-my-join-guild-info', '--json'], {});
  return normalizeRemoteGuilds(data);
}

async function importGuilds(instanceId, guilds = []) {
  const normalizedInstanceId = Number(instanceId);
  const accountId = getActiveAccountId();
  if (!accountId) throw new Error('请先选择QQ账号');
  if (!Number.isInteger(normalizedInstanceId) || normalizedInstanceId <= 0) throw new Error('请选择要导入到的频道分组');
  if (!Array.isArray(guilds) || !guilds.length) throw new Error('请至少选择一个频道');

  const db = openDb();
  try {
    const instance = db.prepare('SELECT id,name,account_id FROM instances WHERE id=? AND account_id=?').get(normalizedInstanceId, accountId);
    if (!instance) throw new Error('目标频道分组不存在，或不属于当前QQ账号');

    const channelCli = getCli();
    const insert = db.prepare(`
      INSERT INTO channels(instance_id,name,url,enabled,guild_id,guild_number,post_channel_id,post_channel_name)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    const update = db.prepare(`
      UPDATE channels
      SET name=?, url=?, enabled=1, guild_id=?, guild_number=?, post_channel_id=?, post_channel_name=?
      WHERE id=?
    `);
    const findByGuild = db.prepare(`
      SELECT c.*, i.name AS instance_name
      FROM channels c
      JOIN instances i ON i.id=c.instance_id
      WHERE i.account_id=?
        AND (c.guild_id=? OR (c.guild_number<>'' AND c.guild_number=?))
      ORDER BY CASE WHEN c.instance_id=? THEN 0 ELSE 1 END, c.id ASC
      LIMIT 1
    `);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const details = [];

    for (const item of guilds) {
      const guildId = String(item.guildId || '').trim();
      const guildNumber = String(item.guildNumber || '').trim();
      const name = String(item.name || '未命名频道').trim() || '未命名频道';
      if (!guildId) {
        skipped += 1;
        details.push({ name, status: 'skipped', message: '缺少频道ID' });
        continue;
      }

      const boards = await channelCli.listChannels(guildId, true);
      const preferred = boards.find(board => board.name === '全部') || boards[0];
      if (!preferred) {
        skipped += 1;
        details.push({ name, status: 'skipped', message: '没有可发布的帖子版块' });
        continue;
      }

      const url = guildNumber ? `https://pd.qq.com/g/${guildNumber}` : `https://pd.qq.com/g/${guildId}`;
      const existing = findByGuild.get(accountId, guildId, guildNumber, normalizedInstanceId);
      if (existing) {
        update.run(name, url, guildId, guildNumber, preferred.channelId, preferred.name, existing.id);
        updated += 1;
        details.push({
          name,
          status: 'updated',
          message: existing.instance_id === normalizedInstanceId
            ? `已更新到${instance.name}`
            : `已存在于频道分组“${existing.instance_name}”，已更新原绑定`
        });
      } else {
        insert.run(normalizedInstanceId, name, url, 1, guildId, guildNumber, preferred.channelId, preferred.name);
        created += 1;
        details.push({ name, status: 'created', message: `已导入到频道分组“${instance.name}”` });
      }
    }

    return { created, updated, skipped, total: guilds.length, instanceName: instance.name, details };
  } finally {
    db.close();
  }
}

ipcMain.handle('channels:remoteList', async () => fetchRemoteGuilds());
ipcMain.handle('channels:importRemote', async (_, data) => importGuilds(data?.instanceId, data?.guilds || []));

module.exports = { normalizeRemoteGuilds };
