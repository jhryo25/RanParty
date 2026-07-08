import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let window = null;
let backend = null;
let backendLines = null;
let requestCounter = 0;
const pending = new Map();
/** 拒绝所有挂起的请求 — 后端断开时复用 */
function rejectAllPending(message) {
    for (const item of pending.values())
        item.reject(new Error(message));
    pending.clear();
}
/** 可安全用系统默认程序打开的扩展名白名单 */
const SAFE_OPEN_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx',
    '.json', '.jsonl', '.csv', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.py', '.c', '.cpp', '.h', '.hpp', '.java', '.go', '.rs', '.rb', '.php', '.sh',
    '.log', '.sql', '.r', '.m', '.swift', '.kt',
]);
/** 对 URL 做 scheme 白名单校验，非 http/https 则拒绝 */
function safeUrl(target) {
    const trimmed = target.trim();
    const hasScheme = /^[a-z][a-z0-9+\-.]*:/i.test(trimmed);
    if (hasScheme) {
        if (!/^https?:\/\//i.test(trimmed))
            throw new Error('仅支持 http/https 链接');
        return trimmed;
    }
    return `https://${trimmed}`;
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
            cpSync(source, destination, { recursive: true, force: false, errorOnExist: false });
    }
    return root;
}
function backendPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'backend', 'RanParty.Backend.exe')
        : path.resolve(__dirname, '..', '..', 'backend-publish-v2', 'RanParty.Backend.exe');
}
function startBackend() {
    const executable = backendPath();
    if (!existsSync(executable))
        throw new Error(`找不到 C# 后端：${executable}`);
    backend = spawn(executable, [], { cwd: dataRoot(), windowsHide: true });
    backend.on('error', (error) => window?.webContents.send('backend:event', { event: 'backend.error', data: { message: error.message } }));
    backend.on('exit', (code) => {
        rejectAllPending(`后端已退出 (${code ?? 'unknown'})`);
        backendLines?.close();
        backendLines = null;
        window?.webContents.send('backend:event', { event: 'backend.exited', data: { code } });
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
                window?.webContents.send('backend:event', { event: message.event, data: message.data });
            }
        }
        catch (error) {
            console.error('Invalid backend message', line, error);
        }
    });
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
        const destination = params.src || '';
        if (!/^https?:\/\//i.test(destination)) {
            event.preventDefault();
            return;
        }
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
    });
    window.webContents.on('did-attach-webview', (_event, contents) => {
        contents.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//i.test(url))
                void shell.openExternal(url);
            return { action: 'deny' };
        });
    });
    window.setMenuBarVisibility(false);
    window.once('ready-to-show', () => window?.show());
    if (!app.isPackaged)
        await window.loadURL('http://127.0.0.1:5173');
    else
        await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
app.whenReady().then(async () => {
    ipcMain.handle('backend:request', (_event, method, params) => requestBackend(method, params));
    ipcMain.handle('dialog:directory', async () => {
        const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('dialog:images', async () => {
        const result = await dialog.showOpenDialog(window, {
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
        });
        if (result.canceled)
            return [];
        const images = [];
        for (const filePath of result.filePaths.slice(0, 8)) {
            try {
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
    ipcMain.handle('dialog:file', async () => {
        const result = await dialog.showOpenDialog(window, { properties: ['openFile'] });
        return result.canceled ? null : result.filePaths[0];
    });
    // Hook 执行器：渲染进程通过此 IPC 执行 shell 命令（带超时 + 环境隔离）
    ipcMain.handle('hook:exec', async (_event, command, timeoutMs, envVars) => {
        return new Promise((resolve, reject) => {
            const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
                windowsHide: true,
                env: { ...process.env, ...envVars },
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`Hook 执行超时 (${timeoutMs}ms): ${command}`));
            }, Math.max(1000, Math.min(timeoutMs, 30000)));
            child.on('exit', (code) => {
                clearTimeout(timer);
                if (code === 0)
                    resolve(stdout || '{}');
                else
                    reject(new Error(stderr || stdout || `Hook 退出码: ${code}`));
            });
            child.on('error', (error) => { clearTimeout(timer); reject(error); });
        });
    });
    ipcMain.handle('path:action', async (_event, action, target) => {
        const isUrl = /^https?:\/\//i.test(target);
        if (action === 'copy-path') {
            clipboard.writeText(target);
            return { ok: true };
        }
        if (action === 'open') {
            if (isUrl)
                await shell.openExternal(target);
            else {
                const ext = path.extname(target).toLowerCase();
                if (!SAFE_OPEN_EXTENSIONS.has(ext))
                    throw new Error(`出于安全考虑，不支持直接打开 ${ext} 类型文件，请使用系统文件管理器手动打开。`);
                const error = await shell.openPath(target);
                if (error)
                    throw new Error(error);
            }
            return { ok: true };
        }
        if (action === 'open-with') {
            if (isUrl)
                return { ok: await shell.openExternal(target) };
            spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
            return { ok: true };
        }
        if (action === 'copy-file') {
            if (isUrl)
                throw new Error('网络链接不能复制为文件');
            const command = Buffer.from('Set-Clipboard -LiteralPath $env:RANPARTY_COPY_PATH', 'utf16le').toString('base64');
            await new Promise((resolve, reject) => {
                const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], { windowsHide: true, env: { ...process.env, RANPARTY_COPY_PATH: target } });
                child.once('error', reject);
                child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`复制文件失败 (${code})`)));
            });
            return { ok: true };
        }
        if (action === 'open-browser') {
            const selected = await dialog.showOpenDialog(window, { title: '选择外部浏览器', properties: ['openFile'], filters: [{ name: '应用程序', extensions: ['exe'] }] });
            if (selected.canceled)
                return { ok: false, cancelled: true };
            const destination = isUrl ? safeUrl(target) : pathToFileURL(target).href;
            spawn(selected.filePaths[0], [destination], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
            return { ok: true };
        }
        throw new Error(`未知文件操作：${action}`);
    });
    startBackend();
    await createWindow();
});
app.on('window-all-closed', () => {
    backend?.kill();
    if (process.platform !== 'darwin')
        app.quit();
});
