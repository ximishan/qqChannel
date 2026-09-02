module.exports = function installLoginStateFixSupport(DB, BrowserManager) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isQQLoginUrl = value => {
    try {
      const host = new URL(String(value || '')).hostname.toLowerCase();
      return host === 'ptlogin2.qq.com'
        || host.endsWith('.ptlogin2.qq.com')
        || host === 'login.qq.com'
        || host.endsWith('.login.qq.com');
    } catch (_) {
      return false;
    }
  };

  DB.prototype.getInstanceLoginSnapshot = function getInstanceLoginSnapshot(id) {
    return this.db.prepare(`
      SELECT id,name,login_name,login_status,last_login_check_at
      FROM instances WHERE id=?
    `).get(Number(id)) || null;
  };

  BrowserManager.prototype.getLoginStatus = async function getLoginStatusStable(instanceId, existingRecord = null, options = {}) {
    const id = this.normalizeInstanceId(instanceId);
    const record = existingRecord || await this.getOrCreateView(id);
    const webContents = record.view.webContents;
    let currentUrl = String(webContents.getURL() || '');

    // QQ 登录框有时是 pd.qq.com 页内 iframe，有时会导航到 ptlogin2.qq.com。
    // 扫码过程中不能把 ptlogin 页面强制导航回 pd.qq.com，否则二维码会被关掉。
    if (!currentUrl.startsWith('https://pd.qq.com/') && !isQQLoginUrl(currentUrl)) {
      await this.navigate(id, 'https://pd.qq.com/');
      currentUrl = String(webContents.getURL() || '');
    }

    const selectors = this.db.getSelectorMap();
    // 普通登录检测保留原等待时间；任务临时页已经直接打开目标频道，
    // 只做快速确认，避免每条任务在外围白等 8~12 秒。
    const timeout = record.temporaryPublishPage
      ? 1500
      : (options.wait === false ? 8000 : 12000);
    const deadline = Date.now() + timeout;
    let resolved = null;

    while (Date.now() < deadline) {
      const urlNow = String(webContents.getURL() || '');

      // 独立 QQ 登录页本身就表示正在等待扫码，不应判定为退出登录。
      if (isQQLoginUrl(urlNow)) {
        resolved = { state: 'pending_login', name: '' };
        await sleep(300);
        continue;
      }

      const configured = await this.elementAction(webContents, selectors.logged_in_user, 'inspect').catch(() => null);
      if (configured?.found) {
        resolved = { state: 'logged_in', name: String(configured.text || '').trim() };
        break;
      }

      const domState = await webContents.executeJavaScript(`(() => {
        const text = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
        const visible = el => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
        };

        const user = document.querySelector([
          '.app-login .user-info .name',
          '.app-login .user-card .name',
          '.app-login .user-info',
          '.app-login .user-card',
          '.app-login [class*="avatar"]',
          'header .user-info',
          'header [class*="user-card"]'
        ].join(','));

        const controls = [...document.querySelectorAll('button,a')];
        const loginButton = controls.find(el => visible(el) && /^(登录|扫码登录|QQ登录)$/.test(text(el)));
        const authenticatedNav = [...document.querySelectorAll('a,button,span,div')].find(el =>
          /^(管理中心|我的频道)$/.test(text(el))
        );
        const guildItem = document.querySelector('.my-guild-item');
        const qr = [...document.querySelectorAll('[class*="qrcode"],[class*="qr-code"],[id*="qrcode"],iframe')]
          .find(el => visible(el) && (el.tagName !== 'IFRAME' || /(ptlogin2\\.qq\\.com|login\\.qq\\.com)/i.test(String(el.src || ''))));

        if (user || authenticatedNav || guildItem) {
          return { state: 'logged_in', name: text(user) };
        }
        if (qr) return { state: 'pending_login', name: '' };
        if (loginButton) {
          return { state: 'logged_out', name: '' };
        }
        return { state: 'pending', name: '' };
      })()`, true).catch(() => ({ state: 'pending', name: '' }));

      if (domState.state === 'logged_in' || domState.state === 'logged_out') {
        resolved = domState;
        break;
      }
      if (domState.state === 'pending_login') resolved = domState;
      await sleep(record.temporaryPublishPage ? 120 : 250);
    }

    if (resolved?.state === 'logged_in') {
      // 临时发布页与实例共享同一 persistent session，任务结束时还会统一保存一次。
      // 这里不再为每次任务/评论重复导出 Cookie + Storage。
      if (!record.temporaryPublishPage) {
        await this.saveAuthState(id, record).catch(error => {
          this.db.log('warn', `实例 #${id} QQ 登录会话保存失败：${String(error?.message || error)}`);
        });
      }
      const saved = this.db.getInstanceLoginSnapshot?.(id);
      const name = String(resolved.name || saved?.login_name || 'QQ账号').trim() || 'QQ账号';
      this.db.setInstanceLoginState?.(id, true, name);
      return {
        loggedIn: true,
        name,
        url: webContents.getURL(),
        instanceId: id,
        verified: true
      };
    }

    if (resolved?.state === 'logged_out') {
      this.db.setInstanceLoginState?.(id, false, '');
      return {
        loggedIn: false,
        name: '',
        url: webContents.getURL(),
        instanceId: id,
        verified: true
      };
    }

    // 二维码正在显示时，不修改实例数据库中的登录状态。
    if (resolved?.state === 'pending_login' || isQQLoginUrl(webContents.getURL())) {
      return {
        loggedIn: false,
        name: '',
        url: webContents.getURL(),
        instanceId: id,
        verified: false,
        loginPending: true
      };
    }

    // 频道详情页、发布页等页面不一定包含首页的用户节点。以前这里会因为
    // “页面已加载但没有命中用户 DOM”直接把实例写成 logged_out，造成用户
    // 看到所有实例过一会一起掉线。现在只有明确看到登录按钮才允许降级。
    const snapshot = this.db.getInstanceLoginSnapshot?.(id);
    if (snapshot?.login_status === 'logged_in') {
      const name = String(snapshot.login_name || 'QQ账号').trim() || 'QQ账号';
      return {
        loggedIn: true,
        name,
        url: webContents.getURL(),
        instanceId: id,
        verified: false,
        preserved: true
      };
    }

    return {
      loggedIn: false,
      name: '',
      url: webContents.getURL(),
      instanceId: id,
      verified: false
    };
  };
};
