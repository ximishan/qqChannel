const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const DB = require('./db');
const BrowserManager = require('./browser');
const TaskScheduler = require('./scheduler');

let db;
let browserManager;
let scheduler;
let mainWindow;

app.setPath('userData', path.join(app.getPath('appData'), 'tencent-channel-publisher-demo'));

function createWindow() {
  const win = new BrowserWindow({
    width: 1450,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  db = new DB(app.getPath('userData'));
  mainWindow = createWindow();
  browserManager = new BrowserManager(app.getPath('userData'), db, mainWindow);
  scheduler = new TaskScheduler(db, browserManager);
  registerIPC();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function schedulerIsBusy(instanceId) {
  if (!scheduler) return false;
  const state = scheduler.getState(instanceId);
  return ['running', 'waiting', 'paused'].includes(state.status) || Boolean(state.currentTaskId);
}

async function hidePublishingBrowser(instanceId) {
  if (!browserManager) return;
  await browserManager.setViewState({ instanceId, visible: false });
}

function registerIPC() {
  ipcMain.handle('instances:list', () => db.listInstances());
  ipcMain.handle('instances:create', (_, name) => {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('频道分组名称不能为空');
    const result = db.createInstance(cleanName);
    return { id: Number(result.lastInsertRowid), name: cleanName };
  });
  ipcMain.handle('instances:updateName', (_, data) => db.updateInstanceName(data.id, data.name));
  ipcMain.handle('instances:summary', (_, id) => db.getInstanceSummary(id));
  ipcMain.handle('instances:delete', async (_, id) => {
    const instanceId = Number(id);
    if (schedulerIsBusy(instanceId)) throw new Error('该频道分组的发布队列正在运行，请先停止队列');
    const summary = db.getInstanceSummary(instanceId);
    if (Number(summary.running_task_count) > 0) throw new Error('该频道分组仍有正在发布的任务，请等待任务完成');
    await browserManager.destroyInstance(instanceId);
    return db.deleteInstance(instanceId);
  });

  ipcMain.handle('channels:list', (_, instanceId) => db.listChannels(instanceId));
  ipcMain.handle('channels:overview', () => db.listChannelAssignments());
  ipcMain.handle('channels:move', (_, data) => db.moveChannel(data.id, data.instanceId));
  ipcMain.handle('channels:add', (_, data) => db.addChannel(data.instanceId, data.name, data.url));
  ipcMain.handle('channels:updateName', (_, data) => db.updateChannelName(data.id, data.name));
  ipcMain.handle('channels:delete', (_, id) => db.deleteChannel(id));

  ipcMain.handle('tasks:list', (_, data) => db.listTasks(data.instanceId, data.page, data.pageSize));
  ipcMain.handle('tasks:pendingSummary', (_, instanceId) => db.getPendingTaskSummary(instanceId));
  ipcMain.handle('tasks:create', (_, data) => db.createTask(data.instanceId, data.title, data.body, data.mediaPath, data.channelIds, data.mediaType, data.scheduledAt, data.intervalMinSeconds, data.intervalMaxSeconds));
  ipcMain.handle('tasks:deleteMany', (_, taskIds) => db.deleteTasks(taskIds));
  ipcMain.handle('tasks:run', async (_, taskId) => {
    const task = db.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    if (schedulerIsBusy(task.instance_id)) throw new Error('当前频道分组的发布队列正在运行，请先停止队列后再手动执行任务');
    if (!task.targets || task.targets.length === 0) throw new Error('当前任务没有目标频道，无法执行');
    const executableTargets = task.targets.filter(target => target.status !== 'success');
    if (executableTargets.length === 0) throw new Error(`任务 #${task.id} 已经全部发布成功`);
    await hidePublishingBrowser(task.instance_id);
    return browserManager.publishTask(task);
  });
  ipcMain.handle('tasks:retryFailed', async (_, taskId) => {
    const before = db.getTask(taskId);
    if (!before) throw new Error('任务不存在');
    if (schedulerIsBusy(before.instance_id)) throw new Error('当前频道分组的发布队列正在运行，请先停止队列');
    if (!before.targets?.some(target => target.status === 'failed')) throw new Error(`任务 #${taskId} 没有失败的目标频道`);
    db.resetFailedTargets(taskId);
    const task = db.getTask(taskId);
    await hidePublishingBrowser(task.instance_id);
    return browserManager.publishTask(task);
  });

  ipcMain.handle('scheduler:start', async (_, instanceId) => { await hidePublishingBrowser(instanceId); return scheduler.start(instanceId); });
  ipcMain.handle('scheduler:pause', (_, instanceId) => scheduler.pause(instanceId));
  ipcMain.handle('scheduler:resume', async (_, instanceId) => { await hidePublishingBrowser(instanceId); return scheduler.resume(instanceId); });
  ipcMain.handle('scheduler:stop', (_, instanceId) => scheduler.stop(instanceId));
  ipcMain.handle('scheduler:state', (_, instanceId) => scheduler.getState(instanceId));

  ipcMain.handle('selectors:list', () => db.getSelectors());
  ipcMain.handle('selectors:save', (_, data) => db.saveSelector(data.key, data.value, data.timeout));
  ipcMain.handle('selectors:test', async (_, data) => browserManager.testSelector(data.instanceId, data.selector, data.url));

  ipcMain.handle('browser:login', async () => browserManager.beginPublishingLogin());
  ipcMain.handle('browser:status', async () => browserManager.getPublishingLoginStatus());
  ipcMain.handle('browser:logout', async () => browserManager.logoutPublishing());
  ipcMain.handle('publisher:pollLogin', async () => browserManager.pollPublishingLogin());
  ipcMain.handle('browser:view', async (_, data) => browserManager.setViewState(data));
  ipcMain.handle('browser:home', async (_, instanceId) => browserManager.navigate(instanceId));
  ipcMain.handle('browser:back', async (_, instanceId) => browserManager.goBack(instanceId));
  ipcMain.handle('browser:reload', async (_, instanceId) => browserManager.reload(instanceId));

  ipcMain.handle('settings:list', () => db.listSettings());
  ipcMain.handle('settings:set', (_, data) => db.setSetting(data.key, data.value));

  ipcMain.handle('dialog:video', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:image', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Image', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:videoFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const folder = r.filePaths[0];
    const supported = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.wmv']);
    const files = fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())).map(entry => path.join(folder, entry.name)).sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-CN', { numeric: true, sensitivity: 'base' }));
    return { folder, files };
  });

  ipcMain.handle('logs:list', () => db.listLogs());
}
