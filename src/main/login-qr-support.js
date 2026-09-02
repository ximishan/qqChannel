module.exports = function installLoginQrSupport(BrowserManager) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  async function safeOpenQQHome(manager, instanceId, record) {
    const webContents = webContentsOf(record);
    if (!webContents || webContents.isDestroyed?.()) throw new Error('登录页面不存在或已经关闭');
    if (isQQHomeUrl(webContents.getURL())) return true;

    try {
      await manager.navigate(instanceId, 'https://pd.qq.com/');
      return true;
    } catch (error) {
      const msg = String(error?.message || error);
      manager.db?.log?.('warn', `实例 #${instanceId} 打开 QQ 首页失败，准备重试：${msg}`);
      if (!isTransientLoadError(error)) throw error;
    }

    await sleep(500);
    try {
      await webContents.loadURL('https://pd.qq.com/');
    } catch (error) {
      const msg = String(error?.message || error);
      manager.db?.log?.('warn', `实例 #${instanceId} QQ 首页重试仍有异常：${msg}`);
      if (!isTransientLoadError(error)) throw error;
    }

    await waitFor(
      webContents,
      `(() => location.href.startsWith('https://pd.qq.com/') && (document.readyState === 'interactive' || document.readyState === 'complete' || document.body?.children?.length > 0))()`,
      15000,
      200
    );
    return isQQHomeUrl(webContents.getURL());
  }

  BrowserManager.prototype.openLoginQrCode = async function openLoginQrCode(instanceId, record = null) {
    const id = this.normalizeInstanceId(instanceId);
    const browserRecord = record || await this.getOrCreateView(id);
    const webContents = webContentsOf(browserRecord);
    if (!webContents || webContents.isDestroyed?.()) throw new Error('当前实例浏览器页面不存在');

    if (!isQQHomeUrl(webContents.getURL())) {
      await safeOpenQQHome(this, id, browserRecord);
    }

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

  BrowserManager.prototype.beginPublishingLogin = async function beginPublishingLoginWithQr(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const record = await this.getOrCreateView(id);
    if (typeof record.view?.setBounds === 'function') record.view.setBounds(this.lastBounds);

    await safeOpenQQHome(this, id, record);

    const status = await this.getLoginStatus(id, record, { wait: false }).catch(error => ({
      loggedIn: false,
      name: '',
      url: webContentsOf(record)?.getURL?.() || '',
      instanceId: id,
      error: String(error?.message || error)
    }));

    if (status.loggedIn) {
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
      this.db.log('warn', `实例 #${id} 未能自动打开 QQ 登录二维码：${qr.reason || '未找到登录入口'}；已保留 QQ 页面，可手动点击登录`);
    } else if (!qr.confirmed) {
      this.db.log('warn', `实例 #${id} 已自动点击 QQ 登录入口，但暂未确认二维码 DOM；当前页面：${qr.url || ''}`);
    } else {
      this.db.log('info', `实例 #${id} QQ 登录二维码已自动打开`);
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
          : '未能自动弹出二维码，QQ 页面已打开，请在页面里手动点击登录'
    };
  };
};
