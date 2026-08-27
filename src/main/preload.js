const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listInstances: () => ipcRenderer.invoke('instances:list'),
  createInstance: (name) => ipcRenderer.invoke('instances:create', name),

  listChannels: (instanceId) => ipcRenderer.invoke('channels:list', instanceId),
  addChannel: (data) => ipcRenderer.invoke('channels:add', data),
  deleteChannel: (id) => ipcRenderer.invoke('channels:delete', id),

  listTasks: (instanceId) => ipcRenderer.invoke('tasks:list', instanceId),
  createTask: (data) => ipcRenderer.invoke('tasks:create', data),
  runTask: (id) => ipcRenderer.invoke('tasks:run', id),
  retryFailedTask: (id) => ipcRenderer.invoke('tasks:retryFailed', id),

  schedulerStart: (instanceId) => ipcRenderer.invoke('scheduler:start', instanceId),
  schedulerPause: (instanceId) => ipcRenderer.invoke('scheduler:pause', instanceId),
  schedulerResume: (instanceId) => ipcRenderer.invoke('scheduler:resume', instanceId),
  schedulerStop: (instanceId) => ipcRenderer.invoke('scheduler:stop', instanceId),
  schedulerState: (instanceId) => ipcRenderer.invoke('scheduler:state', instanceId),

  listSelectors: () => ipcRenderer.invoke('selectors:list'),
  saveSelector: (data) => ipcRenderer.invoke('selectors:save', data),
  testSelector: (data) => ipcRenderer.invoke('selectors:test', data),

  openLogin: (instanceId) => ipcRenderer.invoke('browser:login', instanceId),
  getLoginStatus: (instanceId) => ipcRenderer.invoke('browser:status', instanceId),
  setBrowserView: (data) => ipcRenderer.invoke('browser:view', data),
  browserHome: (instanceId) => ipcRenderer.invoke('browser:home', instanceId),
  browserBack: (instanceId) => ipcRenderer.invoke('browser:back', instanceId),
  browserReload: (instanceId) => ipcRenderer.invoke('browser:reload', instanceId),

  listSettings: () => ipcRenderer.invoke('settings:list'),
  setSetting: (data) => ipcRenderer.invoke('settings:set', data),

  pickVideo: () => ipcRenderer.invoke('dialog:video'),
  pickImage: () => ipcRenderer.invoke('dialog:image'),
  pickVideoFolder: () => ipcRenderer.invoke('dialog:videoFolder'),
  listLogs: () => ipcRenderer.invoke('logs:list')
});
