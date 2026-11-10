const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('harbor', {
  request: (method, params) => ipcRenderer.invoke('harbor:request', method, params),
  info: () => ipcRenderer.invoke('harbor:info'),
  chooseFolder: () => ipcRenderer.invoke('harbor:folder'),
  confirm: options => ipcRenderer.invoke('harbor:confirm', options),
  openExternal: url => ipcRenderer.invoke('harbor:external', url),
  pathForFile: file => webUtils.getPathForFile(file),
  copy: text => ipcRenderer.invoke('harbor:copy', text),
  paste: () => ipcRenderer.invoke('harbor:paste'),
  dataFolder: () => ipcRenderer.invoke('harbor:data-folder'),
  context: session => ipcRenderer.invoke('harbor:context', session),
  onEvent: callback => { const listener = (_event, message) => callback(message); ipcRenderer.on('harbor:event', listener); return () => ipcRenderer.removeListener('harbor:event', listener); },
});
