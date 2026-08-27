const path = require('path');
const fs = require('fs');
const { WebContentsView, session, safeStorage } = require('electron');

const QQ_HOME = 'https://pd.qq.com/';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class NonRetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonRetryableError';
    this.retryable = false;
  }
}

class BrowserManager {
  constructor(userDataPath, db, mainWindow) {
    this.userDataPath = userDataPath;
    this.db = db;
    this.mainWindow = mainWindow;
    this.views = new Map();
    this.activeInstanceId = null;
    this.lastBounds = { x: 18, y: 148, width: 1000, height: 650 };

    this.mainWindow.on('closed', () => {
      for (const record of this.views.values()) {
        record.view.webContents.close({ waitForBeforeUnload: false });
      }
      this.views.clear();
    });
  }

  profilePath(instanceId) {
    const p = path.join(this.userDataPath, 'profiles', String(instanceId));
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  authStatePath(instanceId) {
    return path.join(this.profilePath(instanceId), 'auth-state.bin');
  }

  partitionName(instanceId) {
    return `persist:qq-channel-instance-${Number(instanceId)}`;
  }

  isAllowedQQUrl(url) {
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) return false;
      return parsed.hostname === 'qq.com' || parsed.hostname.endsWith('.qq.com');
    } catch (_) {
      return false;
    }
  }

  async getOrCreateView(instanceId) {
    const id = Number(instanceId);
    if (this.views.has(id)) return this.views.get(id);

    const persistentSession = session.fromPartition(this.partitionName(id));
    const view = new WebContentsView({
      webPreferences: {
        session: persistentSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    });

    view.setBackgroundColor('#ffffff');
    view.setBounds(this.lastBounds);
    view.setVisible(false);
    this.mainWindow.contentView.addChildView(view);

    const record = {
      instanceId: id,
      view,
      session: persistentSession,
      restored: false,
      webStorage: null,
      storageApplied: false
    };

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (this.isAllowedQQUrl(url)) {
        setImmediate(() => this.navigate(id, url).catch(error => {
          this.db.log('warn', `内置浏览器打开链接失败：${String(error?.message || error)}`);
        }));
      }
      return { action: 'deny' };
    });

    view.webContents.on('will-navigate', (event, url) => {
      if (!this.isAllowedQQUrl(url)) event.preventDefault();
    });

    view.webContents.on('render-process-gone', (_, details) => {
      this.db.log('error', `实例 #${id} 内置浏览器异常退出：${details.reason}`);
    });

    this.views.set(id, record);
    await this.restoreAuthState(id, record).catch(error => {
      this.db.log('warn', `实例 #${id} 登录会话恢复失败：${String(error?.message || error)}`);
    });
    return record;
  }

  normalizeBounds(bounds) {
    const source = bounds || this.lastBounds;
    return {
      x: Math.max(0, Math.round(Number(source.x) || 0)),
      y: Math.max(0, Math.round(Number(source.y) || 0)),
      width: Math.max(1, Math.round(Number(source.width) || 1)),
      height: Math.max(1, Math.round(Number(source.height) || 1))
    };
  }

  async setViewState({ instanceId, visible, bounds }) {
    if (bounds) this.lastBounds = this.normalizeBounds(bounds);
    const id = Number(instanceId);

    for (const [otherId, record] of this.views) {
      if (otherId !== id) record.view.setVisible(false);
    }

    if (!id || !visible) {
      if (this.views.has(id)) this.views.get(id).view.setVisible(false);
      this.activeInstanceId = null;
      return { visible: false };
    }

    const record = await this.getOrCreateView(id);
    record.view.setBounds(this.lastBounds);
    record.view.setVisible(true);
    this.activeInstanceId = id;
    return { visible: true, url: record.view.webContents.getURL() };
  }

  async navigate(instanceId, url = QQ_HOME) {
    if (!this.isAllowedQQUrl(url)) throw new Error('内置浏览器只允许打开腾讯 QQ 域名');
    const record = await this.getOrCreateView(instanceId);
    await record.view.webContents.loadURL(url);
    await this.applyWebStorage(record);
    return { url: record.view.webContents.getURL() };
  }

  async goBack(instanceId) {
    const record = await this.getOrCreateView(instanceId);
    const navigation = record.view.webContents.navigationHistory;
    if (navigation.canGoBack()) navigation.goBack();
    return { url: record.view.webContents.getURL() };
  }

  async reload(instanceId) {
    const record = await this.getOrCreateView(instanceId);
    if (!record.view.webContents.getURL()) return this.navigate(instanceId, QQ_HOME);
    record.view.webContents.reload();
    return { url: record.view.webContents.getURL() };
  }

  async restoreAuthState(instanceId, record) {
    if (record.restored) return false;
    record.restored = true;
    const statePath = this.authStatePath(instanceId);
    if (!fs.existsSync(statePath) || !safeStorage.isEncryptionAvailable()) return false;

    const encrypted = fs.readFileSync(statePath);
    const state = JSON.parse(safeStorage.decryptString(encrypted));
    record.webStorage = state.webStorage || null;

    for (const cookie of state.cookies || []) {
      const host = String(cookie.domain || 'pd.qq.com').replace(/^\./, '');
      const details = {
        url: `${cookie.secure === false ? 'http' : 'https'}://${host}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: Boolean(cookie.httpOnly)
      };
      if (cookie.domain) details.domain = cookie.domain;
      if (Number(cookie.expires) > 0) details.expirationDate = Number(cookie.expires);
      const sameSite = String(cookie.sameSite || '').toLowerCase();
      if (sameSite === 'strict') details.sameSite = 'strict';
      if (sameSite === 'lax') details.sameSite = 'lax';
      if (sameSite === 'none' || sameSite === 'no_restriction') details.sameSite = 'no_restriction';
      await record.session.cookies.set(details).catch(() => {});
    }
    return true;
  }

  async applyWebStorage(record) {
    if (record.storageApplied || !record.webStorage) return;
    if (!record.view.webContents.getURL().startsWith('https://pd.qq.com/')) return;
    const storage = JSON.stringify(record.webStorage);
    await record.view.webContents.executeJavaScript(`(() => {
      const state = ${storage};
      for (const [key, value] of Object.entries(state.local || {})) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(state.session || {})) sessionStorage.setItem(key, value);
    })()`, true);
    record.storageApplied = true;
  }

  async saveAuthState(instanceId, record) {
    if (!safeStorage.isEncryptionAvailable()) {
      this.db.log('warn', `实例 #${instanceId} 无法使用系统加密，未导出登录会话备份`);
      return false;
    }

    const allCookies = await record.session.cookies.get({});
    const cookies = allCookies
      .filter(cookie => String(cookie.domain || '').replace(/^\./, '').endsWith('qq.com'))
      .map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expirationDate || -1,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite
      }));

    let webStorage = { local: {}, session: {} };
    if (record.view.webContents.getURL().startsWith('https://pd.qq.com/')) {
      webStorage = await record.view.webContents.executeJavaScript(`(() => ({
        local: Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => {
          const key = localStorage.key(i); return [key, localStorage.getItem(key)];
        })),
        session: Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, i) => {
          const key = sessionStorage.key(i); return [key, sessionStorage.getItem(key)];
        }))
      }))()`, true).catch(() => webStorage);
    }

    const payload = JSON.stringify({ version: 2, cookies, webStorage });
    fs.writeFileSync(this.authStatePath(instanceId), safeStorage.encryptString(payload));
    return true;
  }

  selectorCandidates(config) {
    if (!config?.value) return [];
    return String(config.value).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }

  async elementAction(webContents, config, action = 'inspect', payload = null) {
    const selectors = Array.isArray(config) ? config : this.selectorCandidates(config);
    const source = `(() => {
      const selectors = ${JSON.stringify(selectors)};
      const action = ${JSON.stringify(action)};
      const payload = ${JSON.stringify(payload)};
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const unique = (items) => [...new Set(items)];
      const findAll = (selector) => {
        try {
          if (selector.startsWith('text=')) {
            const needle = selector.slice(5).trim();
            const nodes = [...document.querySelectorAll('button,a,input,textarea,[contenteditable="true"],div,span,p')]
              .filter(el => isVisible(el) && String(el.innerText || el.textContent || el.placeholder || '').trim().includes(needle));
            nodes.sort((a, b) => {
              const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
              return (ar.width * ar.height) - (br.width * br.height);
            });
            return unique(nodes);
          }
          const match = selector.match(/^(.*):has-text\((["'])(.*?)\\2\)$/);
          if (match) {
            const base = match[1].trim() || '*';
            return [...document.querySelectorAll(base)].filter(el => String(el.innerText || el.textContent || '').trim().includes(match[3]));
          }
          return [...document.querySelectorAll(selector)];
        } catch (_) {
          return [];
        }
      };
      const all = [];
      for (let i = 0; i < selectors.length; i++) {
        for (const el of findAll(selectors[i])) all.push({ el, selector: selectors[i], index: i });
      }
      if (action === 'count') {
        for (const item of all) {
          item.el.style.outline = '3px solid #ff3b30';
          item.el.style.outlineOffset = '2px';
        }
        return { found: all.length > 0, count: all.length };
      }
      const item = all.find(x => isVisible(x.el)) || all[0];
      if (!item) return { found: false, count: 0 };
      const el = item.el;
      if (action === 'click') {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        el.click();
      } else if (action === 'fill') {
        el.scrollIntoView({ block: 'center' });
        el.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        let inserted = false;
        try { inserted = document.execCommand('insertText', false, String(payload || '')); } catch (_) {}
        if (!inserted) el.textContent = String(payload || '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(payload || '') }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const text = String(el.innerText || el.textContent || el.value || el.placeholder || '').trim();
      const disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled');
      return { found: true, count: all.length, selector: item.selector, index: item.index, text, disabled, visible: isVisible(el) };
    })()`;
    return webContents.executeJavaScript(source, true);
  }

  async waitForElement(webContents, config, options = {}) {
    const timeout = Number(options.timeout ?? config?.timeout ?? 30000);
    const visible = options.visible !== false;
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeout) {
      last = await this.elementAction(webContents, config, 'inspect').catch(() => null);
      if (last?.found && (!visible || last.visible)) return last;
      await sleep(250);
    }
    throw new Error(`等待元素超时（${timeout}ms）：${config?.name || config?.key || 'unknown selector'}`);
  }

  async openLogin(instanceId) {
    const record = await this.getOrCreateView(instanceId);
    record.view.setBounds(this.lastBounds);
    record.view.setVisible(true);
    this.activeInstanceId = Number(instanceId);
    await this.navigate(instanceId, QQ_HOME);
    return this.getLoginStatus(instanceId, record, { wait: false });
  }

  async getLoginStatus(instanceId, existingRecord = null, options = {}) {
    const record = existingRecord || await this.getOrCreateView(instanceId);
    const currentUrl = record.view.webContents.getURL();
    if (!currentUrl || !currentUrl.startsWith('https://pd.qq.com/')) await this.navigate(instanceId, QQ_HOME);

    const selectors = this.db.getSelectorMap();
    const timeout = options.wait === false ? 1000 : 10000;
    try {
      const found = await this.waitForElement(record.view.webContents, selectors.logged_in_user, { visible: true, timeout });
      await this.saveAuthState(instanceId, record).catch(error => {
        this.db.log('warn', `实例 #${instanceId} 登录会话保存失败：${String(error?.message || error)}`);
      });
      return { loggedIn: true, name: found.text || '已登录', url: record.view.webContents.getURL() };
    } catch (_) {
      return { loggedIn: false, name: '', url: record.view.webContents.getURL() };
    }
  }

  async testSelector(instanceId, selector, url) {
    const record = await this.getOrCreateView(instanceId);
    if (url) await this.navigate(instanceId, url);
    else if (!record.view.webContents.getURL()) await this.navigate(instanceId, QQ_HOME);
    const result = await this.elementAction(record.view.webContents, [selector], 'count');
    return { count: result.count || 0, url: record.view.webContents.getURL() };
  }

  async fillProseMirror(webContents, config, text) {
    if (!text) return;
    await this.waitForElement(webContents, config, { visible: true });
    const result = await this.elementAction(webContents, config, 'fill', text);
    if (!result?.found) throw new Error('正文编辑器写入失败');
  }

  async ensureComposerOpen(webContents, selectors) {
    const body = await this.elementAction(webContents, selectors.body_input, 'inspect').catch(() => null);
    if (body?.found && body.visible) return body;

    try {
      await this.waitForElement(webContents, selectors.composer_entry, {
        visible: true,
        timeout: selectors.composer_entry?.timeout || 10000
      });
    } catch (_) {
      throw new NonRetryableError('页面已打开，但找不到“期待你的分享”发帖入口；请检查频道页面或更新发帖入口选择器');
    }

    await this.elementAction(webContents, selectors.composer_entry, 'click');
    try {
      return await this.waitForElement(webContents, selectors.body_input, { visible: true, timeout: 10000 });
    } catch (_) {
      throw new NonRetryableError('已点击发帖入口，但正文编辑器没有展开；请更新正文编辑器选择器');
    }
  }

  async setMediaFile(webContents, config, mediaPath) {
    if (!fs.existsSync(mediaPath)) throw new Error(`素材文件不存在：${mediaPath}`);
    const selectors = this.selectorCandidates(config).filter(selector => !selector.startsWith('text=') && !selector.includes(':has-text'));
    if (!selectors.length) throw new Error('上传控件选择器必须是 CSS 选择器');

    if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
    const documentNode = await webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    for (const selector of selectors) {
      try {
        const result = await webContents.debugger.sendCommand('DOM.querySelector', {
          nodeId: documentNode.root.nodeId,
          selector
        });
        if (!result.nodeId) continue;
        await webContents.debugger.sendCommand('DOM.setFileInputFiles', {
          nodeId: result.nodeId,
          files: [path.resolve(mediaPath)]
        });
        return true;
      } catch (_) {}
    }
    throw new Error(`找不到上传控件：${config?.name || 'file_input'}`);
  }

  async waitPublishReady(webContents, selectors) {
    const timeout = Number(this.db.getSetting('upload_timeout_ms', '120000'));
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const button = await this.elementAction(webContents, selectors.publish_button, 'inspect').catch(() => null);
      if (button?.found && button.visible && !button.disabled) return true;
      const errorText = await this.readPageError(webContents, selectors).catch(() => '');
      if (errorText) throw new Error(`页面提示：${errorText}`);
      await sleep(1000);
    }
    throw new Error(`等待素材上传完成/发表按钮可用超时（${Math.round(timeout / 1000)}秒）`);
  }

  async readPageError(webContents, selectors) {
    const result = await this.elementAction(webContents, selectors.error_hint, 'inspect');
    return result?.found && result.visible ? result.text : '';
  }

  async verifyPublishSuccess(webContents, selectors) {
    const timeout = Number(this.db.getSetting('publish_verify_timeout_ms', '20000'));
    const successStart = Date.now();
    while (Date.now() - successStart < Math.min(timeout, 3000)) {
      const success = await this.elementAction(webContents, selectors.success_hint, 'inspect').catch(() => null);
      if (success?.found && success.visible) return { verified: true, reason: `success_hint:${success.selector}` };
      await sleep(250);
    }

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const body = await this.elementAction(webContents, selectors.body_input, 'inspect').catch(() => null);
      const button = await this.elementAction(webContents, selectors.publish_button, 'inspect').catch(() => null);
      const normalized = String(body?.text || '').replace(/\s+/g, '').trim();
      if (body?.found && (normalized === '' || normalized === '期待你的分享...') && button?.disabled) {
        return { verified: true, reason: 'editor_reset' };
      }
      const errorText = await this.readPageError(webContents, selectors).catch(() => '');
      if (errorText) throw new Error(`发布失败，页面提示：${errorText}`);
      await sleep(500);
    }
    throw new Error('点击发表后未检测到明确的发布成功状态');
  }

  screenshotDir() {
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const p = path.join(this.userDataPath, 'screenshots', date);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  async saveFailureScreenshot(webContents, taskId, targetId, attempt) {
    if (this.db.getSetting('screenshot_on_error', '1') !== '1') return null;
    const p = path.join(this.screenshotDir(), `task-${taskId}-target-${targetId}-attempt-${attempt}-${Date.now()}.png`);
    const image = await webContents.capturePage().catch(() => null);
    if (image) fs.writeFileSync(p, image.toPNG());
    return image ? p : null;
  }

  async publishOneTarget(record, task, target, selectors, attempt) {
    const webContents = record.view.webContents;
    try {
      this.db.setTargetStatus(target.id, 'running');
      this.db.log('info', `任务 #${task.id} 打开频道：${target.channel_name}（第${attempt}次）`);
      await this.navigate(task.instance_id, target.channel_url);

      const login = await this.getLoginStatus(task.instance_id, record);
      if (!login.loggedIn) throw new Error('QQ 登录状态已失效，请重新登录后继续');

      await this.ensureComposerOpen(webContents, selectors);
      if (task.body) await this.fillProseMirror(webContents, selectors.body_input, task.body);
      await this.setMediaFile(webContents, selectors.file_input, task.media_path);
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 素材已选择，等待上传完成`);

      await this.waitPublishReady(webContents, selectors);
      const publishButton = await this.elementAction(webContents, selectors.publish_button, 'inspect');
      if (!publishButton?.found || publishButton.disabled) throw new Error('发表按钮仍处于 disabled 状态');
      await this.elementAction(webContents, selectors.publish_button, 'click');
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 已点击发表，等待结果确认`);

      const verify = await this.verifyPublishSuccess(webContents, selectors);
      this.db.setTargetStatus(target.id, 'success');
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 发布成功（${verify.reason}）`);
      return true;
    } catch (error) {
      const msg = String(error?.message || error);
      const screenshot = await this.saveFailureScreenshot(webContents, task.id, target.id, attempt);
      this.db.setTargetStatus(target.id, 'failed', screenshot ? `${msg}\n截图：${screenshot}` : msg);
      this.db.log('error', `任务 #${task.id} -> ${target.channel_name} 失败：${msg}${screenshot ? `；截图：${screenshot}` : ''}`);
      throw error;
    }
  }

  async publishTask(task) {
    const record = await this.getOrCreateView(task.instance_id);
    const selectors = this.db.getSelectorMap();
    const maxRetries = Math.max(0, Number(this.db.getSetting('max_retries', '2')) || 0);
    let allSuccess = true;

    this.db.setTaskStatus(task.id, 'running');
    this.db.log('info', `开始任务 #${task.id}`);
    const login = await this.getLoginStatus(task.instance_id, record).catch(() => ({ loggedIn: false }));
    if (!login.loggedIn) {
      this.db.setTaskStatus(task.id, 'failed');
      this.db.log('error', `任务 #${task.id} 未执行：QQ 未登录或登录已失效`);
      throw new Error('QQ 未登录或登录已失效，请先点击“登录QQ”');
    }

    for (const target of task.targets) {
      if (target.status === 'success') continue;
      let success = false;
      let lastError = null;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
          if (attempt > 1) {
            this.db.incrementTargetRetry(target.id);
            this.db.log('warn', `任务 #${task.id} -> ${target.channel_name} 开始重试 ${attempt - 1}/${maxRetries}`);
            await sleep(3000);
          }
          await this.publishOneTarget(record, task, target, selectors, attempt);
          success = true;
          break;
        } catch (error) {
          lastError = error;
          if (error?.retryable === false) {
            this.db.log('warn', `任务 #${task.id} -> ${target.channel_name} 遇到不可自动重试的问题，已停止重复打开频道`);
            break;
          }
        }
      }
      if (!success) {
        allSuccess = false;
        this.db.log('error', `任务 #${task.id} -> ${target.channel_name} 已达到最大重试次数：${String(lastError?.message || lastError || '')}`);
      }
    }

    await this.saveAuthState(task.instance_id, record).catch(() => {});
    this.db.setTaskStatus(task.id, allSuccess ? 'success' : 'failed');
    this.db.log('info', `任务 #${task.id} 结束，状态：${allSuccess ? 'success' : 'failed'}`);
    return { success: allSuccess };
  }
}

module.exports = BrowserManager;
