// Disken Server — HTTP 服务器（开发模式用，Electron 用 main.js）
// 核心逻辑统一在 server-core.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const core = require('./server-core');

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

  if (pathname === '/api/search') {
    const query = url.searchParams.get('q') || '';
    const searchPath = core.resolvePath(url.searchParams.get('path') || '/');
    const typeFilter = url.searchParams.get('type') || '';
    const minSize = parseInt(url.searchParams.get('minSize')) || 0;
    const maxSize = parseInt(url.searchParams.get('maxSize')) || 0;
    if (!core.isValidDir(searchPath)) return sendJSON(res, { error: '目录不存在', results: [] }, 400);
    if (!query.trim()) return sendJSON(res, { results: [], total: 0 });
    const results = core.searchFiles(searchPath, query, {
      typeFilter, minSize, maxSize: maxSize > 0 ? maxSize : Infinity
    });
    return sendJSON(res, { results, total: results.length });
  }

  if (pathname === '/api/file-types') {
    const scanPath = core.resolvePath(url.searchParams.get('path') || '/');
    if (!core.isValidDir(scanPath)) return sendJSON(res, { error: '目录不存在', categories: [] }, 400);
    return sendJSON(res, core.analyzeFileTypes(scanPath));
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
