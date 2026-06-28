const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

function isAdmin() {
  try {
    execFileSync('net', ['session'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch(e) {
    return false;
  }
}

function restartAsAdmin() {
  try {
    const { spawn } = require('child_process');
    const exePath = process.execPath;
    const tmpDir = os.tmpdir();
    const vbsPath = path.join(tmpDir, 'disken-elevate.vbs');
    
    const vbsContent = 'Set sh = CreateObject("Shell.Application")\r\nsh.ShellExecute "' + exePath.replace(/"/g, '""') + '", "", "", "runas", 1\r\n';
    const buf = Buffer.alloc(2 + vbsContent.length * 2);
    buf[0] = 0xFF; buf[1] = 0xFE;
    for (let i = 0; i < vbsContent.length; i++) {
      buf.writeUInt16LE(vbsContent.charCodeAt(i), 2 + i * 2);
    }
    fs.writeFileSync(vbsPath, buf);
    spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 800);
    return true;
  } catch(e) {
    console.log('[Elevate] Failed:', e.message);
    return false;
  }
}

// ── Early write: confirm main.js is being executed ──
const _startLog = path.join(os.tmpdir(), 'disken_start.log');
try { fs.appendFileSync(_startLog, `[${new Date().toISOString()}] main.js loaded, argv=${JSON.stringify(process.argv)}, execPath=${process.execPath}\n`); } catch(e) {}

// ── Sandbox / GPU workarounds ──
function setupEnvironment() {
  try {
    // 启用GPU硬件加速提高渲染性能
    // app.disableHardwareAcceleration();
    // app.commandLine.appendSwitch('disable-gpu');
    // app.commandLine.appendSwitch('disable-gpu-compositing');
    // app.commandLine.appendSwitch('disable-software-rasterizer');
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder');
    app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

    // Put user-data dir next to the binary, not under AppData\Roaming
    const baseDir = path.dirname(process.execPath);
    const userDataDir = path.join(baseDir, 'userdata');
    try { fs.mkdirSync(userDataDir, { recursive: true }); } catch(e) {}
    app.setPath('userData', userDataDir);
    app.setPath('cache', path.join(userDataDir, 'cache'));
    app.setPath('sessionData', path.join(userDataDir, 'session'));
  } catch(e) {
    console.log('[Setup] env error:', e.message);
  }
}
setupEnvironment();

// Keep server reference
let server = null;
let mainWindow = null;

// ── Simple static file server (embedded, no external deps) ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const fileCache = new Map();
const CACHE_MAX = 100;
const CACHE_TTL = 60000;

const apiCache = new Map();
const API_CACHE_TTL = {
  '/api/disks': 5000,
  '/api/disk-health': 10000,
  '/api/system-info': 60000,
  '/api/admin-status': 2000,
};

function getCachedApi(pathname) {
  const ttl = API_CACHE_TTL[pathname];
  if (!ttl) return null;
  const entry = apiCache.get(pathname);
  if (entry && Date.now() - entry.time < ttl) {
    return entry.data;
  }
  return null;
}

function setCachedApi(pathname, data) {
  const ttl = API_CACHE_TTL[pathname];
  if (!ttl) return;
  apiCache.set(pathname, { data, time: Date.now() });
}

function getCachedFile(filePath) {
  const entry = fileCache.get(filePath);
  if (entry && Date.now() - entry.time < CACHE_TTL) {
    return entry;
  }
  return null;
}

function setCachedFile(filePath, content) {
  if (fileCache.size >= CACHE_MAX) {
    const firstKey = fileCache.keys().next().value;
    fileCache.delete(firstKey);
  }
  fileCache.set(filePath, { content, time: Date.now() });
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    let content;
    const cached = getCachedFile(filePath);
    if (cached) {
      content = cached.content;
    } else {
      content = fs.readFileSync(filePath);
      if (ext === '.js' || ext === '.css' || ext === '.html') {
        setCachedFile(filePath, content);
      }
    }
    const headers = { 'Content-Type': mime };
    if (ext === '.js' || ext === '.css' || ext === '.html') {
      headers['Cache-Control'] = 'public, max-age=30';
    } else {
      headers['Cache-Control'] = 'public, max-age=300';
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch(e) {
    res.writeHead(404);
    res.end('Not Found');
  }
}

function startServer() {
  const PORT = 0;
  const ROOT = __dirname;
  const RENDERER = path.join(ROOT, 'renderer');

  function sendJSON(res, data, status = 200) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify(data));
  }

  // 启动时立即加载模块（require本身很快，不会阻塞窗口显示）
  const sc = require('./server-core');
  const fi = require('./file-index');

  // 后台预热缓存：窗口显示后异步加载数据，不阻塞启动
  function warmupCache() {
    try {
      // 预热磁盘列表（1ms，瞬间完成）
      sc.getDisks();
      // 预热索引（如果有缓存）
      const drives = sc.getDisks();
      for (const d of drives) {
        const idx = fi.getIndex(d.mount);
        if (idx.hasCache(d.mount)) {
          idx.loadCache(d.mount);
        }
      }
    } catch(e) { console.log('[Warmup] phase1 error:', e.message); }

    // 磁盘健康数据（较慢）在后台异步预热，不阻塞主进程
    setTimeout(() => {
      sc.getDiskHealthAsync().then(() => {
        console.log('[Warmup] Disk health preloaded successfully');
      }).catch(e => {
        console.log('[Warmup] health preload error:', e.message);
      });
    }, 500);
  }

  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const pathname = url.pathname;
    const forceRefresh = url.searchParams.get('refresh') === '1';

    // 强制刷新时清除所有缓存
    if (forceRefresh) {
      apiCache.clear();
      sc.invalidateDiskCache();
    } else {
      // Check API cache first (only when not forcing refresh)
      const cached = getCachedApi(pathname);
      if (cached) return sendJSON(res, cached);
    }

    if (pathname === '/api/disks') {
      const data = { disks: sc.getDisks(forceRefresh) };
      if (!forceRefresh) setCachedApi(pathname, data);
      return sendJSON(res, data);
    }
    if (pathname === '/api/disk-health') {
      (async () => {
        try {
          const disks = await sc.getDiskHealthAsync(forceRefresh);
          const data = { disks };
          if (!forceRefresh) setCachedApi(pathname, data);
          sendJSON(res, data);
        } catch(e) {
          console.log('[API] disk-health error:', e.message);
          sendJSON(res, { disks: sc.getDiskHealth(forceRefresh) });
        }
      })();
      return;
    }
    if (pathname === '/api/admin-status') {
      const data = { isAdmin: isAdmin() };
      if (!forceRefresh) setCachedApi(pathname, data);
      return sendJSON(res, data);
    }
    if (pathname === '/api/admin-elevate') {
      const success = restartAsAdmin();
      return sendJSON(res, { success });
    }
    if (pathname === '/api/system-info') {
      const data = sc.getSystemInfo(forceRefresh);
      if (!forceRefresh) setCachedApi(pathname, data);
      return sendJSON(res, data);
    }
    if (pathname === '/api/list-dir') {
      const dirPath = sc.resolvePath(url.searchParams.get('path') || '/');
      if (!sc.isValidDir(dirPath)) return sendJSON(res, { error: '目录不存在', items: [] }, 400);
      return sendJSON(res, { items: sc.listDirectory(dirPath) });
    }
    if (pathname === '/api/scan') {
      const scanPath = sc.resolvePath(url.searchParams.get('path') || '/');
      const depth = parseInt(url.searchParams.get('depth') || '4', 10);
      const maxDepth = Math.min(Math.max(depth, 1), 8);
      if (!sc.isValidDir(scanPath)) return sendJSON(res, { error: '目录不存在', tree: null }, 400);
      (async () => {
        try {
          const result = await sc.scanDirectoryAsync(scanPath, maxDepth);
          sendJSON(res, { tree: result.tree, truncated: result.truncated, filesScanned: result.filesScanned });
        } catch(e) {
          console.log('[API] scan error:', e.message);
          try {
            sendJSON(res, { tree: sc.scanDirectory(scanPath, 0, 1), truncated: true, filesScanned: 0, fallback: true });
          } catch(e2) {
            sendJSON(res, { error: e.message, tree: null }, 500);
          }
        }
      })();
      return;
    }
    // ── 索引相关 API ──
    if (pathname === '/api/index/status') {
      const drive = url.searchParams.get('drive') || '';
      if (drive) {
        const idx = fi.getIndex(drive);
        return sendJSON(res, { status: idx.getStatus() });
      }
      return sendJSON(res, { all: fi.getAllStatus() });
    }
    if (pathname === '/api/index/build') {
      const drive = sc.resolvePath(url.searchParams.get('drive') || '/');
      if (!sc.isValidDir(drive)) return sendJSON(res, { error: '目录不存在' }, 400);
      const idx = fi.getIndex(drive);
      if (idx.isBuilding) return sendJSON(res, { error: '正在构建中' }, 400);
      (async () => {
        try {
          const result = await idx.build(drive);
          sendJSON(res, { success: true, result });
        } catch(e) {
          sendJSON(res, { error: e.message }, 500);
        }
      })();
      return;
    }
    if (pathname === '/api/index/cancel') {
      const drive = url.searchParams.get('drive') || '';
      if (drive) {
        const idx = fi.getIndex(drive);
        idx.cancelBuild();
      }
      return sendJSON(res, { success: true });
    }
    if (pathname === '/api/index/clear') {
      const drive = url.searchParams.get('drive') || '';
      if (drive) {
        const idx = fi.getIndex(drive);
        idx.clearCache(drive);
      }
      return sendJSON(res, { success: true });
    }
    if (pathname === '/api/search') {
      const query = url.searchParams.get('q') || '';
      const searchPath = sc.resolvePath(url.searchParams.get('path') || '/');
      const useIndex = url.searchParams.get('index') !== '0';
      const maxResults = parseInt(url.searchParams.get('max')) || 200;
      if (!sc.isValidDir(searchPath)) return sendJSON(res, { error: '目录不存在', results: [] }, 400);
      if (!query.trim()) return sendJSON(res, { results: [], fromIndex: false });
      const typeFilter = url.searchParams.get('type') || '';
      const minSize = parseInt(url.searchParams.get('minSize')) || 0;
      const maxSize = parseInt(url.searchParams.get('maxSize')) || 0;

      if (useIndex) {
        const driveLetter = searchPath.match(/^([A-Z]:)/i)?.[1] || searchPath;
        const idx = fi.getIndex(driveLetter);
        if (idx && idx.files.length > 0) {
          const startTime = Date.now();
          const results = idx.search(query, {
            maxResults,
            typeFilter,
            minSize,
            maxSize: maxSize > 0 ? maxSize : Infinity,
            searchPath
          });
          const elapsed = Date.now() - startTime;
          return sendJSON(res, {
            results,
            total: results.length,
            fromIndex: true,
            elapsedMs: elapsed,
            indexStatus: idx.getStatus()
          });
        }
      }

      (async () => {
        try {
          const results = await sc.searchFilesAsync(searchPath, query, { maxResults, typeFilter, minSize, maxSize: maxSize > 0 ? maxSize : Infinity });
          sendJSON(res, { results, total: results.length, fromIndex: false });
        } catch(e) {
          console.log('[API] search error:', e.message);
          try {
            const results = sc.searchFiles(searchPath, query, { maxResults: 50 });
            sendJSON(res, { results, total: results.length, fromIndex: false });
          } catch(e2) {
            sendJSON(res, { error: e.message, results: [] }, 500);
          }
        }
      })();
      return;
    }
    if (pathname === '/api/file-types') {
      const scanPath = sc.resolvePath(url.searchParams.get('path') || '/');
      if (!sc.isValidDir(scanPath)) return sendJSON(res, { error: '目录不存在', categories: [] }, 400);
      (async () => {
        try {
          const result = await sc.analyzeFileTypesAsync(scanPath, 3);
          sendJSON(res, result);
        } catch(e) {
          console.log('[API] file-types error:', e.message);
          try {
            sendJSON(res, sc.analyzeFileTypes(scanPath, 0, 1));
          } catch(e2) {
            sendJSON(res, { error: e.message, categories: [] }, 500);
          }
        }
      })();
      return;
    }
    if (pathname === '/api/junk-scan-stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.flushHeaders();
      sc.analyzeJunkStream((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      res.end();
      return;
    }
    if (pathname === '/api/junk-scan') {
      return sendJSON(res, sc.analyzeJunk());
    }
    if (pathname === '/api/junk-delete' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { paths } = JSON.parse(body);
          if (!Array.isArray(paths) || paths.length === 0) {
            return sendJSON(res, { error: '无效路径列表' }, 400);
          }
          const result = sc.deleteJunkFiles(paths);
          return sendJSON(res, { success: true, ...result });
        } catch(e) {
          return sendJSON(res, { error: e.message }, 500);
        }
      });
      return;
    }
    if (pathname === '/api/delete' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { filePath: targetPath } = JSON.parse(body);
          const resolved = sc.resolvePath(targetPath);
          if (!resolved) return sendJSON(res, { error: '无效路径' }, 400);
          if (!fs.existsSync(resolved)) return sendJSON(res, { error: '文件不存在' }, 404);
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) fs.rmdirSync(resolved, { recursive: true });
          else fs.unlinkSync(resolved);
          return sendJSON(res, { success: true, message: '已删除' });
        } catch(e) { return sendJSON(res, { error: e.message }, 500); }
      });
      return;
    }
    if (pathname === '/api/move' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { from, to } = JSON.parse(body);
          const fromPath = sc.resolvePath(from);
          const toPath = sc.resolvePath(to);
          if (!fromPath || !toPath) return sendJSON(res, { error: '无效路径' }, 400);
          if (!fs.existsSync(fromPath)) return sendJSON(res, { error: '源文件不存在' }, 404);
          fs.renameSync(fromPath, toPath);
          return sendJSON(res, { success: true, message: '已移动' });
        } catch(e) { return sendJSON(res, { error: e.message }, 500); }
      });
      return;
    }
    if (pathname === '/api/copy' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { from, to } = JSON.parse(body);
          const fromPath = sc.resolvePath(from);
          const toPath = sc.resolvePath(to);
          if (!fromPath || !toPath) return sendJSON(res, { error: '无效路径' }, 400);
          if (!fs.existsSync(fromPath)) return sendJSON(res, { error: '源文件不存在' }, 404);
          const stat = fs.statSync(fromPath);
          if (stat.isDirectory()) {
            if (fs.existsSync(toPath)) return sendJSON(res, { error: '目标已存在' }, 400);
            fs.mkdirSync(toPath, { recursive: true });
            function copyDir(src, dst) {
              const entries = fs.readdirSync(src, { withFileTypes: true });
              for (const entry of entries) {
                const srcPath = path.join(src, entry.name);
                const dstPath = path.join(dst, entry.name);
                if (entry.isDirectory()) {
                  fs.mkdirSync(dstPath, { recursive: true });
                  copyDir(srcPath, dstPath);
                } else if (entry.isFile() || entry.isSymbolicLink()) {
                  fs.copyFileSync(srcPath, dstPath);
                }
              }
            }
            copyDir(fromPath, toPath);
          } else {
            if (fs.existsSync(toPath)) return sendJSON(res, { error: '目标已存在' }, 400);
            const parentDir = path.dirname(toPath);
            if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
            fs.copyFileSync(fromPath, toPath);
          }
          return sendJSON(res, { success: true, message: '已复制' });
        } catch(e) { return sendJSON(res, { error: e.message }, 500); }
      });
      return;
    }
    if (pathname === '/api/open-folder' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { filePath } = JSON.parse(body);
          const resolved = sc.resolvePath(filePath);
          if (!resolved) return sendJSON(res, { error: '无效路径' }, 400);
          if (!fs.existsSync(resolved)) return sendJSON(res, { error: '文件不存在' }, 404);
          const { exec } = require('child_process');
          const isWin = process.platform === 'win32';
          let cmd;
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) {
            cmd = isWin ? 'explorer "' + resolved + '"' : 'open "' + resolved + '"';
          } else {
            const dir = path.dirname(resolved);
            if (isWin) {
              cmd = 'explorer /select,"' + resolved + '"';
            } else {
              cmd = 'open -R "' + resolved + '"';
            }
          }
          exec(cmd, (err) => {
            if (err) return sendJSON(res, { error: err.message }, 500);
            sendJSON(res, { success: true });
          });
        } catch(e) { return sendJSON(res, { error: e.message }, 500); }
      });
      return;
    }

    // Static files
    let filePath;
    if (pathname === '/' || pathname === '') {
      res.writeHead(302, { 'Location': '/pages/index.html' });
      return res.end();
    } else if (pathname.startsWith('/pages/')) {
      filePath = path.join(RENDERER, 'pages', pathname.slice(7));
    } else if (pathname.startsWith('/_shared/')) {
      filePath = path.join(ROOT, pathname);
    } else if (pathname.startsWith('/assets/')) {
      filePath = path.join(ROOT, pathname);
    } else {
      filePath = path.join(RENDERER, pathname);
    }

    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    serveFile(res, resolved);
  });

  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`Disken server running on http://127.0.0.1:${port}`);
      // 启动后立即在后台预热缓存（不阻塞窗口显示）
      setImmediate(warmupCache);
      resolve(port);
    });
  });
}

// ── Electron Window ──
async function createWindow() {
  const port = await startServer();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Disken - 硬盘管理工具',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
    },
    show: false,
    backgroundColor: '#0f1117',
  });

  // Load local server
  mainWindow.loadURL(`http://127.0.0.1:${port}/pages/index.html`);

  mainWindow.once('ready-to-show', () => {
    writeLog('[Main] ready-to-show');
    mainWindow.show();
  });

  // Open DevTools only when --dev flag is passed
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Log all page console messages to terminal and to file
  const logFile = path.join(path.dirname(process.execPath), 'disken.log');
  const writeLog = (msg) => {
    try { fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch(e) {}
    console.log(msg);
  };
  writeLog(`[Main] createWindow started, execPath=${process.execPath}`);
  mainWindow.webContents.on('console-message', (event, level, message, line, source) => {
    writeLog(`[Renderer] ${message}`);
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    writeLog(`[Renderer] failed-load: ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    writeLog(`[Renderer] render-process-gone: ${JSON.stringify(details)}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    writeLog(`[Main] did-finish-load`);
  });
  mainWindow.webContents.on('dom-ready', () => {
    writeLog(`[Main] dom-ready`);
  });
}

// ── Chinese Menu ──
function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建窗口',
          accelerator: 'Ctrl+N',
          click: () => { createWindow(); }
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'Ctrl+Q',
          click: () => { app.quit(); }
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'Ctrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Ctrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'Ctrl+X', role: 'cut' },
        { label: '复制', accelerator: 'Ctrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'Ctrl+V', role: 'paste' },
        { label: '全选', accelerator: 'Ctrl+A', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'Ctrl+R', role: 'reload' },
        { label: '强制重新加载', accelerator: 'Ctrl+Shift+R', role: 'forceReload' },
        { type: 'separator' },
        { label: '放大', accelerator: 'Ctrl+=', role: 'zoomIn' },
        { label: '缩小', accelerator: 'Ctrl+-', role: 'zoomOut' },
        { label: '重置缩放', accelerator: 'Ctrl+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', accelerator: 'Ctrl+M', role: 'minimize' },
        { label: '关闭', accelerator: 'Ctrl+W', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('show-about');
            }
          }
        },
        {
          label: '反馈',
          click: () => {
            shell.openExternal('mailto:renxplain@qq.com?subject=Disken%20%E7%A1%AC%E7%9B%98%E7%B2%BE%E7%81%B5%20-%20%E5%8F%8D%E9%A6%88');
          }
        },
        { type: 'separator' },
        {
          label: 'GitHub 仓库',
          click: () => {
            shell.openExternal('https://github.com/MEMZ-Studio/disken-app');
          }
        },
        {
          label: '开发工具',
          accelerator: 'F12',
          role: 'toggleDevTools'
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ── App Events ──
app.whenReady().then(() => {
  createMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
