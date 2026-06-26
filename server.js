// Disken Server — HTTP 服务器（开发模式用，Electron 用 main.js）
// 核心逻辑统一在 server-core.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const core = require('./server-core');
const { getIndex, getAllStatus } = require('./file-index');

const PORT = 3000;
const ROOT = __dirname;
const RENDERER = path.join(ROOT, 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch(e) { res.writeHead(404); res.end('Not Found'); }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── API Routes ──
  if (pathname === '/api/disks') return sendJSON(res, { disks: core.getDisks() });
  if (pathname === '/api/disk-health') return sendJSON(res, { disks: core.getDiskHealth() });
  if (pathname === '/api/system-info') return sendJSON(res, core.getSystemInfo());

  if (pathname === '/api/list-dir') {
    const dirPath = core.resolvePath(url.searchParams.get('path') || '/');
    if (!core.isValidDir(dirPath)) return sendJSON(res, { error: '目录不存在', items: [] }, 400);
    return sendJSON(res, { items: core.listDirectory(dirPath), currentPath: dirPath });
  }

  if (pathname === '/api/scan') {
    const scanPath = core.resolvePath(url.searchParams.get('path') || '/');
    if (!core.isValidDir(scanPath)) return sendJSON(res, { error: '目录不存在', tree: null }, 400);
    return sendJSON(res, { tree: core.scanDirectory(scanPath) });
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
    const drive = core.resolvePath(url.searchParams.get('drive') || '/');
    if (!core.isValidDir(drive)) return sendJSON(res, { error: '目录不存在' }, 400);
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
    if (drive) getIndex(drive).cancelBuild();
    return sendJSON(res, { success: true });
  }
  if (pathname === '/api/index/clear') {
    const drive = url.searchParams.get('drive') || '';
    if (drive) getIndex(drive).clearCache(drive);
    return sendJSON(res, { success: true });
  }

  if (pathname === '/api/search') {
    const query = url.searchParams.get('q') || '';
    const searchPath = core.resolvePath(url.searchParams.get('path') || '/');
    const useIndex = url.searchParams.get('index') !== '0';
    const maxResults = parseInt(url.searchParams.get('max')) || 200;
    const typeFilter = url.searchParams.get('type') || '';
    const minSize = parseInt(url.searchParams.get('minSize')) || 0;
    const maxSize = parseInt(url.searchParams.get('maxSize')) || 0;
    if (!core.isValidDir(searchPath)) return sendJSON(res, { error: '目录不存在', results: [] }, 400);
    if (!query.trim()) return sendJSON(res, { results: [], fromIndex: false });

    // 优先使用索引搜索
    if (useIndex) {
      const driveLetter = searchPath.match(/^([A-Z]:)/i)?.[1] || searchPath;
      const idx = getIndex(driveLetter);
      if (idx && idx.files.length > 0) {
        const startTime = Date.now();
        const results = idx.search(query, {
          maxResults, typeFilter, minSize,
          maxSize: maxSize > 0 ? maxSize : Infinity,
          searchPath
        });
        return sendJSON(res, {
          results, total: results.length,
          fromIndex: true, elapsedMs: Date.now() - startTime,
          indexStatus: idx.getStatus()
        });
      }
    }

    // 回退到实时搜索
    const results = core.searchFiles(searchPath, query, {
      maxResults, typeFilter, minSize,
      maxSize: maxSize > 0 ? maxSize : Infinity
    });
    return sendJSON(res, { results, total: results.length, fromIndex: false });
  }

  if (pathname === '/api/file-types') {
    const scanPath = core.resolvePath(url.searchParams.get('path') || '/');
    if (!core.isValidDir(scanPath)) return sendJSON(res, { error: '目录不存在', categories: [] }, 400);
    return sendJSON(res, core.analyzeFileTypes(scanPath));
  }

  if (pathname === '/api/junk-scan-stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.flushHeaders();
    core.analyzeJunkStream((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    res.end();
    req.on('close', () => {});
    return;
  }

  if (pathname === '/api/junk-scan') {
    return sendJSON(res, core.analyzeJunk());
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
        const result = core.deleteJunkFiles(paths);
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
        const resolved = core.resolvePath(targetPath);
        if (!resolved) return sendJSON(res, { error: '无效路径' }, 400);
        if (!fs.existsSync(resolved)) return sendJSON(res, { error: '文件不存在' }, 404);
        if (fs.statSync(resolved).isDirectory()) fs.rmSync(resolved, { recursive: true });
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
        const fromPath = core.resolvePath(from);
        const toPath = core.resolvePath(to);
        if (!fromPath || !toPath) return sendJSON(res, { error: '无效路径' }, 400);
        if (!fs.existsSync(fromPath)) return sendJSON(res, { error: '源文件不存在' }, 404);
        fs.renameSync(fromPath, toPath);
        return sendJSON(res, { success: true, message: '已移动' });
      } catch(e) { return sendJSON(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── Static files ──
  let filePath;
  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { 'Location': '/pages/index.html' });
    return res.end();
  } else if (pathname.startsWith('/pages/')) {
    filePath = path.join(RENDERER, 'pages', pathname.slice(7));
  } else if (pathname.startsWith('/renderer/')) {
    filePath = path.join(ROOT, pathname);
  } else if (pathname.startsWith('/assets/') || pathname.startsWith('/_shared/')) {
    filePath = path.join(ROOT, pathname);
  } else {
    filePath = path.join(RENDERER, pathname);
  }

  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  serveFile(res, resolved);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║         Disken v1.0.0 Demo           ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  http://127.0.0.1:${PORT}              ║`);
  console.log('╚══════════════════════════════════════╝');
});
