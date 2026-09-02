const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalize(value) {
  return text(value).replace(/\s+/g, '').toLowerCase();
}

async function readVisibleOwnerNames(webContents) {
  return webContents.executeJavaScript(`(() => {
    const text = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const result = [];
    const seen = new Set();
    const add = value => {
      const name = String(value || '').replace(/\\s+/g, ' ').trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      result.push(name);
    };

    const tags = [...document.querySelectorAll([
      '.user-info__tag.is-owner',
      '.comment-list-item__info__title-tag',
      '[class~="is-owner"]',
      '[class*="is-owner"]'
    ].join(','))].filter(el => text(el) === '频道主' || el.classList?.contains('is-owner'));

    for (const tag of tags) {
      const containers = [
        tag.closest('.user-info'),
        tag.closest('.game-guild-detail-poster-userInfo'),
        tag.closest('.comment-list-item'),
        tag.parentElement?.parentElement,
        tag.parentElement
      ].filter(Boolean);

      let name = '';
      for (const container of containers) {
        const node = container.querySelector?.([
          '.user-info__name-text',
          '.comment-list-item__info__title-name',
          '[class*="user-info__name"]',
          '[class*="title-name"]'
        ].join(','));
        if (node && text(node) && text(node) !== '频道主') {
          name = text(node);
          break;
        }
      }
      if (name) add(name);
    }

    return result;
  })()`, true).catch(() => []);
}

async function readCurrentLoginName(webContents) {
  return webContents.executeJavaScript(`(() => {
    const text = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const selectors = [
      '.app-login .user-info .name',
      '.app-login .user-card .name',
      '.app-login .user-info [class*="name"]',
      '.app-login .user-card [class*="name"]',
      'header .user-info [class*="name"]',
      'header [class*="user-card"] [class*="name"]'
    ];
    for (const selector of selectors) {
      const value = text(document.querySelector(selector));
      if (value) return value;
    }
    return '';
  })()`, true).catch(() => '');
}

async function inspectChannelOwner(manager, instanceId, item, fallbackLoginName) {
  const record = await manager.getOrCreateView(instanceId);
  const webContents = record.view.webContents;
  if (item.url && webContents.getURL() !== item.url) {
    await manager.navigate(instanceId, item.url);
  }

  const deadline = Date.now() + 5000;
  let ownerNames = [];
  while (Date.now() < deadline) {
    ownerNames = await readVisibleOwnerNames(webContents);
    if (ownerNames.length) break;
    await sleep(250);
  }

  const pageLoginName = await readCurrentLoginName(webContents);
  const loginName = text(pageLoginName || fallbackLoginName);
  const loginKey = normalize(loginName);
  const normalizedOwners = ownerNames.map(normalize).filter(Boolean);

  if (!ownerNames.length || !loginKey) {
    return {
      ...item,
      ownershipStatus: 'unknown',
      ownershipSource: item.ownershipSource || 'dom-no-owner-evidence',
      sourceLabel: '归属未确认',
      selectable: false,
      ownerNames,
      loginName
    };
  }

  const mine = normalizedOwners.includes(loginKey);
  return {
    ...item,
    ownershipStatus: mine ? 'owned' : 'not_owned',
    ownershipSource: 'dom-owner-tag',
    source: 'dom-owner-tag',
    sourceLabel: mine ? '频道主' : '非频道主',
    selectable: mine,
    ownerNames,
    loginName
  };
}

module.exports = function installChannelOwnerDomFallbackSupport(BrowserManager) {
  const previousCollectChannels = BrowserManager.prototype.collectChannels;
  BrowserManager.prototype.collectChannels = async function collectChannelsWithDomOwnerFallback(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const rows = await previousCollectChannels.call(this, id);
    const instance = this.db.db.prepare('SELECT login_name FROM instances WHERE id=?').get(id) || {};
    const fallbackLoginName = text(instance.login_name);
    const result = [];

    for (const item of rows) {
      if (item.ownershipStatus && item.ownershipStatus !== 'unknown') {
        result.push(item);
        continue;
      }

      const checked = await inspectChannelOwner(this, id, item, fallbackLoginName).catch(error => {
        this.db.log('warn', `实例 #${id} 频道“${item.name}” DOM归属检查失败：${String(error?.message || error)}`);
        return {
          ...item,
          ownershipStatus: 'unknown',
          ownershipSource: 'dom-error',
          sourceLabel: '归属未确认',
          selectable: false
        };
      });

      const ownerText = Array.isArray(checked.ownerNames) && checked.ownerNames.length
        ? checked.ownerNames.join(' / ')
        : '未读取到';
      this.db.log(
        'info',
        `实例 #${id} 频道“${item.name}” DOM归属：登录=${checked.loginName || fallbackLoginName || '未知'}；频道主=${ownerText}；结果=${checked.ownershipStatus}`
      );

      if (checked.ownershipStatus !== 'unknown') {
        this.db.saveChannelOwnership?.(id, {
          status: checked.ownershipStatus,
          guildId: checked.guildId,
          guildNumber: checked.guildNumber,
          url: checked.url
        });
      }
      result.push(checked);
    }

    const owned = result.filter(item => item.ownershipStatus === 'owned').length;
    const notOwned = result.filter(item => item.ownershipStatus === 'not_owned').length;
    const unknown = result.filter(item => item.ownershipStatus === 'unknown').length;
    this.db.log('info', `实例 #${id} DOM归属汇总：自己的=${owned}，别人的=${notOwned}，未确认=${unknown}`);
    return result;
  };
};