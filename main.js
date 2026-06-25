const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

// ── Early write: confirm main.js is being executed ──
const _startLog = path.join(os.tmpdir(), 'disken_start.log');
try { fs.appendFileSync(_startLog, `[${new Date().toISOString()}] main.js loaded, argv=${JSON.stringify(process.argv)}, execPath=${process.execPath}\n`); } catch(e) {}

// ── Sandbox / GPU workarounds ──
function setupEnvironment() {
  try {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-software-rasterizer');
    app.commandLine.appendSwitch('no-sandbox');

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

function startServer() {
  const PORT = 0; // random available port
  const ROOT = __dirname;
  const RENDERER = path.join(ROOT, 'renderer');

  function serveFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    } catch(e) {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  function sendJSON(res, data, status = 200) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
  }

  // Import server logic
  const { getDisks, getDiskHealth, scanDirectory, searchFiles, analyzeFileTypes, listDirectory, getSystemInfo, resolvePath, isValidDir, formatSize, scanDirectoryAsync, analyzeFileTypesAsync, searchFilesAsync } = require('./server-core');
  const { getIndex, getAllStatus } = require('./file-index');

  // 自动加载已有缓存（启动时预加载 C 盘索引）
  (function preloadIndexCache() {
    try {
      const drives = getDisks();
      for (const d of drives) {
        const idx = getIndex(d.mount);
        if (idx.hasCache(d.mount)) {
          const loaded = idx.loadCache(d.mount);
          if (loaded) console.log(`[Index] 预加载 ${d.mount} 索引: ${idx.fileCount} 个文件`);
        }
      }
    } catch(e) { console.log('[Index] 预加载失败:', e.message); }
  })();

  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const pathname = url.pathname;

    if (pathname === '/api/disks') return sendJSON(res, { disks: getDisks() });
    if (pathname === '/api/disk-health') return sendJSON(res, { disks: getDiskHealth() });
    if (pathname === '/api/system-info') return sendJSON(res, getSystemInfo());
    if (pathname === '/api/list-dir') {
      const dirPath = resolvePath(url.searchParams.get('path') || '/');
      if (!isValidDir(dirPath)) return sendJSON(res, { error: '目录不存在', items: [] }, 400);
      return sendJSON(res, { items: listDirectory(dirPath) });
    }
    if (pathname === '/api/scan') {
      const scanPath = resolvePath(url.searchParams.get('path') || '/');
      const depth = parseInt(url.searchParams.get('depth') || '3', 10);
      const maxDepth = Math.min(Math.max(depth, 1), 6);
      if (!isValidDir(scanPath)) return sendJSON(res, { error: '目录不存在', tree: null }, 400);
      (async () => {
        try {
          const tree = await scanDirectoryAsync(scanPath, maxDepth);
          sendJSON(res, { tree });
        } catch(e) {
          console.log('[API] scan error:', e.message);
          try {
            sendJSON(res, { tree: scanDirectory(scanPath, 0, 1) });
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
        const idx = getIndex(drive);
        return sendJSON(res, { status: idx.getStatus() });
      }
      return sendJSON(res, { all: getAllStatus() });
    }
    if (pathname === '/api/index/build') {
      const drive = resolvePath(url.searchParams.get('drive') || '/');
      if (!isValidDir(drive)) return sendJSON(res, { error: '目录不存在' }, 400);
      const idx = getIndex(drive);
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
        const idx = getIndex(drive);
        idx.cancelBuild();
      }
      return sendJSON(res, { success: true });
    }
    if (pathname === '/api/index/clear') {
      const drive = url.searchParams.get('drive') || '';
      if (drive) {
        const idx = getIndex(drive);
        idx.clearCache(drive);
      }
      return sendJSON(res, { success: true });
    }
    if (pathname === '/api/search') {
      const query = url.searchParams.get('q') || '';
      const searchPath = resolvePath(url.searchParams.get('path') || '/');
      const useIndex = url.searchParams.get('index') !== '0'; // 默认使用索引
      const maxResults = parseInt(url.searchParams.get('max')) || 200;
      if (!isValidDir(searchPath)) return sendJSON(res, { error: '目录不存在', results: [] }, 400);
      if (!query.trim()) return sendJSON(res, { results: [], fromIndex: false });
      const typeFilter = url.searchParams.get('type') || '';
      const minSize = parseInt(url.searchParams.get('minSize')) || 0;
      const maxSize = parseInt(url.searchParams.get('maxSize')) || 0;

      // 优先使用索引搜索（瞬间响应）
      if (useIndex) {
        // 获取搜索路径所在的盘符
        const driveLetter = searchPath.match(/^([A-Z]:)/i)?.[1] || searchPath;
        const idx = getIndex(driveLetter);
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

      // 回退到实时搜索
      (async () => {
        try {
          const results = await searchFilesAsync(searchPath, query, { maxResults, typeFilter, minSize, maxSize: maxSize > 0 ? maxSize : Infinity });
          sendJSON(res, { results, total: results.length, fromIndex: false });
        } catch(e) {
          console.log('[API] search error:', e.message);
          try {
            const results = searchFiles(searchPath, query, { maxResults: 50 });
            sendJSON(res, { results, total: results.length, fromIndex: false });
          } catch(e2) {
            sendJSON(res, { error: e.message, results: [] }, 500);
          }
        }
      })();
      return;
    }
    if (pathname === '/api/file-types') {
      const scanPath = resolvePath(url.searchParams.get('path') || '/');
      if (!isValidDir(scanPath)) return sendJSON(res, { error: '目录不存在', categories: [] }, 400);
      (async () => {
        try {
          const result = await analyzeFileTypesAsync(scanPath, 3);
          sendJSON(res, result);
        } catch(e) {
          console.log('[API] file-types error:', e.message);
          try {
            sendJSON(res, analyzeFileTypes(scanPath, 0, 1));
          } catch(e2) {
            sendJSON(res, { error: e.message, categories: [] }, 500);
          }
        }
      })();
      return;
    }
    if (pathname === '/api/delete' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { filePath: targetPath } = JSON.parse(body);
          const resolved = resolvePath(targetPath);
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
          const fromPath = resolvePath(from);
          const toPath = resolvePath(to);
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
          const fromPath = resolvePath(from);
          const toPath = resolvePath(to);
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
          const resolved = resolvePath(filePath);
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
