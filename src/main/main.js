const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const DB = require('./db');
const BrowserManager = require('./browser');

let db;
let browserManager;

function createWindow() {
  const win = new BrowserWindow({
    width: 1450,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  db = new DB(app.getPath('userData'));
  browserManager = new BrowserManager(app.getPath('userData'), db);
  registerIPC();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerIPC() {
  ipcMain.handle('instances:list', () => db.listInstances());
  ipcMain.handle('instances:create', (_, name) => db.createInstance(name));

  ipcMain.handle('channels:list', (_, instanceId) => db.listChannels(instanceId));
  ipcMain.handle('channels:add', (_, data) => db.addChannel(data.instanceId, data.name, data.url));
  ipcMain.handle('channels:delete', (_, id) => db.deleteChannel(id));

  ipcMain.handle('tasks:list', (_, instanceId) => db.listTasks(instanceId));
  ipcMain.handle('tasks:create', (_, data) => db.createTask(data.instanceId, data.title, data.body, data.mediaPath, data.channelIds));
  ipcMain.handle('tasks:run', async (_, taskId) => {
    const task = db.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    return browserManager.publishTask(task);
  });
  ipcMain.handle('tasks:retryFailed', async (_, taskId) => {
    db.resetFailedTargets(taskId);
    const task = db.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    return browserManager.publishTask(task);
  });

  ipcMain.handle('selectors:list', () => db.getSelectors());
  ipcMain.handle('selectors:save', (_, data) => db.saveSelector(data.key, data.value, data.timeout));
  ipcMain.handle('selectors:test', async (_, data) => browserManager.testSelector(data.instanceId, data.selector, data.url));

  ipcMain.handle('browser:login', async (_, instanceId) => browserManager.openLogin(instanceId));
  ipcMain.handle('browser:status', async (_, instanceId) => browserManager.getLoginStatus(instanceId));

  ipcMain.handle('settings:list', () => db.listSettings());
  ipcMain.handle('settings:set', (_, data) => db.setSetting(data.key, data.value));

  ipcMain.handle('dialog:video', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv'] }]
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('logs:list', () => db.listLogs());
}
