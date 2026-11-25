'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tradeLoomServer', {
  invoke: (action, input) => ipcRenderer.invoke('tl-server:invoke', action, input),
})
