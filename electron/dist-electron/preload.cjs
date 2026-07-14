"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { contextBridge, ipcRenderer } = require('electron');
const BACKEND_METHOD_ALLOWLIST = new Set([
    'app.bootstrap',
    'approval.respond',
    'characters.delete', 'characters.list', 'characters.read', 'characters.rename', 'characters.save',
    'chat.cancel', 'chat.send', 'plan.accept',
    'clarification.respond',
    'connectors.list',
    'knowledge.list', 'knowledge.search', 'knowledge.update',
    'path.open', 'path.preview',
    'profiles.delete', 'profiles.models', 'profiles.save', 'profiles.setActive', 'profiles.test',
    'session.compact', 'session.create', 'session.create_and_send', 'session.delete', 'session.reference.add', 'session.reference.remove', 'session.reference.resolve', 'session.update',
    'settings.save',
    'skills.list', 'skills.skillhub.install', 'skills.skillhub.list', 'skills.skillhub.preview', 'skills.skillhub.uninstall',
    'skills.skillhub.detail', 'skills.skillhub.files', 'skills.skillhub.file', 'skills.skillhub.comments', 'skills.skillhub.versions', 'skills.skillhub.evaluation', 'skills.skillhub.testcases',
    'experts.list',
    'experts.skillhub.list',
    'experts.skillhub.detail',
    'experts.skillhub.install',
    'workspace.files',
]);
const PATH_ACTIONS = new Set(['open']);
let backendEventHandler = null;
function trustedRendererLocation() {
    try {
        const current = new URL(globalThis.location.href);
        return current.protocol === 'file:' || (current.protocol === 'http:' && current.hostname === '127.0.0.1' && current.port === '5173');
    }
    catch {
        return false;
    }
}
if (process.env.RANPARTY_UI_MOCK !== '1' && trustedRendererLocation()) {
    contextBridge.exposeInMainWorld('ranparty', Object.freeze({
        isElectron: true,
        request: (method, params = {}) => {
            if (!BACKEND_METHOD_ALLOWLIST.has(method))
                return Promise.reject(new Error(`不允许调用后端方法：${method}`));
            return ipcRenderer.invoke('backend:request', method, params);
        },
        chooseDirectory: () => ipcRenderer.invoke('dialog:directory'),
        chooseImages: () => ipcRenderer.invoke('dialog:images'),
        chooseFile: () => ipcRenderer.invoke('dialog:file'),
        chooseFileData: () => ipcRenderer.invoke('dialog:fileData'),
        clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
        pathAction: (action, path) => {
            if (!PATH_ACTIONS.has(action))
                return Promise.reject(new Error(`未知文件操作：${action}`));
            return ipcRenderer.invoke('path:action', action, path);
        },
        onEvent: (listener) => {
            if (backendEventHandler)
                ipcRenderer.removeListener('backend:event', backendEventHandler);
            const handler = (_event, payload) => {
                if (!payload || typeof payload !== 'object')
                    return;
                const event = Reflect.get(payload, 'event');
                if (typeof event !== 'string')
                    return;
                listener(event, Reflect.get(payload, 'data'));
            };
            backendEventHandler = handler;
            ipcRenderer.on('backend:event', handler);
            return () => {
                ipcRenderer.removeListener('backend:event', handler);
                if (backendEventHandler === handler)
                    backendEventHandler = null;
            };
        },
    }));
}
