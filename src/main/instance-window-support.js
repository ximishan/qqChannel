const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

module.exports = function installInstanceWindowSupport(BrowserManager) {
  const instanceWindows = global.__QQCHANNEL_INSTANCE_WINDOWS__ || new Map();
  global.__QQCHANNEL_INSTANCE_WINDOWS__ = instanceWindows;
  let coordinatorWindow = null;

  function windowTitle(instanceId, name) {
    const label = String(name || '').trim();
    return label
      ? `腾讯频道批量发布工具 - ${label}`
      : `腾讯频道批量发布工具 - 实例 #${instanceId}`;
  }

  function createInstanceWindow(instanceId, name = '') {
    const id = Number(instanceId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('实例 ID 无效');

    const existing = instanceWindows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }

    const offset = (instanceWindows.size % 8) * 26;
    const win = new BrowserWindow({
      width: 1450,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      x: 30 + offset,
      y: 30 + offset,
      autoHideMenuBar: true,
      title: windowTitle(id, name),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    win.setMenuBarVisibility(false);
    instanceWindows.set(id, win);
    win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: { instanceId: String(id) }
    });

    win.on('closed', () => {
      if (instanceWindows.get(id) === win) instanceWindows.delete(id);
      if (instanceWindows.size === 0 && coordinatorWindow && !coordinatorWindow.isDestroyed() && !coordinatorWindow.isVisible()) {
        coordinatorWindow.show();
        coordinatorWindow.focus();
      }
    });

    return win;
  }

  ipcMain.handle('instanceWindows:open', (_, data) => {
    const id = Number(data?.instanceId ?? data);
    const name = String(data?.name || '');
    const win = createInstanceWindow(id, name);
    return { instanceId: id, opened: true, focused: true, title: win.getTitle() };
  });

  ipcMain.handle('instanceWindows:hideCoordinator', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { hidden: false };
    coordinatorWindow = win;
    win.hide();
    return { hidden: true };
  });

  ipcMain.handle('instanceWindows:showCoordinator', () => {
    if (!coordinatorWindow || coordinatorWindow.isDestroyed()) return { shown: false };
    coordinatorWindow.show();
    coordinatorWindow.focus();
    return { shown: true };
  });

  const originalGetOrCreateView = BrowserManager.prototype.getOrCreateView;
  BrowserManager.prototype.getOrCreateView = async function getOrCreateViewForInstanceWindow(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const record = await originalGetOrCreateView.call(this, id);
    const target = instanceWindows.get(id);

    if (target && !target.isDestroyed() && record.hostWindow !== target) {
      const currentHost = record.hostWindow || this.mainWindow;
      try { currentHost?.contentView?.removeChildView(record.view); } catch (_) {}
      try {
        target.contentView.addChildView(record.view);
        record.hostWindow = target;
      } catch (_) {
        try { this.mainWindow.contentView.addChildView(record.view); } catch (_) {}
        record.hostWindow = this.mainWindow;
      }
    } else if (!record.hostWindow) {
      record.hostWindow = this.mainWindow;
    }

    return record;
  };

  BrowserManager.prototype.notifyPublishUpdate = function notifyPublishUpdateForWindow(data) {
    const id = Number(data?.instanceId || 0);
    const target = instanceWindows.get(id);
    if (target && !target.isDestroyed()) {
      target.webContents.send('publish:update', data);
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('publish:update', data);
    }
  };

  BrowserManager.prototype.setViewState = async function setViewStateForInstanceWindow({ instanceId, visible, bounds }) {
    if (bounds) this.lastBounds = this.normalizeBounds(bounds);
    const id = Number(instanceId);

    if (!id || !visible) {
      if (this.views.has(id)) this.views.get(id).view.setVisible(false);
      if (this.activeInstanceId === id) this.activeInstanceId = null;
      return { visible: false };
    }

    const record = await this.getOrCreateView(id);
    const host = record.hostWindow || instanceWindows.get(id) || this.mainWindow;

    for (const [otherId, otherRecord] of this.views) {
      if (otherId !== id && (otherRecord.hostWindow || this.mainWindow) === host) {
        otherRecord.view.setVisible(false);
      }
    }

    record.view.setBounds(this.lastBounds);
    record.view.setVisible(true);
    this.activeInstanceId = id;
    return { visible: true, url: record.view.webContents.getURL(), instanceId: id };
  };

  const originalDestroyInstance = BrowserManager.prototype.destroyInstance;
  BrowserManager.prototype.destroyInstance = async function destroyInstanceWindowAware(instanceId) {
    const id = this.normalizeInstanceId(instanceId);
    const record = this.views.get(id);
    if (record?.hostWindow && record.hostWindow !== this.mainWindow) {
      try { record.hostWindow.contentView.removeChildView(record.view); } catch (_) {}
      try { this.mainWindow.contentView.addChildView(record.view); } catch (_) {}
      record.hostWindow = this.mainWindow;
    }
    const win = instanceWindows.get(id);
    if (win && !win.isDestroyed()) win.close();
    instanceWindows.delete(id);
    return originalDestroyInstance.call(this, id);
  };

  BrowserManager.prototype.getInstanceHostWindow = function getInstanceHostWindow(instanceId) {
    const id = Number(instanceId);
    const win = instanceWindows.get(id);
    return win && !win.isDestroyed() ? win : this.mainWindow;
  };

  BrowserManager.createInstanceWindow = createInstanceWindow;
};
