const { WebContentsView } = require('electron');

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

  proto.createTaskPublishPage = async function createTaskPublishPage(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const originalRecord = await this.getOrCreateView(id);
    const hostWindow = originalRecord.hostWindow
      || this.getInstanceHostWindow?.(id)
      || this.mainWindow;

    const view = new WebContentsView({
      webPreferences: {
        session: originalRecord.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false
      }
    });

    view.setBackgroundColor('#ffffff');
    view.setBounds(this.lastBounds);
    view.setVisible(false);

    const record = {
      instanceId: id,
      view,
      session: originalRecord.session,
      restored: true,
      webStorage: null,
      storageApplied: true,
      hostWindow,
      temporaryPublishPage: true
    };

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (this.isAllowedQQUrl(url)) {
        setImmediate(() => this.navigate(id, url).catch(error => {
          this.db.log('warn', `任务临时页面打开 QQ 链接失败：${String(error?.message || error)}`);
        }));
      }
      return { action: 'deny' };
    });

    view.webContents.on('will-navigate', (event, url) => {
      if (!this.isAllowedQQUrl(url)) event.preventDefault();
    });

    view.webContents.on('render-process-gone', (_, details) => {
      this.db.log('error', `实例 #${id} 任务临时 QQ 页面异常退出：${details.reason}`);
    });

    try { originalRecord.view.setVisible(false); } catch (_) {}
    hostWindow.contentView.addChildView(view);
    view.setVisible(true);

    return { id, originalRecord, record, hostWindow };
  };

  proto.closeTaskPublishPage = async function closeTaskPublishPage(lifecycle) {
    const record = lifecycle?.record;
    if (!record?.view) return;

    const webContents = record.view.webContents;
    try { record.view.setVisible(false); } catch (_) {}
    try { lifecycle.hostWindow?.contentView?.removeChildView(record.view); } catch (_) {}
    try {
      if (!webContents.isDestroyed() && webContents.debugger?.isAttached?.()) {
        webContents.debugger.detach();
      }
    } catch (_) {}
    try {
      if (!webContents.isDestroyed()) webContents.close({ waitForBeforeUnload: false });
    } catch (_) {}
  };

  // 发布任务运行期间，navigate 只操作该实例当前任务创建的临时 QQ 页面。
  // 对同一个 URL 不再等待 did-stop-loading；油猴 DOM 自己会等待目标元素出现，
  // 因此页面 DOM 一可用就可以继续，不必等 QQ 的全部资源加载完。
  proto.navigate = async function navigateTaskPageAware(instanceId, url = 'https://pd.qq.com/') {
    const id = this.normalizeInstanceId(instanceId);
    const active = lifecycleMap(this).get(id);
    if (!active || !active.record?.temporaryPublishPage) {
      return previousNavigate.call(this, id, url);
    }

    if (!this.isAllowedQQUrl(url)) throw new Error('内置浏览器只允许打开腾讯 QQ 域名');
    const webContents = active.record.view.webContents;
    const targetUrl = new URL(url).href;
    const currentUrl = String(webContents.getURL() || '');

    if (currentUrl === targetUrl) {
      return { url: currentUrl, temporary: true };
    }

    let domReady = false;
    const ready = new Promise(resolve => {
      const onReady = () => {
        domReady = true;
        resolve();
      };
      webContents.once('dom-ready', onReady);
      setTimeout(() => {
        if (!domReady) {
          try { webContents.removeListener('dom-ready', onReady); } catch (_) {}
          resolve();
        }
      }, 10000);
    });

    webContents.loadURL(targetUrl).catch(error => {
      const aborted = Number(error?.errno ?? error?.code) === -3
        || /ERR_ABORTED|\(-3\)|Error:\s*-3/i.test(String(error?.message || error));
      if (!aborted) {
        this.db.log('warn', `任务临时页面导航异常：${String(error?.message || error)}`);
      }
    });

    await Promise.race([ready, sleep(10000)]);
    return { url: webContents.getURL(), temporary: true };
  };

  proto.publishTask = async function publishTaskWithFreshPage(task) {
    const id = this.normalizeInstanceId(task.instance_id);
    const lifecycle = await this.createTaskPublishPage(id);
    const previousMapRecord = this.views.get(id);
    const lifecycles = lifecycleMap(this);

    // 让现有 publishTask / 油猴 DOM / 评论链透明地拿到临时页面。
    // 这里只替换页面容器，不重写任何发布算法。
    this.views.set(id, lifecycle.record);
    lifecycles.set(id, lifecycle);

    const firstTarget = Array.isArray(task.targets)
      ? task.targets.find(target => target.status !== 'success' && target.channel_url)
      : null;

    this.db.log('info', `任务 #${task.id} 创建临时 QQ 发布页${firstTarget ? `：${firstTarget.channel_name}` : ''}`);

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
      this.db.log('info', `任务 #${task.id} 临时 QQ 发布页已关闭`);
    }
  };
};
