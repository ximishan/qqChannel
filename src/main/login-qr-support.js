const { BrowserWindow } = require('electron');

module.exports = function installLoginQrSupport(BrowserManager) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function loginWindowMap(manager) {
    if (!(manager.__qqchannelLoginWindows instanceof Map)) {
      manager.__qqchannelLoginWindows = new Map();
    }
    return manager.__qqchannelLoginWindows;
  }

  function webContentsOf(record) {
    return record?.view?.webContents || null;
  }

  function isQQHomeUrl(value) {
    return String(value || '').startsWith('https://pd.qq.com/');
  }

  function isTransientLoadError(error) {
    const text = String(error?.message || error || '');
    const code = Number(error?.errno ?? error?.code);
    return code === -3 || code === -100 || code === -101 || /ERR_ABORTED|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|net::ERR_CONNECTION/i.test(text);
  }

  async function waitFor(webContents, script, timeout = 12000, interval = 200) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await webContents.executeJavaScript(script, true).catch(() => null);
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  async function waitForDom(webContents, timeout = 15000) {
    if (!webContents || webContents.isDestroyed?.()) return false;
    const ready = await webContents.executeJavaScript(`(() => {
      return document.readyState === 'interactive'
        || document.readyState === 'complete'
        || Boolean(document.body?.children?.length);
    })()`, true).catch(() => false);
    if (ready) return true;

    let done = false;
    return new Promise(resolve => {
      const cleanup = () => {
        try { webContents.removeListener('dom-ready', onReady); } catch (_) {}
        try { webContents.removeListener('did-fail-load', onFail); } catch (_) {}
      };
      const finish = value => {
        if (done) return;
        done = true;
        cleanup();
        resolve(value);
      };
      const onReady = () => finish(true);
      const onFail = (_event, code) => {
        if (Number(code) !== -3) finish(false);
      };
      webContents.once('dom-ready', onReady);
      webContents.once('did-fail-load', onFail);
      setTimeout(() => finish(false), timeout);
    });
  }

  async function loadQQHomeInRecord(manager, instanceId, record) {
    const webContents = webContentsOf(record);
    if (!webContents || webContents.isDestroyed?.()) throw new Error('登录页面不存在或已经关闭');
    if (isQQHomeUrl(webContents.getURL())) return true;

    for (let i = 1; i <= 2; i++) {
      try {
        await webContents.loadURL('https://pd.qq.com/');
        await waitForDom(webContents, 15000);
        return true;
      } catch (error) {
        const msg = String(error?.message || error);
        manager.db?.log?.('warn', `实例 #${instanceId} 登录窗口打开 QQ 首页失败（第 ${i} 次）：${msg}`);
        if (!isTransientLoadError(error)) throw error;
        await sleep(500);
      }
    }

    await waitForDom(webContents, 15000);
    return isQQHomeUrl(webContents.getURL());
  }

  BrowserManager.prototype.createLoginWindow = async function createLoginWindow(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const windows = loginWindowMap(this);
    const existing = windows.get(id);
    if (existing?.win && !existing.win.isDestroyed()) {
      existing.win.show();
      existing.win.focus();
      return existing.record;
    }

    const originalRecord = await this.getOrCreateView(id);
    const hostWindow = originalRecord.hostWindow
      || this.getInstanceHostWindow?.(id)
      || this.mainWindow;
    const instance = this.db?.getInstanceSummary?.(id);
    const titleName = String(instance?.name || '').trim() || `实例 #${id}`;

    const win = new BrowserWindow({
      width: 1120,
      height: 780,
      minWidth: 980,
      minHeight: 680,
      autoHideMenuBar: true,
      title: `QQ登录 - ${titleName}`,
      parent: hostWindow && !hostWindow.isDestroyed?.() ? hostWindow : undefined,
      modal: false,
      show: true,
      webPreferences: {
        partition: this.partitionName(id),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false
      }
    });

    win.setMenuBarVisibility(false);

    const record = {
      instanceId: id,
      view: win,
      session: originalRecord.session,
      restored: true,
      webStorage: originalRecord.webStorage || null,
      storageApplied: false,
      hostWindow,
      loginWindow: true
    };

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (this.isAllowedQQUrl(url)) {
        setImmediate(() => win.webContents.loadURL(url).catch(error => {
          this.db?.log?.('warn', `登录窗口打开 QQ 链接失败：${String(error?.message || error)}`);
        }));
      }
      return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
      if (!this.isAllowedQQUrl(url)) event.preventDefault();
    });

    win.webContents.on('render-process-gone', (_, details) => {
      this.db?.log?.('error', `实例 #${id} QQ 登录窗口异常退出：${details.reason}`);
    });

    win.on('closed', () => {
      const current = windows.get(id);
      if (current?.record === record) windows.delete(id);
    });

    windows.set(id, { id, win, record });
    try { win.show(); win.focus(); } catch (_) {}
    return record;
  };

  BrowserManager.prototype.getLoginWindowRecord = function getLoginWindowRecord(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const entry = loginWindowMap(this).get(id);
    if (!entry?.win || entry.win.isDestroyed()) return null;
    return entry.record;
  };

  BrowserManager.prototype.closeLoginWindow = function closeLoginWindow(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const entry = loginWindowMap(this).get(id);
    if (!entry?.win || entry.win.isDestroyed()) return false;
    try { entry.win.close(); } catch (_) {}
    return true;
  };

  BrowserManager.prototype.openLoginQrCode = async function openLoginQrCode(instanceId, record = null) {
    const id = this.normalizeInstanceId(instanceId);
    const browserRecord = record || await this.createLoginWindow(id);
    const webContents = webContentsOf(browserRecord);
    if (!webContents || webContents.isDestroyed?.()) throw new Error('当前实例登录页面不存在');

    try { browserRecord.view?.show?.(); browserRecord.view?.focus?.(); } catch (_) {}

    if (!isQQHomeUrl(webContents.getURL())) {
      await loadQQHomeInRecord(this, id, browserRecord);
    }

    await this.applyWebStorage?.(browserRecord).catch(() => {});

    // 等首页主体出现，防止页面尚未渲染就开始找登录入口。
    await waitFor(webContents, `(() => document.readyState === 'complete' || document.body?.children?.length > 2)()`, 10000, 150);

    const clickResult = await waitFor(webContents, `(() => {
      const text = el => String(el?.innerText || el?.textContent || el?.value || '').replace(/\\s+/g, ' ').trim();
      const visible = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const exact = /^(登录|QQ登录|扫码登录|立即登录)$/;
      const candidates = [
        ...document.querySelectorAll('.app-login button,.app-login a,.app-login [role="button"],header button,header a,button,a,[role="button"]')
      ].filter(el => visible(el) && exact.test(text(el)));
      const el = candidates[0] || [...document.querySelectorAll('.app-login,[class*="login"]')]
        .find(node => visible(node) && exact.test(text(node)));
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      try { el.focus(); } catch (_) {}
      const view = el.ownerDocument?.defaultView || window;
      for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        try {
          const Ctor = type.startsWith('pointer') && view.PointerEvent ? view.PointerEvent : view.MouseEvent;
          el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view, buttons: type.includes('down') ? 1 : 0 }));
        } catch (_) {}
      }
      try { el.click(); } catch (_) {}
      return { clicked: true, text: text(el), tag: el.tagName, className: String(el.className || '') };
    })()`, 10000, 180);

    if (!clickResult?.clicked) {
      return {
        triggered: false,
        reason: 'login_entry_not_found',
        url: webContents.getURL()
      };
    }

    // 登录框通常是 ptlogin iframe，也兼容 QQ 改成页面内二维码的情况。
    const qrEvidence = await waitFor(webContents, `(() => {
      const visible = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const frames = [...document.querySelectorAll('iframe')];
      const loginFrame = frames.find(frame => {
        const src = String(frame.src || frame.getAttribute('src') || '');
        return visible(frame) && /(ptlogin2\\.qq\\.com|xui\\.ptlogin2\\.qq\\.com|login\\.qq\\.com|ssl\\.ptlogin2\\.qq\\.com)/i.test(src);
      });
      if (loginFrame) return { type: 'iframe', src: String(loginFrame.src || '') };

      const qr = [...document.querySelectorAll([
        '[class*="qrcode"]','[class*="qr-code"]','[class*="qr_code"]','[id*="qrcode"]','[id*="qrlogin"]',
        'img[src*="qrcode"]','img[src*="qr"]','canvas'
      ].join(','))].find(visible);
      if (qr) return { type: 'qrcode', tag: qr.tagName, className: String(qr.className || '') };

      const bodyText = String(document.body?.innerText || '').replace(/\\s+/g, ' ');
      if (/扫码登录|手机QQ扫码|二维码登录|请使用手机QQ扫描二维码/.test(bodyText)) return { type: 'text' };
      return null;
    })()`, 12000, 200);

    return {
      triggered: true,
      confirmed: Boolean(qrEvidence),
      evidence: qrEvidence || null,
      clicked: clickResult,
      url: webContents.getURL()
    };
  };

  BrowserManager.prototype.beginPublishingLogin = async function beginPublishingLoginWithQrWindow(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const record = await this.createLoginWindow(id);
    await loadQQHomeInRecord(this, id, record);

    const status = await this.getLoginStatus(id, record, { wait: false }).catch(error => ({
      loggedIn: false,
      name: '',
      url: webContentsOf(record)?.getURL?.() || '',
      instanceId: id,
      error: String(error?.message || error)
    }));

    if (status.loggedIn) {
      this.db?.log?.('info', `实例 #${id} QQ 登录窗口检测到已登录`);
      return {
        ...status,
        requiresBrowser: false,
        qrTriggered: false,
        message: '当前实例已经登录'
      };
    }

    const qr = await this.openLoginQrCode(id, record).catch(error => ({
      triggered: false,
      confirmed: false,
      reason: String(error?.message || error),
      url: webContentsOf(record)?.getURL?.() || ''
    }));

    if (!qr.triggered) {
      this.db?.log?.('warn', `实例 #${id} 未能自动打开 QQ 登录二维码：${qr.reason || '未找到登录入口'}；已保留 QQ 登录窗口，可手动点击登录`);
    } else if (!qr.confirmed) {
      this.db?.log?.('warn', `实例 #${id} 已自动点击 QQ 登录入口，但暂未确认二维码 DOM；当前页面：${qr.url || ''}`);
    } else {
      this.db?.log?.('info', `实例 #${id} QQ 登录二维码已自动打开`);
    }

    return {
      ...status,
      loggedIn: false,
      requiresBrowser: true,
      qrTriggered: Boolean(qr.triggered),
      qrConfirmed: Boolean(qr.confirmed),
      message: qr.confirmed
        ? 'QQ 登录二维码已打开，请使用手机 QQ 扫码'
        : qr.triggered
          ? '已自动打开 QQ 登录入口，请稍候二维码加载'
          : '未能自动弹出二维码，QQ 登录窗口已打开，请在窗口里手动点击登录'
    };
  };

  BrowserManager.prototype.pollPublishingLogin = async function pollPublishingLoginWithLoginWindow(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const record = this.getLoginWindowRecord(id) || await this.getOrCreateView(id);
    const status = await this.getLoginStatus(id, record, { wait: false });
    if (status.loggedIn) {
      this.db?.log?.('info', `实例 #${id} QQ 登录成功，登录窗口可关闭`);
      setTimeout(() => this.closeLoginWindow(id), 1200);
    }
    return status;
  };

  BrowserManager.prototype.getPublishingLoginStatus = async function getPublishingLoginStatusWithLoginWindow(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const record = this.getLoginWindowRecord(id) || await this.getOrCreateView(id);
    return this.getLoginStatus(id, record, { wait: false });
  };
};
