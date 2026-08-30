const { contextBridge, ipcRenderer } = require('electron');

// 实例窗口通过 ?instanceId=xx 固定绑定账号。app.js 启动时会默认选择
// listInstances() 返回的第一项，因此这里从源头把当前窗口实例排到第一位，
// 避免新窗口先拿“实例 1”的登录状态、频道和任务，再异步切回自己的实例。
const fixedInstanceId = (() => {
  try {
    return Math.max(0, Number(new URLSearchParams(globalThis.location?.search || '').get('instanceId')) || 0);
  } catch (_) {
    return 0;
  }
})();

async function listInstancesForCurrentWindow() {
  const rows = await ipcRenderer.invoke('instances:list');
  if (!fixedInstanceId || !Array.isArray(rows)) return rows;
  const own = rows.find(item => Number(item.id) === fixedInstanceId);
  if (!own) return rows;
  return [own, ...rows.filter(item => Number(item.id) !== fixedInstanceId)];
}

contextBridge.exposeInMainWorld('api', {
  listInstances: () => listInstancesForCurrentWindow(),
  fixedInstanceId: () => fixedInstanceId || null,
  createInstance: (name) => ipcRenderer.invoke('instances:create', name),
  updateInstanceName: (data) => ipcRenderer.invoke('instances:updateName', data),
  getInstanceSummary: (id) => ipcRenderer.invoke('instances:summary', id),
  deleteInstance: (id) => ipcRenderer.invoke('instances:delete', id),
  openInstanceWindow: (data) => ipcRenderer.invoke('instanceWindows:open', data),
  hideCoordinatorWindow: () => ipcRenderer.invoke('instanceWindows:hideCoordinator'),
  showCoordinatorWindow: () => ipcRenderer.invoke('instanceWindows:showCoordinator'),

  listChannels: (instanceId) => ipcRenderer.invoke('channels:list', instanceId),
  listChannelAssignments: () => ipcRenderer.invoke('channels:overview'),
  moveChannel: (data) => ipcRenderer.invoke('channels:move', data),
  addChannel: (data) => ipcRenderer.invoke('channels:add', data),
  updateChannelName: (data) => ipcRenderer.invoke('channels:updateName', data),
  deleteChannel: (id) => ipcRenderer.invoke('channels:delete', id),
  listRemoteChannels: (instanceId) => ipcRenderer.invoke('channels:remoteList', instanceId),
  importRemoteChannels: (data) => ipcRenderer.invoke('channels:importRemote', data),

  listTasks: (data) => ipcRenderer.invoke('tasks:list', data),
  getPendingTaskSummary: (instanceId) => ipcRenderer.invoke('tasks:pendingSummary', instanceId),
  createTask: (data) => ipcRenderer.invoke('tasks:create', data),
  deleteTasks: (ids) => ipcRenderer.invoke('tasks:deleteMany', ids),
  runTask: (id) => ipcRenderer.invoke('tasks:run', id),
  retryFailedTask: (id) => ipcRenderer.invoke('tasks:retryFailed', id),

  schedulerStart: (instanceId) => ipcRenderer.invoke('scheduler:start', instanceId),
  schedulerPause: (instanceId) => ipcRenderer.invoke('scheduler:pause', instanceId),
  schedulerResume: (instanceId) => ipcRenderer.invoke('scheduler:resume', instanceId),
  schedulerStop: (instanceId) => ipcRenderer.invoke('scheduler:stop', instanceId),
  schedulerState: (instanceId) => ipcRenderer.invoke('scheduler:state', instanceId),
  schedulerStartAll: () => ipcRenderer.invoke('scheduler:startAll'),
  schedulerStopAll: () => ipcRenderer.invoke('scheduler:stopAll'),

  listSelectors: () => ipcRenderer.invoke('selectors:list'),
  saveSelector: (data) => ipcRenderer.invoke('selectors:save', data),
  testSelector: (data) => ipcRenderer.invoke('selectors:test', data),

  openLogin: (instanceId) => ipcRenderer.invoke('browser:login', instanceId),
  getLoginStatus: (instanceId) => ipcRenderer.invoke('browser:status', instanceId),
  logoutQQ: (instanceId) => ipcRenderer.invoke('browser:logout', instanceId),
  pollPublisherLogin: (instanceId) => ipcRenderer.invoke('publisher:pollLogin', instanceId),
  setBrowserView: (data) => ipcRenderer.invoke('browser:view', data),
  browserHome: (instanceId) => ipcRenderer.invoke('browser:home', instanceId),
  browserBack: (instanceId) => ipcRenderer.invoke('browser:back', instanceId),
  browserReload: (instanceId) => ipcRenderer.invoke('browser:reload', instanceId),

  listSettings: () => ipcRenderer.invoke('settings:list'),
  setSetting: (data) => ipcRenderer.invoke('settings:set', data),

  pickVideo: () => ipcRenderer.invoke('dialog:video'),
  pickImage: () => ipcRenderer.invoke('dialog:image'),
  pickVideoFolder: () => ipcRenderer.invoke('dialog:videoFolder'),
  listLogs: () => ipcRenderer.invoke('logs:list'),
  onPublishUpdate: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('publish:update', listener);
    return () => ipcRenderer.removeListener('publish:update', listener);
  }
});
