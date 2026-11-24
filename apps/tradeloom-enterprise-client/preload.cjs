const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tradeloomEnterprise', {
  getConfig: () => ipcRenderer.invoke('enterprise:get-config'),
  connect: (serverOrigin) => ipcRenderer.invoke('enterprise:connect', serverOrigin),
})
