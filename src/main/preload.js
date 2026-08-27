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
  listSelectors: () => ipcRenderer.invoke('selectors:list'),
  saveSelector: (data) => ipcRenderer.invoke('selectors:save', data),
  testSelector: (data) => ipcRenderer.invoke('selectors:test', data),
  openLogin: (instanceId) => ipcRenderer.invoke('browser:login', instanceId),
  pickVideo: () => ipcRenderer.invoke('dialog:video'),
  listLogs: () => ipcRenderer.invoke('logs:list')
});
