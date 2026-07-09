"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { contextBridge, ipcRenderer } = require('electron');
if (process.env.RANPARTY_UI_MOCK !== '1') {
    contextBridge.exposeInMainWorld('ranparty', {
        isElectron: true,
        request: (method, params = {}) => ipcRenderer.invoke('backend:request', method, params),
        chooseDirectory: () => ipcRenderer.invoke('dialog:directory'),
        chooseImages: () => ipcRenderer.invoke('dialog:images'),
        chooseFile: () => ipcRenderer.invoke('dialog:file'),
        clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
        pathAction: (action, path) => ipcRenderer.invoke('path:action', action, path),
        onEvent: (listener) => {
            ipcRenderer.removeAllListeners('backend:event');
            const handler = (_event, payload) => listener(payload.event, payload.data);
            ipcRenderer.on('backend:event', handler);
        },
    });
}
