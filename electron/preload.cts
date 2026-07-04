const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

if (process.env.RANPARTY_UI_MOCK !== '1') {
  contextBridge.exposeInMainWorld('ranparty', {
    request: (method: string, params: Record<string, unknown> = {}) => ipcRenderer.invoke('backend:request', method, params),
    chooseDirectory: () => ipcRenderer.invoke('dialog:directory'),
    chooseImages: () => ipcRenderer.invoke('dialog:images'),
    onEvent: (listener: (event: string, data: unknown) => void) => {
      ipcRenderer.removeAllListeners('backend:event')
      const handler = (_event: unknown, payload: { event: string; data: unknown }) => listener(payload.event, payload.data)
      ipcRenderer.on('backend:event', handler)
    },
  })
}
