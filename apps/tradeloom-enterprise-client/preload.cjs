const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tradeloomEnterprise', {
  getConfig: () => ipcRenderer.invoke('enterprise:get-config'),
  signIn: (credentials) => ipcRenderer.invoke('enterprise:sign-in', credentials),
  verifyCode: (code) => ipcRenderer.invoke('enterprise:verify-code', code),
  resendCode: () => ipcRenderer.invoke('enterprise:resend-code'),
  restartLogin: () => ipcRenderer.invoke('enterprise:restart-login'),
})
