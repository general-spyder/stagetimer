const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  cmd: c => ipcRenderer.invoke('cmd', c),
  fonts: () => ipcRenderer.invoke('fonts'),
  displays: () => ipcRenderer.invoke('displays'),
  openExternal: u => ipcRenderer.invoke('openExternal', u)
});
