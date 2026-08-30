module.exports = function installCurrentChannelSyncSupport(BrowserManager) {
  const previousCollectChannels = BrowserManager.prototype.collectChannels;

  function normalizeChannelName(value = '') {
    return String(value || '')
      .replace(/^腾讯频道-/, '')
      .replace(/-头像$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
  }

  BrowserManager.prototype.collectChannels = async function collectChannelsIncludingCurrent(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const record = await this.getOrCreateView(id);
    const webContents = record.view.webContents;
    const beforeUrl = String(webContents.getURL() || '');
    let currentChannel = null;

    try {
      const parsed = new URL(beforeUrl);
      const match = parsed.hostname === 'pd.qq.com' ? parsed.pathname.match(/^\/g\/([^/?#]+)/i) : null;
      if (match) {
        const guildNumber = match[1];
        const pageInfo = await webContents.executeJavaScript(`(() => {
          const clean = value => String(value || '')
            .replace(/^腾讯频道-/, '')
            .replace(/-头像$/, '')
            .replace(/\\s+/g, ' ')
            .trim();
          const visible = el => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
          };
          const nameFrom = el => {
            if (!el) return '';
            const image = el.matches?.('img') ? el : el.querySelector?.('img');
            return clean(
              el.getAttribute?.('title') ||
              el.querySelector?.('.item-name')?.textContent ||
              image?.alt ||
              el.textContent ||
              ''
            );
          };

          // 1. 优先读取左侧当前激活的频道项。QQ 会把当前项换成 active/selected 结构，
          //    它不一定仍带 .my-guild-item，所以旧采集逻辑会漏掉它。
          const activeSelectors = [
            '.my-guild-item.active',
            '.my-guild-item.selected',
            '.my-guild-item.current',
            '.my-guild-item[class*="active"]',
            '[class*="guild-item"][class*="active"]',
            '[class*="guild-item"][class*="selected"]',
            '[class*="guild-item"][aria-current="page"]'
          ];
          for (const selector of activeSelectors) {
            const el = document.querySelector(selector);
            const name = nameFrom(el);
            if (name && name.length <= 100) return { name, source: 'active-item' };
          }

          // 2. 当前频道头图通常带“腾讯频道-频道名-头像”的 alt，且尺寸明显大于左侧小头像。
          const avatarCandidates = [...document.querySelectorAll('img')]
            .filter(img => visible(img) && /腾讯频道-|头像/.test(String(img.alt || '')))
            .map(img => {
              const rect = img.getBoundingClientRect();
              return { img, area: rect.width * rect.height, name: clean(img.alt) };
            })
            .filter(item => item.name && item.name.length <= 100)
            .sort((a, b) => b.area - a.area);
          if (avatarCandidates.length) {
            return { name: avatarCandidates[0].name, source: 'largest-avatar' };
          }

          // 3. 最后尝试频道主体区域中常见的名称节点，避免页面样式轻微调整后再次漏掉。
          const headingSelectors = [
            '.guild-name',
            '[class*="guild-name"]',
            '[class*="guild-title"]',
            '[class*="channel-name"]',
            '.guild-info h1', '.guild-info h2', '.guild-info h3',
            'main h1', 'main h2'
          ];
          const blocked = new Set(['频道动态', '探索发现', '管理中心', '我的频道', '全部', '热门']);
          for (const selector of headingSelectors) {
            for (const el of document.querySelectorAll(selector)) {
              if (!visible(el)) continue;
              const name = clean(el.textContent);
              if (name && name.length <= 100 && !blocked.has(name)) return { name, source: 'heading' };
            }
          }

          return { name: '', source: 'unknown' };
        })()`, true).catch(() => ({ name: '', source: 'error' }));

        const name = normalizeChannelName(pageInfo?.name || '');
        if (name) {
          currentChannel = {
            name,
            url: `https://pd.qq.com/g/${guildNumber}`,
            guildNumber,
            guildId: guildNumber,
            groupId: '',
            source: 'browser-current',
            sourceLabel: '当前实例',
            selectable: true
          };
          this.db.log('info', `实例 #${id} 同步时补充当前频道：${name} (${guildNumber})`);
        } else {
          this.db.log('warn', `实例 #${id} 当前位于频道 ${guildNumber}，但未识别到频道名称`);
        }
      }
    } catch (_) {}

    const rows = await previousCollectChannels.call(this, id);
    if (!currentChannel) return rows;

    const seen = new Set();
    const merged = [];
    for (const item of [currentChannel, ...(rows || [])]) {
      const key = String(item?.url || item?.guildNumber || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return merged;
  };
};
