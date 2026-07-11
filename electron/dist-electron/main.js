import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let window = null;
let backend = null;
let backendLines = null;
let requestCounter = 0;
let backendRestartAttempts = 0;
let backendRestartTimer = null;
let shuttingDown = false;
const pending = new Map();
/** 拒绝所有挂起的请求 — 后端断开时复用 */
function rejectAllPending(message) {
    for (const item of pending.values())
        item.reject(new Error(message));
    pending.clear();
}
/**
 * 可交给系统默认程序打开的非活动内容扩展名。
 *
 * 脚本、源代码、HTML 与 SVG 有被系统关联到解释器/浏览器后直接执行的风险，
 * 因此只能在应用内的只读沙箱预览中查看，不能通过 path.open 启动。
 */
const SAFE_OPEN_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.css',
    '.json', '.jsonl', '.csv', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
    '.pdf', '.docx', '.xlsx', '.pptx',
    '.log',
]);
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
    'workspace.files',
]);
const PATH_ACTIONS = new Set(['open']);
const MAX_CLIPBOARD_TEXT_LENGTH = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BROWSER_PARTITION = 'persist:ranparty-browser';
const hardenedSessions = new WeakSet();
// Keep synchronized with electron/index.html. The response header protects Vite's head-prepended dev scripts;
// the meta tag protects the packaged file:// renderer where response headers are unavailable.
const RENDERER_CSP = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'self' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173; frame-src 'self' about: data: blob:; object-src data: blob:; media-src 'self' data: blob:; worker-src 'self' blob:; manifest-src 'self'";
/** 对 URL 做 scheme 白名单校验，非 http/https 则拒绝 */
function safeUrl(target) {
    if (typeof target !== 'string' || target.length > 4096)
        throw new Error('链接无效或过长');
    const trimmed = target.trim();
    if (!trimmed)
        throw new Error('链接不能为空');
    const hasScheme = /^[a-z][a-z0-9+\-.]*:/i.test(trimmed);
    const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error('仅支持 http/https 链接');
    if (parsed.username || parsed.password)
        throw new Error('链接不能包含登录凭据');
    return parsed.href;
}
/** Remote content hosted inside the application must never downgrade to cleartext HTTP. */
function safeWebviewUrl(target) {
    const url = safeUrl(target);
    if (new URL(url).protocol !== 'https:')
        throw new Error('内置浏览器仅支持 HTTPS 链接');
    return url;
}
/** Electron grants several web permissions by default unless both handlers are set. */
function denyAllWebPermissions(targetSession) {
    if (hardenedSessions.has(targetSession))
        return;
    hardenedSessions.add(targetSession);
    targetSession.setPermissionCheckHandler(() => false);
    targetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    targetSession.setDevicePermissionHandler(() => false);
    targetSession.on('will-download', (event) => event.preventDefault());
}
// Cover the default session, the browser partition, and any future partition created by Electron.
app.on('session-created', denyAllWebPermissions);
function isTrustedRendererUrl(target) {
    try {
        const parsed = new URL(target);
        if (!app.isPackaged) {
            return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port === '5173';
        }
        if (parsed.protocol !== 'file:')
            return false;
        const expected = path.resolve(__dirname, '..', 'dist', 'index.html');
        return path.resolve(fileURLToPath(parsed)) === expected;
    }
    catch {
        return false;
    }
}
function assertTrustedIpc(event) {
    const owner = window;
    if (!owner || owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(event.senderFrame.url)) {
        throw new Error('拒绝来自非可信渲染页面的 IPC 请求');
    }
}
function ownerWindow() {
    if (!window || window.isDestroyed())
        throw new Error('应用窗口尚未就绪');
    return window;
}
function plainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function existingLocalTarget(target) {
    if (typeof target !== 'string' || target.length === 0 || target.length > 32767 || target.includes('\0')) {
        throw new Error('文件路径无效或过长');
    }
    const trimmed = target.trim();
    if (!path.isAbsolute(trimmed))
        throw new Error('仅支持绝对文件路径');
    const normalized = path.normalize(trimmed);
    if (normalized.startsWith('\\\\'))
        throw new Error('不支持网络共享或设备路径');
    if (!existsSync(normalized))
        throw new Error('目标文件不存在');
    const resolved = realpathSync.native(normalized);
    const stats = statSync(resolved);
    return { path: resolved, stats };
}
function assertSafeOpenExtension(target) {
    const ext = path.extname(target).toLowerCase();
    if (!SAFE_OPEN_EXTENSIONS.has(ext)) {
        throw new Error(`出于安全考虑，不支持直接打开 ${ext || '无扩展名'} 类型文件，请使用系统文件管理器手动打开。`);
    }
}
function assertSafeBackendOpen(params) {
    const local = existingLocalTarget(params.path);
    if (!local.stats.isDirectory())
        assertSafeOpenExtension(local.path);
}
function dataRoot() {
    if (!app.isPackaged)
        return path.resolve(__dirname, '..', '..');
    const installDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
    const root = path.join(installDirectory, 'RanPartyData');
    const legacyRoot = path.join(app.getPath('userData'), 'data');
    const seed = path.join(process.resourcesPath, 'seed-data');
    if (!existsSync(root)) {
        mkdirSync(root, { recursive: true });
        cpSync(existsSync(legacyRoot) ? legacyRoot : seed, root, { recursive: true });
    }
    // Product-owned catalog files are safe to seed into existing installs without touching user sessions or configuration.
    for (const relative of [path.join('RanParty', 'SkillMarket'), path.join('RanParty', 'skills'), 'plugins']) {
        const source = path.join(seed, relative);
        const destination = path.join(root, relative);
        if (existsSync(source))
            cpSync(source, destination, { recursive: true, force: true, errorOnExist: false });
    }
    return root;
}
function backendPath() {
    if (app.isPackaged)
        return path.join(process.resourcesPath, 'backend', 'RanParty.Backend.exe');
    const configured = process.env.RANPARTY_BACKEND?.trim();
    if (configured) {
        if (!path.isAbsolute(configured))
            throw new Error('RANPARTY_BACKEND 必须是绝对路径');
        return configured;
    }
    const debugBuild = path.resolve(__dirname, '..', '..', 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.exe');
    if (existsSync(debugBuild))
        return debugBuild;
    return path.resolve(__dirname, '..', '..', 'backend-publish-v4', 'RanParty.Backend.exe');
}
function startBackend() {
    const executable = backendPath();
    if (!existsSync(executable))
        throw new Error(`找不到 C# 后端：${executable}`);
    const builtinSkillsRoot = app.isPackaged
        ? path.join(process.resourcesPath, 'seed-data', 'RanParty', 'skills')
        : path.resolve(__dirname, '..', '..', 'RanParty', 'skills');
    backend = spawn(executable, [], {
        cwd: dataRoot(),
        windowsHide: true,
        env: { ...process.env, RANPARTY_BUILTIN_SKILLS_ROOT: builtinSkillsRoot },
    });
    backend.on('error', (error) => window?.webContents.send('backend:event', { event: 'backend.error', data: { message: error.message } }));
    backend.on('exit', (code) => {
        rejectAllPending(`后端已退出 (${code ?? 'unknown'})`);
        backendLines?.close();
        backendLines = null;
        backend = null;
        window?.webContents.send('backend:event', { event: 'backend.exited', data: { code } });
        scheduleBackendRestart();
    });
    backend.stderr.on('data', (chunk) => console.error(`[backend] ${chunk.toString()}`));
    backend.stdin.on('error', (error) => {
        console.error('[backend stdin error]', error);
        rejectAllPending(`后端 stdin 错误: ${error.message}`);
    });
    backendLines = readline.createInterface({ input: backend.stdout });
    backendLines.on('line', (line) => {
        try {
            const message = JSON.parse(line);
            if (message.type === 'response' && message.id) {
                const item = pending.get(message.id);
                if (!item)
                    return;
                pending.delete(message.id);
                if (message.error)
                    item.reject(new Error(message.error));
                else
                    item.resolve(message.result);
            }
            else if (message.type === 'event' && message.event) {
                if (message.event === 'backend.ready')
                    backendRestartAttempts = 0;
                window?.webContents.send('backend:event', { event: message.event, data: message.data });
            }
        }
        catch (error) {
            console.error('Invalid backend message', line, error);
        }
    });
}
function scheduleBackendRestart() {
    if (shuttingDown || backendRestartTimer)
        return;
    const delayMs = Math.min(1000 * 2 ** Math.min(backendRestartAttempts++, 4), 15000);
    window?.webContents.send('backend:event', { event: 'backend.error', data: { message: `后端连接中断，${Math.ceil(delayMs / 1000)} 秒后自动重启…` } });
    backendRestartTimer = setTimeout(() => {
        backendRestartTimer = null;
        if (shuttingDown)
            return;
        try {
            startBackend();
        }
        catch (error) {
            window?.webContents.send('backend:event', { event: 'backend.error', data: { message: error instanceof Error ? error.message : String(error) } });
            scheduleBackendRestart();
        }
    }, delayMs);
}
function requestBackend(method, params = {}) {
    if (!backend?.stdin.writable)
        return Promise.reject(new Error('后端尚未启动'));
    const id = `req_${Date.now()}_${++requestCounter}`;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
            backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        }
        catch (error) {
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
async function createWindow() {
    window = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1040,
        minHeight: 680,
        backgroundColor: '#f9fafb',
        title: 'RanParty',
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#f5f5f4', symbolColor: '#202522', height: 32 },
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: true,
        },
    });
    window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
        let destination = '';
        try {
            destination = safeWebviewUrl(params.src || '');
        }
        catch {
            event.preventDefault();
            return;
        }
        params.src = destination;
        params.partition = BROWSER_PARTITION;
        delete params.preload;
        delete params.allowpopups;
        delete webPreferences.preload;
        delete webPreferences.session;
        delete webPreferences.additionalArguments;
        webPreferences.partition = BROWSER_PARTITION;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.nodeIntegrationInWorker = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
        webPreferences.allowRunningInsecureContent = false;
        webPreferences.webviewTag = false;
        webPreferences.plugins = false;
        webPreferences.experimentalFeatures = false;
        webPreferences.navigateOnDragDrop = false;
        webPreferences.disableDialogs = true;
        webPreferences.autoplayPolicy = 'document-user-activation-required';
        webPreferences.devTools = !app.isPackaged;
    });
    window.webContents.on('did-attach-webview', (_event, contents) => {
        contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        const keepGuestOnHttps = (event, destination) => {
            try {
                safeWebviewUrl(destination);
            }
            catch {
                event.preventDefault();
            }
        };
        contents.on('will-navigate', keepGuestOnHttps);
        contents.on('will-redirect', keepGuestOnHttps);
        contents.setWindowOpenHandler(({ url }) => {
            try {
                void shell.openExternal(safeWebviewUrl(url));
            }
            catch { /* Ignore unsafe guest window targets. */ }
            return { action: 'deny' };
        });
    });
    const keepMainWindowOnApp = (event, destination) => {
        if (isTrustedRendererUrl(destination))
            return;
        event.preventDefault();
        try {
            void shell.openExternal(safeUrl(destination));
        }
        catch { /* Non-http(s) navigation remains blocked. */ }
    };
    window.webContents.on('will-navigate', keepMainWindowOnApp);
    window.webContents.on('will-redirect', keepMainWindowOnApp);
    window.webContents.setWindowOpenHandler(({ url }) => {
        try {
            void shell.openExternal(safeUrl(url));
        }
        catch { /* Non-http(s) popup targets remain blocked. */ }
        return { action: 'deny' };
    });
    window.setMenuBarVisibility(false);
    window.once('ready-to-show', () => window?.show());
    if (!app.isPackaged)
        await window.loadURL('http://127.0.0.1:5173');
    else
        await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
app.whenReady().then(async () => {
    const rendererSession = session.defaultSession;
    denyAllWebPermissions(rendererSession);
    if (!app.isPackaged) {
        rendererSession.webRequest.onHeadersReceived({ urls: ['http://127.0.0.1:5173/*'] }, (details, callback) => {
            if (details.resourceType !== 'mainFrame') {
                callback({});
                return;
            }
            const responseHeaders = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== 'content-security-policy'));
            callback({ responseHeaders: { ...responseHeaders, 'Content-Security-Policy': [RENDERER_CSP] } });
        });
    }
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    denyAllWebPermissions(browserSession);
    browserSession.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (_details, callback) => callback({ cancel: true }));
    ipcMain.handle('backend:request', (event, method, params) => {
        assertTrustedIpc(event);
        if (typeof method !== 'string' || !BACKEND_METHOD_ALLOWLIST.has(method))
            throw new Error(`不允许调用后端方法：${String(method)}`);
        if (params !== undefined && !plainRecord(params))
            throw new Error('后端请求参数必须是对象');
        if (method === 'path.open')
            assertSafeBackendOpen(params ?? {});
        return requestBackend(method, params ?? {});
    });
    ipcMain.handle('dialog:directory', async (event) => {
        assertTrustedIpc(event);
        const result = await dialog.showOpenDialog(ownerWindow(), { properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('dialog:images', async (event) => {
        assertTrustedIpc(event);
        const result = await dialog.showOpenDialog(ownerWindow(), {
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
        });
        if (result.canceled)
            return [];
        const images = [];
        for (const filePath of result.filePaths.slice(0, 8)) {
            try {
                const stats = statSync(filePath);
                if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_IMAGE_BYTES)
                    continue;
                const buffer = readFileSync(filePath);
                const extension = path.extname(filePath).slice(1).toLowerCase().replace('jpg', 'jpeg');
                images.push({ name: path.basename(filePath), size: buffer.length, dataUrl: `data:image/${extension};base64,${buffer.toString('base64')}` });
            }
            catch (error) {
                console.error(`无法读取图片 ${filePath}:`, error);
            }
        }
        return images;
    });
    ipcMain.handle('dialog:file', async (event) => {
        assertTrustedIpc(event);
        const result = await dialog.showOpenDialog(ownerWindow(), { properties: ['openFile'] });
        return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('clipboard:write', async (event, text) => {
        assertTrustedIpc(event);
        const value = String(text ?? '');
        if (value.length > MAX_CLIPBOARD_TEXT_LENGTH)
            throw new Error('复制内容过长');
        clipboard.writeText(value);
        return { ok: true };
    });
    ipcMain.handle('path:action', async (event, action, target) => {
        assertTrustedIpc(event);
        if (typeof action !== 'string' || !PATH_ACTIONS.has(action))
            throw new Error(`未知文件操作：${String(action)}`);
        // Local filesystem actions must go through backend path.open so its workspace/root policy applies.
        // This bridge is intentionally URL-only.
        const url = safeUrl(target);
        await shell.openExternal(url);
        return { ok: true };
    });
    startBackend();
    await createWindow();
});
app.on('window-all-closed', () => {
    shuttingDown = true;
    if (backendRestartTimer)
        clearTimeout(backendRestartTimer);
    backend?.kill();
    if (process.platform !== 'darwin')
        app.quit();
});
app.on('before-quit', () => {
    shuttingDown = true;
    if (backendRestartTimer)
        clearTimeout(backendRestartTimer);
});
