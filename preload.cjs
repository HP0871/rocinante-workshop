const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rocinanteProjects', {
  list: () => ipcRenderer.invoke('projects:list'),
  create: (name, bundle) => ipcRenderer.invoke('projects:create', name, bundle),
  save: (filePath, bundle) => ipcRenderer.invoke('projects:save', filePath, bundle),
  load: filePath => ipcRenderer.invoke('projects:load', filePath),
  remove: filePath => ipcRenderer.invoke('projects:delete', filePath),
  open: () => ipcRenderer.invoke('projects:open')
});
