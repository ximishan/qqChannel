function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalizedName(value) {
  return text(value).replace(/\s+/g, '').toLowerCase();
}

function parseJsonBody(body) {
  const raw = text(body);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function walkObjects(value, visit, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit, depth + 1);
    return;
  }
  for (const child of Object.values(value)) walkObjects(child, visit, depth + 1);
}

function normalizeGuild(item = {}, source = '') {
  return {
    guildId: text(item.guild_id ?? item.guildId ?? item.id),
    guildNumber: text(item.guild_number ?? item.guildNumber ?? item.number),
    name: text(item.name ?? item.guild_name ?? item.guildName),
    source
  };
}

function normalizeOwner(member = {}) {
  const user = member.user && typeof member.user === 'object' ? member.user : member;
  return {
    tinyId: text(
      user.tinyid ?? user.tiny_id ?? user.tinyId ?? user.user_id ?? user.userId ??
      member.tinyid ?? member.tiny_id ?? member.tinyId
    ),
    nickname: text(
      user['昵称'] ?? user.nickname ?? user.nick ?? user.name ??
      member['昵称'] ?? member.nickname ?? member.nick ?? member.name
    )
  };
}

function extractGuildIdFromRequest(meta = {}) {
  const url = text(meta.url);
  try {
    const parsed = new URL(url);
    for (const key of ['guild_id', 'guildId', 'guildid']) {
      const value = text(parsed.searchParams.get(key));
      if (value) return value;
    }
  } catch (_) {}

  const postData = text(meta.postData);
  if (!postData) return '';
  try {
    const payload = JSON.parse(postData);
    const direct = text(payload.guild_id ?? payload.guildId ?? payload.guildid);
    if (direct) return direct;
    let found = '';
    walkObjects(payload, object => {
      if (found || Array.isArray(object)) return;
      found = text(object.guild_id ?? object.guildId ?? object.guildid);
    });
    if (found) return found;
  } catch (_) {}

  const match = postData.match(/(?:guild_id|guildId|guildid)(?:%22|"|')?\s*(?:=|%3A|:)\s*(?:%22|"|')?([A-Za-z0-9_-]+)/i);
  return text(match?.[1]);
}

function createApiSnapshot() {
  return {
    grouped: null,
    groupedScore: -1,
    ownersByGuildId: new Map(),
    ownersResponseCount: 0,
    responseUrls: new Set()
  };
}

function absorbGroupedGuilds(snapshot, object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return;
  const createdRaw = object.created_guilds ?? object.createdGuilds;
  const managedRaw = object.managed_guilds ?? object.managedGuilds;
  const joinedRaw = object.joined_guilds ?? object.joinedGuilds;
  if (!Array.isArray(createdRaw) && !Array.isArray(managedRaw) && !Array.isArray(joinedRaw)) return;

  const created = (Array.isArray(createdRaw) ? createdRaw : []).map(item => normalizeGuild(item, 'created')).filter(item => item.guildId || item.guildNumber || item.name);
  const managed = (Array.isArray(managedRaw) ? managedRaw : []).map(item => normalizeGuild(item, 'managed')).filter(item => item.guildId || item.guildNumber || item.name);
  const joined = (Array.isArray(joinedRaw) ? joinedRaw : []).map(item => normalizeGuild(item, 'joined')).filter(item => item.guildId || item.guildNumber || item.name);
  const score = created.length + managed.length + joined.length;
  if (score < snapshot.groupedScore) return;
  snapshot.groupedScore = score;
  snapshot.grouped = { created, managed, joined };
}

function absorbOwnerResponse(snapshot, object, requestMeta) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return;
  const owners = object.owners;
  if (!Array.isArray(owners)) return;

  const guildId = text(
    object.guild_id ?? object.guildId ??
    object.guild?.guild_id ?? object.guild?.guildId ??
    extractGuildIdFromRequest(requestMeta)
  );
  if (!guildId) return;

  const normalizedOwners = owners.map(normalizeOwner).filter(owner => owner.tinyId || owner.nickname);
  snapshot.ownersResponseCount += 1;
  snapshot.ownersByGuildId.set(guildId, normalizedOwners);
}

function absorbApiBody(snapshot, data, requestMeta) {
  walkObjects(data, object => {
    absorbGroupedGuilds(snapshot, object);
    absorbOwnerResponse(snapshot, object, requestMeta);
  });
}

async function captureBrowserApi(manager, instanceId, work) {
  const id = manager.normalizeInstanceId(instanceId);
  const record = await manager.getOrCreateView(id);
  const webContents = record.view.webContents;
  const api = snapshot => snapshot;
  const snapshot = createApiSnapshot();
  const requestMeta = new Map();
  const xhrRequestIds = new Set();
  const pendingBodies = new Set();
  let attachedHere = false;

  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach('1.3');
      attachedHere = true;
    }
    await webContents.debugger.sendCommand('Network.enable').catch(() => {});
    await webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  } catch (error) {
    manager.db.log('warn', `实例 #${id} 无法监听频道接口：${String(error?.message || error)}`);
    return { rows: await work(), snapshot };
  }

  const onMessage = (_event, method, params = {}) => {
    if (method === 'Network.requestWillBeSent') {
      const request = params.request || {};
      requestMeta.set(params.requestId, {
        url: text(request.url),
        postData: text(request.postData)
      });
      return;
    }

    if (method === 'Network.responseReceived') {
      const type = text(params.type);
      const url = text(params.response?.url);
      if (!['XHR', 'Fetch'].includes(type)) return;
      if (!/qq\.com|gtimg\.cn|myqcloud\.com/i.test(url)) return;
      xhrRequestIds.add(params.requestId);
      if (url) snapshot.responseUrls.add(url);
      return;
    }

    if (method !== 'Network.loadingFinished' || !xhrRequestIds.has(params.requestId)) return;
    xhrRequestIds.delete(params.requestId);
    const requestId = params.requestId;
    const task = webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
      .then(result => {
        const parsed = parseJsonBody(result?.body);
        if (parsed) absorbApiBody(snapshot, parsed, requestMeta.get(requestId) || {});
      })
      .catch(() => {})
      .finally(() => pendingBodies.delete(task));
    pendingBodies.add(task);
  };

  webContents.debugger.on('message', onMessage);
  try {
    // 频道首页刷新会重新调用“我的频道”列表接口；随后原同步流程逐个打开频道，
    // 可以继续捕获频道详情/成员接口中的 owners。
    if (!String(webContents.getURL() || '').startsWith('https://pd.qq.com/')) {
      await manager.navigate(id, 'https://pd.qq.com/');
    }
    await new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 8000);
      webContents.once('did-stop-loading', done);
      try { webContents.reloadIgnoringCache(); } catch (_) { done(); }
    });
    await new Promise(resolve => setTimeout(resolve, 1200));

    const rows = await work();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await Promise.allSettled([...pendingBodies]);
    return { rows, snapshot: api(snapshot) };
  } finally {
    webContents.debugger.removeListener('message', onMessage);
    await webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    if (attachedHere && webContents.debugger.isAttached()) {
      try { webContents.debugger.detach(); } catch (_) {}
    }
  }
}

function buildGroupedMaps(grouped) {
  const byId = new Map();
  const byNumber = new Map();
  const byName = new Map();
  const add = (guild, status, label) => {
    const meta = { ...guild, status, label };
    if (guild.guildId) byId.set(guild.guildId, meta);
    if (guild.guildNumber) byNumber.set(guild.guildNumber.toLowerCase(), meta);
    if (guild.name && !byName.has(guild.name)) byName.set(guild.name, meta);
  };
  for (const guild of grouped?.created || []) add(guild, 'owned', '我创建的');
  for (const guild of grouped?.managed || []) if (!byId.has(guild.guildId)) add(guild, 'not_owned', '我管理的');
  for (const guild of grouped?.joined || []) if (!byId.has(guild.guildId)) add(guild, 'not_owned', '普通加入');
  return { byId, byNumber, byName };
}

function classifyRow(row, snapshot, loginName) {
  const loginKey = normalizedName(loginName);
  const groupId = text(row.groupId || row.guildId);
  const owners = groupId ? snapshot.ownersByGuildId.get(groupId) : null;

  if (Array.isArray(owners) && owners.length && loginKey) {
    const me = owners.find(owner => normalizedName(owner.nickname) === loginKey);
    return {
      status: me ? 'owned' : 'not_owned',
      label: me ? '频道主' : '非频道主',
      source: 'owners',
      ownerTinyId: text(me?.tinyId),
      guildId: groupId
    };
  }

  const maps = buildGroupedMaps(snapshot.grouped);
  const guildNumber = text(row.guildNumber || row.url?.match?.(/\/g\/([^/?#]+)/i)?.[1]).toLowerCase();
  const meta = (groupId && maps.byId.get(groupId)) ||
    (guildNumber && maps.byNumber.get(guildNumber)) ||
    maps.byName.get(text(row.name)) || null;
  if (meta) {
    return {
      status: meta.status,
      label: meta.label,
      source: 'guild-list',
      ownerTinyId: '',
      guildId: meta.guildId || groupId,
      guildNumber: meta.guildNumber || row.guildNumber
    };
  }

  return {
    status: 'unknown',
    label: '归属未确认',
    source: 'unknown',
    ownerTinyId: '',
    guildId: groupId
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

  // 频道管理和新建任务都只暴露当前仍可发布的频道。
  DB.prototype.listChannels = function listEnabledChannels(instanceId) {
    return this.db.prepare('SELECT * FROM channels WHERE instance_id=? AND enabled=1 ORDER BY id ASC').all(Number(instanceId));
  };

  DB.prototype.saveChannelOwnership = function saveChannelOwnership(instanceId, item = {}) {
    const status = ['owned', 'not_owned'].includes(text(item.status)) ? text(item.status) : 'unknown';
    if (status === 'unknown') return { changes: 0 };
    const guildNumber = text(item.guildNumber);
    const guildId = text(item.guildId);
    const url = text(item.url);
    const enabled = status === 'owned' ? 1 : 0;
    return this.db.prepare(`
      UPDATE channels
      SET ownership_status=?, owner_tiny_id=?, ownership_checked_at=CURRENT_TIMESTAMP, enabled=?
      WHERE instance_id=? AND (
        (?<>'' AND COALESCE(guild_id,'')=?) OR
        (?<>'' AND COALESCE(guild_number,'')=?) OR
        (?<>'' AND url=?)
      )
    `).run(
      status, text(item.ownerTinyId), enabled, Number(instanceId),
      guildId, guildId, guildNumber, guildNumber, url, url
    );
  };

  const originalImportRemoteChannels = DB.prototype.importRemoteChannels;
  DB.prototype.importRemoteChannels = function importRemoteChannelsWithOwnership(instanceId, channels = []) {
    const ownedChannels = (channels || []).filter(item => text(item?.ownershipStatus) === 'owned');
    if (!ownedChannels.length) return { created: 0, updated: 0, skipped: Array.isArray(channels) ? channels.length : 0 };
    const result = originalImportRemoteChannels.call(this, instanceId, ownedChannels);
    for (const item of ownedChannels) {
      this.saveChannelOwnership(instanceId, {
        status: 'owned',
        ownerTinyId: item?.ownerTinyId,
        guildId: item?.guildId,
        guildNumber: item?.guildNumber,
        url: item?.url
      });
    }
    return result;
  };

  const previousCollectChannels = BrowserManager.prototype.collectChannels;
  BrowserManager.prototype.collectChannels = async function collectChannelsWithBrowserOwnership(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const captured = await captureBrowserApi(this, id, () => previousCollectChannels.call(this, id));
    const row = this.db.db.prepare('SELECT login_name FROM instances WHERE id=?').get(id) || {};
    const loginName = text(row.login_name);
    const grouped = captured.snapshot.grouped;
    const groupedCounts = {
      created: grouped?.created?.length || 0,
      managed: grouped?.managed?.length || 0,
      joined: grouped?.joined?.length || 0
    };

    this.db.log(
      'info',
      `实例 #${id} 频道归属：当前 QQ 页面接口捕获 owners=${captured.snapshot.ownersResponseCount}；` +
      `频道列表 created=${groupedCounts.created} managed=${groupedCounts.managed} joined=${groupedCounts.joined}`
    );

    const result = captured.rows.map(item => {
      const ownership = classifyRow(item, captured.snapshot, loginName);
      const enriched = {
        ...item,
        guildId: ownership.guildId || item.guildId,
        guildNumber: ownership.guildNumber || item.guildNumber,
        ownershipStatus: ownership.status,
        ownerTinyId: ownership.ownerTinyId || '',
        ownershipSource: ownership.source,
        source: ownership.source,
        sourceLabel: ownership.label,
        // 安全策略：只有明确确认是频道主的频道才允许自动导入。
        selectable: ownership.status === 'owned'
      };

      if (ownership.status !== 'unknown') {
        this.db.saveChannelOwnership(id, {
          status: ownership.status,
          ownerTinyId: ownership.ownerTinyId,
          guildId: enriched.guildId,
          guildNumber: enriched.guildNumber,
          url: enriched.url
        });
      }
      return enriched;
    });

    const owned = result.filter(item => item.ownershipStatus === 'owned').length;
    const notOwned = result.filter(item => item.ownershipStatus === 'not_owned').length;
    const unknown = result.filter(item => item.ownershipStatus === 'unknown').length;
    this.db.log('info', `实例 #${id} 频道归属结果：自己的=${owned}，别人的=${notOwned}，未确认=${unknown}`);
    return result;
  };
};