module.exports = function installCurrentChannelSyncSupport(BrowserManager) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function normalizeChannelName(value = '') {
    return String(value || '')
      .replace(/^腾讯频道-/, '')
      .replace(/-头像$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
  }

  function channelNumberFromUrl(value = '') {
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.hostname !== 'pd.qq.com') return '';
      return parsed.pathname.match(/^\/g\/([^/?#]+)/i)?.[1] || '';
    } catch (_) {
      return '';
    }
  }

  BrowserManager.prototype.collectChannels = async function collectChannelsRobust(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const record = await this.getOrCreateView(id);
    const webContents = record.view.webContents;

    if (!String(webContents.getURL() || '').startsWith('https://pd.qq.com/')) {
      await this.navigate(id, 'https://pd.qq.com/');
    }

    const login = await this.getLoginStatus(id, record, { wait: true });
    if (!login.loggedIn) throw new Error('当前实例未登录，请先完成 QQ 登录');

    const rows = [];
    const seenUrls = new Set();

    const addChannel = (name, url, groupId = '') => {
      const normalizedName = normalizeChannelName(name);
      const guildNumber = channelNumberFromUrl(url);
      if (!normalizedName || !guildNumber) return false;
      const normalizedUrl = `https://pd.qq.com/g/${guildNumber}`;
      if (seenUrls.has(normalizedUrl)) return false;
      seenUrls.add(normalizedUrl);
      rows.push({
        name: normalizedName,
        url: normalizedUrl,
        guildNumber,
        guildId: guildNumber,
        groupId: String(groupId || ''),
        source: 'browser',
        sourceLabel: '当前实例',
        selectable: true
      });
      return true;
    };

    // 先记录当前已经打开的频道。当前激活项在 QQ 页面里有时不会继续保留
    // .my-guild-item 类，因此不能只依赖侧边栏普通项。
    const initialUrl = String(webContents.getURL() || '');
    const initialNumber = channelNumberFromUrl(initialUrl);
    if (initialNumber) {
      const currentInfo = await webContents.executeJavaScript(`(() => {
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
          if (name && name.length <= 100) return { name };
        }

        const avatars = [...document.querySelectorAll('img')]
          .filter(img => visible(img) && /腾讯频道-|头像/.test(String(img.alt || '')))
          .map(img => {
            const rect = img.getBoundingClientRect();
            return { name: clean(img.alt), area: rect.width * rect.height };
          })
          .filter(item => item.name && item.name.length <= 100)
          .sort((a, b) => b.area - a.area);
        if (avatars.length) return { name: avatars[0].name };

        const blocked = new Set(['频道动态', '探索发现', '管理中心', '我的频道', '全部', '热门']);
        const selectors = ['.guild-name','[class*="guild-name"]','[class*="guild-title"]','[class*="channel-name"]','.guild-info h1','.guild-info h2','.guild-info h3','main h1','main h2'];
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            if (!visible(el)) continue;
            const name = clean(el.textContent);
            if (name && name.length <= 100 && !blocked.has(name)) return { name };
          }
        }
        return { name: '' };
      })()`, true).catch(() => ({ name: '' }));

      if (addChannel(currentInfo?.name, initialUrl)) {
        this.db.log('info', `实例 #${id} 同步记录当前频道：${normalizeChannelName(currentInfo?.name)} (${initialNumber})`);
      }
    }

    // 读取侧边栏普通频道项的稳定快照。后续每次切换都会重新查找 DOM，
    // 不使用旧节点引用，避免 React 重绘后节点失效。
    let candidates = [];
    const candidateDeadline = Date.now() + 15000;
    while (Date.now() < candidateDeadline) {
      candidates = await webContents.executeJavaScript(`(() =>
        [...document.querySelectorAll('.my-guild-item')].map((item, index) => {
          const image = item.querySelector('img');
          const clean = value => String(value || '')
            .replace(/^腾讯频道-/, '')
            .replace(/-头像$/, '')
            .replace(/\\s+/g, ' ')
            .trim();
          const name = clean(item.getAttribute('title') || item.querySelector('.item-name')?.textContent || image?.alt || '');
          const avatar = String(image?.src || '');
          const groupId = (avatar.match(/groupprohead\\.gtimg\\.cn\\/(\\d+)\\//) || [])[1] || '';
          return { index, name, groupId };
        }).filter(item => item.name)
      )()`, true).catch(() => []);
      if (candidates.length) break;
      await sleep(400);
    }

    this.db.log('info', `实例 #${id} 频道同步：当前频道已记录 ${rows.length} 个，侧边栏候选 ${candidates.length} 个`);

    for (const candidate of candidates) {
      // 如果这个候选就是已经记录的当前频道，直接跳过；其他频道必须真的发生
      // URL 切换以后才能记录，绝不能再用“第一条特殊放行”。
      let collected = false;

      for (let attempt = 1; attempt <= 3 && !collected; attempt++) {
        const beforeUrl = String(webContents.getURL() || '');
        const beforeNumber = channelNumberFromUrl(beforeUrl);

        const clickResult = await webContents.executeJavaScript(`(() => {
          const candidate = ${JSON.stringify(candidate)};
          const clean = value => String(value || '')
            .replace(/^腾讯频道-/, '')
            .replace(/-头像$/, '')
            .replace(/\\s+/g, ' ')
            .trim();
          const items = [...document.querySelectorAll('.my-guild-item')];
          const target = items.find(item => {
            const image = item.querySelector('img');
            const avatar = String(image?.src || '');
            const name = clean(item.getAttribute('title') || item.querySelector('.item-name')?.textContent || image?.alt || '');
            if (candidate.groupId && avatar.includes('/' + candidate.groupId + '/')) return true;
            return name === candidate.name;
          });
          if (!target) return { clicked: false, reason: 'not-found' };
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const rect = target.getBoundingClientRect();
          const opts = { bubbles: true, cancelable: true, clientX: rect.left + Math.max(1, rect.width / 2), clientY: rect.top + Math.max(1, rect.height / 2), button: 0 };
          try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
          try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
          try { target.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
          try { target.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_) {}
          target.click();
          return { clicked: true, name: candidate.name };
        })()`, true).catch(error => ({ clicked: false, reason: String(error?.message || error) }));

        if (!clickResult?.clicked) {
          this.db.log('warn', `实例 #${id} 同步频道“${candidate.name}”第 ${attempt} 次点击失败：${clickResult?.reason || 'unknown'}`);
          await sleep(500);
          continue;
        }

        // 关键修复：只有 URL 真的从 beforeUrl 切换到另一个 /g/ 页面，才认为
        // 点击成功。旧代码 rows.length===0 会把第一条的旧 URL 错记给新频道。
        const navigationDeadline = Date.now() + 8000;
        while (Date.now() < navigationDeadline) {
          const currentUrl = String(webContents.getURL() || '');
          const currentNumber = channelNumberFromUrl(currentUrl);
          if (currentNumber && currentUrl !== beforeUrl && currentNumber !== beforeNumber) {
            addChannel(candidate.name, currentUrl, candidate.groupId);
            collected = true;
            break;
          }
          await sleep(120);
        }

        if (!collected) {
          // 可能候选项已经是当前频道；如果 URL 对应的频道已经存在，就视为完成，
          // 否则等待后重试真实点击。
          const nowUrl = String(webContents.getURL() || '');
          const normalizedNow = channelNumberFromUrl(nowUrl) ? `https://pd.qq.com/g/${channelNumberFromUrl(nowUrl)}` : '';
          if (normalizedNow && seenUrls.has(normalizedNow) && normalizeChannelName(candidate.name) === rows.find(item => item.url === normalizedNow)?.name) {
            collected = true;
            break;
          }
          this.db.log('warn', `实例 #${id} 同步频道“${candidate.name}”第 ${attempt} 次未检测到真实 URL 切换，准备重试`);
          await sleep(600);
        }
      }

      if (!collected) {
        this.db.log('error', `实例 #${id} 同步频道“${candidate.name}”失败：连续 3 次未完成频道切换`);
      }
    }

    this.db.log('info', `实例 #${id} 频道同步采集完成：共 ${rows.length} 个频道`);
    return rows;
  };
};
