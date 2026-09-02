const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let cliQueue = Promise.resolve();

function text(value) {
  return String(value == null ? '' : value).trim();
}

function exists(target) {
  try { return fs.existsSync(target); } catch (_) { return false; }
}

function remove(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
}

function copyDir(source, target) {
  if (!exists(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

function parseLastJson(output) {
  const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch (_) {}
  }
  return null;
}

function findCli() {
  const platformPackage = process.platform === 'win32'
    ? 'tencent-channel-cli-win32-x64'
    : `tencent-channel-cli-${process.platform}-${process.arch}`;
  const executable = process.platform === 'win32' ? 'tencent-channel-cli.exe' : 'tencent-channel-cli';
  const candidates = [process.env.TENCENT_CHANNEL_CLI];

  try {
    const packageJson = require.resolve(`${platformPackage}/package.json`);
    candidates.push(path.join(path.dirname(packageJson), 'bin', executable));
  } catch (_) {}

  const projectRoot = path.resolve(__dirname, '..', '..');
  candidates.push(
    path.join(projectRoot, 'node_modules', platformPackage, 'bin', executable),
    path.join(projectRoot, 'node_modules', 'tencent-channel-cli', 'node_modules', platformPackage, 'bin', executable)
  );

  if (process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
    candidates.push(
      path.join(unpacked, platformPackage, 'bin', executable),
      path.join(unpacked, 'tencent-channel-cli', 'node_modules', platformPackage, 'bin', executable)
    );
  }

  if (process.env.APPDATA) {
    candidates.push(
      path.join(process.env.APPDATA, 'npm', 'node_modules', 'tencent-channel-cli', 'node_modules', platformPackage, 'bin', executable),
      path.join(process.env.APPDATA, 'npm', 'tencent-channel-cli.cmd')
    );
  }

  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    candidates.push(path.join(directory, process.platform === 'win32' ? 'tencent-channel-cli.cmd' : 'tencent-channel-cli'));
    candidates.push(path.join(directory, executable));
  }

  return [...new Set(candidates.filter(Boolean).map(candidate => {
    const normalized = path.normalize(candidate);
    return normalized.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  }))].find(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch (_) { return false; }
  }) || '';
}

function instanceAccountCandidates(manager, instanceId) {
  const id = Number(instanceId);
  const row = manager.db?.db?.prepare?.('SELECT * FROM instances WHERE id=?')?.get(id) || null;
  const legacyAccountId = Number(row?.account_id || 0);
  const ids = [...new Set([legacyAccountId, id].filter(value => Number.isInteger(value) && value > 0))];
  return ids.map(accountId => path.join(manager.userDataPath, 'qq-accounts', String(accountId)));
}

function findIsolatedCliHome(manager, instanceId) {
  return instanceAccountCandidates(manager, instanceId).find(home => exists(path.join(home, '.qqcli'))) || '';
}

function cliEnvironment(home) {
  const env = { ...process.env };
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const xdgConfig = path.join(home, '.config');
  const xdgData = path.join(home, '.local', 'share');
  for (const directory of [home, appData, localAppData, xdgConfig, xdgData]) fs.mkdirSync(directory, { recursive: true });
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  env.XDG_CONFIG_HOME = xdgConfig;
  env.XDG_DATA_HOME = xdgData;
  env.QQCLI_HOME = home;
  env.QQCLI_CONFIG_DIR = path.join(home, '.qqcli');
  env.TENCENT_CHANNEL_CLI_HOME = home;
  delete env.QQCLI_TOKEN;
  delete env.QQ_CHANNEL_TOKEN;
  delete env.TENCENT_CHANNEL_TOKEN;
  return env;
}

function executeCli(cliPath, home, args, payload = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let command = cliPath;
    let commandArgs = args;
    if (process.platform === 'win32' && /\.cmd$/i.test(cliPath)) {
      command = process.env.ComSpec || 'cmd.exe';
      commandArgs = ['/d', '/s', '/c', [`"${cliPath}"`, ...args].join(' ')];
    }
    const child = spawn(command, commandArgs, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cliEnvironment(home),
      cwd: home
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error(`频道归属接口执行超时（${Math.round(timeoutMs / 1000)}秒）`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (payload == null) child.stdin.end();
    else child.stdin.end(JSON.stringify(payload));
  });
}

async function runCliIsolated(manager, instanceId, args, payload = null, timeoutMs = 30000) {
  const home = findIsolatedCliHome(manager, instanceId);
  if (!home) return { available: false, reason: '当前实例没有旧版频道接口授权缓存' };
  const cliPath = findCli();
  if (!cliPath) return { available: false, reason: '未找到 tencent-channel-cli' };

  const work = async () => {
    const accountQqcli = path.join(home, '.qqcli');
    const realQqcli = path.join(os.homedir(), '.qqcli');
    const backupQqcli = path.join(os.homedir(), `.qqcli.qqchannel-owner-backup-${process.pid}`);

    if (exists(backupQqcli)) {
      remove(realQqcli);
      try { fs.renameSync(backupQqcli, realQqcli); } catch (_) { copyDir(backupQqcli, realQqcli); remove(backupQqcli); }
    }

    const hadGlobal = exists(realQqcli);
    if (hadGlobal) {
      try { fs.renameSync(realQqcli, backupQqcli); }
      catch (_) { copyDir(realQqcli, backupQqcli); remove(realQqcli); }
    }

    remove(realQqcli);
    copyDir(accountQqcli, realQqcli);

    try {
      const completed = await executeCli(cliPath, home, args, payload, timeoutMs);
      const response = parseLastJson(completed.stdout);
      if (completed.code === 0 && response?.success) return { available: true, data: response.data || {} };
      const detail = text(response?.message || response?.error?.message || response?.error || completed.stderr || completed.stdout);
      return { available: false, reason: detail || `接口退出码 ${completed.code}` };
    } finally {
      remove(accountQqcli);
      if (exists(realQqcli)) copyDir(realQqcli, accountQqcli);
      remove(realQqcli);
      if (hadGlobal && exists(backupQqcli)) {
        try { fs.renameSync(backupQqcli, realQqcli); }
        catch (_) { copyDir(backupQqcli, realQqcli); remove(backupQqcli); }
      } else {
        remove(backupQqcli);
      }
    }
  };

  const queued = cliQueue.then(work, work);
  cliQueue = queued.catch(() => {});
  return queued;
}

function normalizeGuild(item = {}, source = '') {
  return {
    guildId: text(item.guild_id ?? item.guildId),
    guildNumber: text(item.guild_number ?? item.guildNumber),
    name: text(item.name ?? item.guild_name ?? item.guildName),
    source
  };
}

function ownerTinyId(member = {}) {
  const user = member.user && typeof member.user === 'object' ? member.user : member;
  return text(user.tiny_id ?? user.tinyId ?? user.user_id ?? user.userId ?? member.tiny_id ?? member.tinyId);
}

async function firstCreatedGuildOwner(manager, instanceId, createdGuilds) {
  for (const guild of createdGuilds) {
    if (!guild.guildId) continue;
    let nextPageToken = '';
    for (let page = 0; page < 20; page += 1) {
      const payload = { guild_id: guild.guildId };
      if (nextPageToken) payload.next_page_token = nextPageToken;
      const response = await runCliIsolated(manager, instanceId, ['manage', 'get-guild-member-list', '--json'], payload, 30000);
      if (!response.available) break;
      const owners = Array.isArray(response.data?.owners) ? response.data.owners : [];
      const tinyId = owners.map(ownerTinyId).find(Boolean);
      if (tinyId) return { tinyId, guild };
      nextPageToken = text(response.data?.next_page_token ?? response.data?.nextPageToken);
      if (!nextPageToken) break;
    }
  }
  return null;
}

async function readOwnership(manager, instanceId) {
  const login = await runCliIsolated(manager, instanceId, ['login', 'status', '--json'], null, 15000);
  if (!login.available || !login.data?.valid) {
    return { available: false, reason: login.reason || '频道接口授权已失效' };
  }

  const response = await runCliIsolated(manager, instanceId, ['manage', 'get-my-join-guild-info', '--json'], {}, 30000);
  if (!response.available) return response;

  const created = (response.data?.created_guilds || []).map(item => normalizeGuild(item, 'created'));
  const managed = (response.data?.managed_guilds || []).map(item => normalizeGuild(item, 'managed'));
  const joined = (response.data?.joined_guilds || []).map(item => normalizeGuild(item, 'joined'));
  const owner = await firstCreatedGuildOwner(manager, instanceId, created).catch(() => null);

  const byNumber = new Map();
  const byName = new Map();
  const add = (guild, status, label) => {
    const value = {
      status,
      label,
      source: guild.source,
      guildId: guild.guildId,
      guildNumber: guild.guildNumber,
      ownerTinyId: status === 'owned' ? text(owner?.tinyId) : ''
    };
    if (guild.guildNumber) byNumber.set(guild.guildNumber.toLowerCase(), value);
    if (guild.name && !byName.has(guild.name)) byName.set(guild.name, value);
  };
  created.forEach(guild => add(guild, 'owned', '我创建的'));
  managed.forEach(guild => add(guild, 'not_owned', '我管理的'));
  joined.forEach(guild => add(guild, 'not_owned', '普通加入'));

  return {
    available: true,
    byNumber,
    byName,
    ownerTinyId: text(owner?.tinyId),
    ownerVerified: Boolean(owner?.tinyId),
    counts: { created: created.length, managed: managed.length, joined: joined.length }
  };
}

module.exports = function installChannelOwnerFilterSupport(DB, BrowserManager) {
  const originalInit = DB.prototype.init;
  DB.prototype.init = function initChannelOwnership() {
    originalInit.call(this);
    this.ensureColumn('channels', 'ownership_status', "TEXT NOT NULL DEFAULT 'unknown'");
    this.ensureColumn('channels', 'owner_tiny_id', 'TEXT');
    this.ensureColumn('channels', 'ownership_checked_at', 'TEXT');
  };

  DB.prototype.saveChannelOwnership = function saveChannelOwnership(instanceId, item = {}) {
    const status = ['owned', 'not_owned'].includes(String(item.status || '')) ? String(item.status) : 'unknown';
    if (status === 'unknown') return { changes: 0 };
    const guildNumber = text(item.guildNumber);
    const url = text(item.url);
    return this.db.prepare(`
      UPDATE channels
      SET ownership_status=?, owner_tiny_id=?, ownership_checked_at=CURRENT_TIMESTAMP
      WHERE instance_id=? AND (
        (?<>'' AND COALESCE(guild_number,'')=?) OR
        (?<>'' AND url=?)
      )
    `).run(status, text(item.ownerTinyId), Number(instanceId), guildNumber, guildNumber, url, url);
  };

  const originalImportRemoteChannels = DB.prototype.importRemoteChannels;
  DB.prototype.importRemoteChannels = function importRemoteChannelsWithOwnership(instanceId, channels = []) {
    const result = originalImportRemoteChannels.call(this, instanceId, channels);
    for (const item of channels || []) {
      const status = text(item?.ownershipStatus);
      if (!['owned', 'not_owned'].includes(status)) continue;
      this.saveChannelOwnership(instanceId, {
        status,
        ownerTinyId: item?.ownerTinyId,
        guildNumber: item?.guildNumber,
        url: item?.url
      });
    }
    return result;
  };

  const previousCollectChannels = BrowserManager.prototype.collectChannels;
  BrowserManager.prototype.collectChannels = async function collectChannelsWithOwnership(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const rows = await previousCollectChannels.call(this, id);
    const ownership = await readOwnership(this, id).catch(error => ({ available: false, reason: String(error?.message || error) }));

    if (!ownership.available) {
      this.db.log('info', `实例 #${id} 频道归属：owners 接口不可用，保留全部频道为 unknown（${ownership.reason || '无授权'}）`);
      return rows.map(item => ({ ...item, ownershipStatus: 'unknown', ownerTinyId: '', ownershipSource: 'unknown' }));
    }

    const counts = ownership.counts || {};
    this.db.log(
      'info',
      `实例 #${id} 频道归属：接口返回 created=${Number(counts.created || 0)} managed=${Number(counts.managed || 0)} joined=${Number(counts.joined || 0)}；owners ${ownership.ownerVerified ? '已确认当前账号' : '未返回可用 tiny_id'}`
    );

    return rows.map(item => {
      const guildNumber = text(item.guildNumber || item.url?.match?.(/\/g\/([^/?#]+)/i)?.[1]).toLowerCase();
      const meta = (guildNumber && ownership.byNumber.get(guildNumber)) || ownership.byName.get(text(item.name)) || null;
      if (!meta) return { ...item, ownershipStatus: 'unknown', ownerTinyId: '', ownershipSource: 'api-unmatched' };

      const enriched = {
        ...item,
        guildId: meta.guildId || item.guildId,
        guildNumber: meta.guildNumber || item.guildNumber,
        ownershipStatus: meta.status,
        ownerTinyId: meta.ownerTinyId || '',
        ownershipSource: ownership.ownerVerified ? 'owners+guild-list' : 'guild-list',
        source: meta.status === 'owned' ? 'owner' : meta.source,
        sourceLabel: meta.label,
        selectable: meta.status === 'owned'
      };
      this.db.saveChannelOwnership(id, {
        status: meta.status,
        ownerTinyId: meta.ownerTinyId,
        guildNumber: enriched.guildNumber,
        url: enriched.url
      });
      return enriched;
    });
  };
};