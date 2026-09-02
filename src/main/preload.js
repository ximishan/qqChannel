const { contextBridge, ipcRenderer } = require('electron');

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

async function createInstanceWithoutSwitchingCurrentWindow(name) {
  const created = await ipcRenderer.invoke('instances:create', name);
  if (!fixedInstanceId) return created;
  return { ...created, createdInstanceId: Number(created.id), id: fixedInstanceId };
}

contextBridge.exposeInMainWorld('api', {
  listInstances: () => listInstancesForCurrentWindow(),
  fixedInstanceId: () => fixedInstanceId || null,
  createInstance: name => createInstanceWithoutSwitchingCurrentWindow(name),
  updateInstanceName: data => ipcRenderer.invoke('instances:updateName', data),
  getInstanceSummary: id => ipcRenderer.invoke('instances:summary', id),
  deleteInstance: id => ipcRenderer.invoke('instances:delete', id),
  openInstanceWindow: data => ipcRenderer.invoke('instanceWindows:open', data),
  hideCoordinatorWindow: () => ipcRenderer.invoke('instanceWindows:hideCoordinator'),
  showCoordinatorWindow: () => ipcRenderer.invoke('instanceWindows:showCoordinator'),

  listChannels: instanceId => ipcRenderer.invoke('channels:list', instanceId),
  updateChannelName: data => ipcRenderer.invoke('channels:updateName', data),
  deleteChannel: id => ipcRenderer.invoke('channels:delete', id),
  listRemoteChannels: instanceId => ipcRenderer.invoke('channels:remoteList', instanceId),
  importRemoteChannels: data => ipcRenderer.invoke('channels:importRemote', data),

  listTasks: data => ipcRenderer.invoke('tasks:list', data),
  getPendingTaskSummary: instanceId => ipcRenderer.invoke('tasks:pendingSummary', instanceId),
  createTask: data => ipcRenderer.invoke('tasks:create', data),
  deleteTasks: ids => ipcRenderer.invoke('tasks:deleteMany', ids),
  runTask: id => ipcRenderer.invoke('tasks:run', id),
  retryFailedTask: id => ipcRenderer.invoke('tasks:retryFailed', id),

  schedulerStart: instanceId => ipcRenderer.invoke('scheduler:start', instanceId),
  schedulerPause: instanceId => ipcRenderer.invoke('scheduler:pause', instanceId),
  schedulerResume: instanceId => ipcRenderer.invoke('scheduler:resume', instanceId),
  schedulerStop: instanceId => ipcRenderer.invoke('scheduler:stop', instanceId),
  schedulerState: instanceId => ipcRenderer.invoke('scheduler:state', instanceId),
  schedulerStartAll: () => ipcRenderer.invoke('scheduler:startAll'),
  schedulerStopAll: () => ipcRenderer.invoke('scheduler:stopAll'),

  openLogin: instanceId => ipcRenderer.invoke('browser:login', instanceId),
  getLoginStatus: instanceId => ipcRenderer.invoke('browser:status', instanceId),
  logoutQQ: instanceId => ipcRenderer.invoke('browser:logout', instanceId),
  pollPublisherLogin: instanceId => ipcRenderer.invoke('publisher:pollLogin', instanceId),
  setBrowserView: data => ipcRenderer.invoke('browser:view', data),
  browserHome: instanceId => ipcRenderer.invoke('browser:home', instanceId),
  browserBack: instanceId => ipcRenderer.invoke('browser:back', instanceId),
  browserReload: instanceId => ipcRenderer.invoke('browser:reload', instanceId),

  listSettings: () => ipcRenderer.invoke('settings:list'),
  setSetting: data => ipcRenderer.invoke('settings:set', data),

  pickVideo: () => ipcRenderer.invoke('dialog:video'),
  pickImage: () => ipcRenderer.invoke('dialog:image'),
  pickVideoFolder: () => ipcRenderer.invoke('dialog:videoFolder'),
  listLogs: () => ipcRenderer.invoke('logs:list'),
  onPublishUpdate: callback => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('publish:update', listener);
    return () => ipcRenderer.removeListener('publish:update', listener);
  }
});
