const { BrowserWindow } = require('electron');

module.exports = function installTaskPageLifecycleSupport(BrowserManager) {
  const proto = BrowserManager.prototype;
  if (proto.__taskPageLifecycleInstalled) return;
  proto.__taskPageLifecycleInstalled = true;

  const previousPublishTask = proto.publishTask;
  const previousNavigate = proto.navigate;

  if (typeof previousPublishTask !== 'function' || typeof previousNavigate !== 'function') {
    throw new Error('任务临时页面生命周期安装失败：BrowserManager 发布接口不存在');
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function lifecycleMap(manager) {
    if (!(manager.__qqchannelTaskPageLifecycles instanceof Map)) {
      manager.__qqchannelTaskPageLifecycles = new Map();
    }
    return manager.__qqchannelTaskPageLifecycles;
  }

  function windowTitle(task, firstTarget) {
    const taskId = Number(task?.id || 0);
    const channel = String(firstTarget?.channel_name || '').trim();
    return channel
      ? `QQ发布页 - 任务 #${taskId} - ${channel}`
      : `QQ发布页 - 任务 #${taskId}`;
  }

  proto.createTaskPublishPage = async function createTaskPublishPage(instanceId, task = null, firstTarget = null) {
    const id = this.normalizeInstanceId(instanceId);
    const originalRecord = await this.getOrCreateView(id);
    const hostWindow = originalRecord.hostWindow
      || this.getInstanceHostWindow?.(id)
      || this.mainWindow;

    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 1000,
      minHeight: 700,
      autoHideMenuBar: true,
      title: windowTitle(task, firstTarget),
      parent: hostWindow && !hostWindow.isDestroyed?.() ? hostWindow : undefined,
      modal: false,
      show: true,
      webPreferences: {
        session: originalRecord.session,
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
      temporaryPublishPage: true
    };

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (this.isAllowedQQUrl(url)) {
        setImmediate(() => this.navigate(id, url).catch(error => {
          this.db.log('warn', `任务临时发布窗口打开 QQ 链接失败：${String(error?.message || error)}`);
        }));
      }
      return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
      if (!this.isAllowedQQUrl(url)) event.preventDefault();
    });

    win.webContents.on('render-process-gone', (_, details) => {
      this.db.log('error', `实例 #${id} 任务临时发布窗口异常退出：${details.reason}`);
    });

    win.on('closed', () => {
      const lifecycles = lifecycleMap(this);
      const active = lifecycles.get(id);
      if (active?.record === record) {
        active.closedByUser = true;
      }
    });

    try { win.show(); win.focus(); } catch (_) {}
    return { id, originalRecord, record, hostWindow, win, closedByUser: false };
  };

  proto.closeTaskPublishPage = async function closeTaskPublishPage(lifecycle) {
    const win = lifecycle?.win || lifecycle?.record?.view;
    if (!win) return;

    const webContents = win.webContents;
    try {
      if (webContents && !webContents.isDestroyed() && webContents.debugger?.isAttached?.()) {
        webContents.debugger.detach();
      }
    } catch (_) {}
    try {
      if (!win.isDestroyed?.()) win.close();
    } catch (_) {}
  };

  // 发布任务运行期间，navigate 只操作该实例当前任务创建的临时发布窗口。
  // 这里不再等待 QQ 全部资源加载完成，只等 dom-ready；后续仍由油猴 DOM 逻辑
  // 自己等待发帖框、媒体预览、发表按钮和评论框。
  proto.navigate = async function navigateTaskPageAware(instanceId, url = 'https://pd.qq.com/') {
    const id = this.normalizeInstanceId(instanceId);
    const active = lifecycleMap(this).get(id);
    if (!active || !active.record?.temporaryPublishPage) {
      return previousNavigate.call(this, id, url);
    }

    const win = active.win || active.record.view;
    if (!win || win.isDestroyed?.()) throw new Error('任务临时发布窗口已关闭');
    if (!this.isAllowedQQUrl(url)) throw new Error('内置浏览器只允许打开腾讯 QQ 域名');

    const webContents = win.webContents;
    const targetUrl = new URL(url).href;
    const currentUrl = String(webContents.getURL() || '');

    try { win.show(); win.focus(); } catch (_) {}

    if (currentUrl === targetUrl) {
      return { url: currentUrl, temporary: true, window: true };
    }

    let settled = false;
    const ready = new Promise(resolve => {
      const cleanup = () => {
        try { webContents.removeListener('dom-ready', onReady); } catch (_) {}
        try { webContents.removeListener('did-fail-load', onFail); } catch (_) {}
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onReady = () => done();
      const onFail = (_event, errorCode) => {
        // -3 是 ERR_ABORTED，页面重定向/相同导航经常触发；其他错误也先交给
        // 后续 DOM 等待给出更准确的失败信息。
        if (Number(errorCode) !== -3) done();
      };
      webContents.once('dom-ready', onReady);
      webContents.once('did-fail-load', onFail);
      setTimeout(done, 12000);
    });

    webContents.loadURL(targetUrl).catch(error => {
      const aborted = Number(error?.errno ?? error?.code) === -3
        || /ERR_ABORTED|\(-3\)|Error:\s*-3/i.test(String(error?.message || error));
      if (!aborted) {
        this.db.log('warn', `任务临时发布窗口导航异常：${String(error?.message || error)}`);
      }
    });

    await ready;
    await this.applyWebStorage?.(active.record).catch(() => {});
    return { url: webContents.getURL(), temporary: true, window: true };
  };

  proto.publishTask = async function publishTaskWithFreshWindow(task) {
    const id = this.normalizeInstanceId(task.instance_id);
    const firstTarget = Array.isArray(task.targets)
      ? task.targets.find(target => target.status !== 'success' && target.channel_url)
      : null;

    const lifecycle = await this.createTaskPublishPage(id, task, firstTarget);
    const previousMapRecord = this.views.get(id);
    const lifecycles = lifecycleMap(this);

    // 让现有 publishTask / 油猴 DOM / 评论链透明地拿到临时发布窗口。
    // 这里只替换页面容器，不重写任何发布算法。
    this.views.set(id, lifecycle.record);
    lifecycles.set(id, lifecycle);

    this.db.log('info', `任务 #${task.id} 打开临时 QQ 发布窗口${firstTarget ? `：${firstTarget.channel_name}` : ''}`);

    try {
      // 新任务直接打开目标频道，不先绕到 QQ 首页。
      if (firstTarget?.channel_url) {
        await this.navigate(id, firstTarget.channel_url);
      }
      return await previousPublishTask.call(this, task);
    } finally {
      if (lifecycles.get(id) === lifecycle) {
        lifecycles.delete(id);
      }

      if (this.views.get(id) === lifecycle.record) {
        if (lifecycle.originalRecord?.view?.webContents?.isDestroyed?.()) {
          this.views.delete(id);
        } else {
          this.views.set(id, lifecycle.originalRecord || previousMapRecord);
        }
      }

      await this.closeTaskPublishPage(lifecycle).catch(() => {});
      this.db.log('info', `任务 #${task.id} 临时 QQ 发布窗口已关闭`);
    }
  };
};
