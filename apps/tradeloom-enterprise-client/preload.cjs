const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tradeloomEnterprise', {
  getConfig: () => ipcRenderer.invoke('enterprise:get-config'),
  signIn: (credentials) => ipcRenderer.invoke('enterprise:sign-in', credentials),
})
