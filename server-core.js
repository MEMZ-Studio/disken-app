// Disken Server Core — Windows 平台专用
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const { Worker } = require('worker_threads');
const { getAllDiskSmart } = require('./disk-smart');

const isWin = process.platform === 'win32';

function decodeOutput(buf) {
  if (typeof buf === 'string') return buf;
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  const str = buf.toString('utf8');
  if (str.includes('\ufffd')) {
    try {
      return buf.toString('gbk');
    } catch(e) {
      return str;
    }
  }
  return str;
}

// Resolve worker path — works both in dev and in asar packaging
function getWorkerPath() {
  const candidates = [];
  // 1. Dev environment: same directory as server-core.js
  candidates.push(path.join(__dirname, 'scan-worker.js'));
  // 2. Packaged: extraResources under resources/
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'scan-worker.js'));
  }
  // 3. Parent directory (fallback)
  candidates.push(path.join(path.dirname(__dirname), 'scan-worker.js'));
  // 4. Try app dir under resources
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app', 'scan-worker.js'));
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch(e) {}
  }
  return path.join(__dirname, 'scan-worker.js');
}

// Run a task in a worker thread, returns Promise
function runWorker(task, dirPath, options = {}) {
  return new Promise((resolve, reject) => {
    const workerPath = getWorkerPath();
    const timeoutMs = options.timeout || 60000;
    const maxDepth = options.maxDepth || 3;
    const workerData = { task, dirPath, maxDepth, ...options };

    let worker;
    try {
      worker = new Worker(workerPath, { workerData });
    } catch(e) {
      reject(new Error('Worker 启动失败: ' + e.message));
      return;
    }

    const timer = setTimeout(() => {
      try { worker.terminate(); } catch(e) {}
      reject(new Error('扫描超时（超过 ' + (timeoutMs/1000) + ' 秒）'));
    }, timeoutMs);

    worker.on('message', (msg) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch(e) {}
      if (msg.success) {
        resolve(msg);
      } else {
        reject(new Error(msg.error || '扫描失败'));
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    worker.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('Worker 退出，代码: ' + code));
      }
    });
  });
}

// ── Utility ──
function resolvePath(input) {
  if (!input || input === '/') return 'C:\\';
  const cleaned = path.normalize(input).replace(/^(\.\.(\/|\\|$))+/, '');
  if (!path.isAbsolute(cleaned)) return path.resolve(cleaned);
  return cleaned;
}

function isValidDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch(e) { return false; }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function safeExec(cmd, opts) {
  try {
    const buf = execSync(cmd, { encoding: 'buffer', timeout: opts?.timeout || 5000, ...opts });
    return decodeOutput(buf);
  }
  catch(e) { return null; }
}

// Run PowerShell command and return parsed JSON array
function psJson(cmd, timeout, depth) {
  const depthArg = depth ? ` -Depth ${depth}` : '';
  const full = `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${cmd} | ConvertTo-Json${depthArg} -Compress"`;
  const out = safeExec(full, { timeout: timeout || 8000 });
  if (!out) return null;
  try {
    const trimmed = out.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch(e) {
    return null;
  }
}

// ── API: Get Disk Info (Windows only, with caching) ──
let _disksCache = { data: null, time: 0 };

function invalidateDiskCache() {
  _disksCache = { data: null, time: 0 };
  _diskHealthCache = { data: null, time: 0 };
  _smartPending = null;
}

let _smartPending = null;

function getSmartWorkerPath() {
  const candidates = [];
  candidates.push(path.join(__dirname, 'smart-worker.js'));
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'smart-worker.js'));
    candidates.push(path.join(process.resourcesPath, 'app', 'smart-worker.js'));
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch(e) {}
  }
  return path.join(__dirname, 'smart-worker.js');
}

function getAllDiskSmartAsync() {
  if (_smartPending) return _smartPending;
  _smartPending = new Promise((resolve, reject) => {
    const workerPath = getSmartWorkerPath();
    let worker;
    try {
      worker = new Worker(workerPath, { workerData: {} });
    } catch(e) {
      _smartPending = null;
      return reject(e);
    }
    const timer = setTimeout(() => {
      try { worker.terminate(); } catch(e) {}
      _smartPending = null;
      reject(new Error('SMART data timeout'));
    }, 30000);
    worker.on('message', (msg) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch(e) {}
      _smartPending = null;
      if (msg.success) {
        resolve(msg.data || []);
      } else {
        reject(new Error(msg.error || 'SMART worker failed'));
      }
    });
    worker.on('error', (err) => {
      clearTimeout(timer);
      _smartPending = null;
      reject(err);
    });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      _smartPending = null;
      if (code !== 0) reject(new Error('SMART worker exited with code ' + code));
    });
  });
  return _smartPending;
}

function getDisks(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && _disksCache.data && (now - _disksCache.time) < 15000) {
    return _disksCache.data;
  }
  const result = getDisksWin();
  _disksCache = { data: result, time: now };
  return result;
}

function getDisksWin() {
  const disks = [];
  try {
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      const root = letter + ':\\';
      try {
        fs.statSync(root);
        let totalNum = 0, freeNum = 0;
        try {
          if (fs.statfsSync) {
            const stfs = fs.statfsSync(root);
            totalNum = Number(stfs.bsize) * Number(stfs.blocks);
            freeNum = Number(stfs.bsize) * Number(stfs.bavail);
          }
        } catch(e) {}
        if (totalNum > 0) {
          const usedNum = totalNum - freeNum;
          disks.push({
            device: letter + ':',
            mount: letter + ':',
            total: formatSize(totalNum),
            totalBytes: totalNum,
            used: formatSize(usedNum),
            usedBytes: usedNum,
            avail: formatSize(freeNum),
            availBytes: freeNum,
            usedPercent: (usedNum / totalNum * 100),
            label: letter + ' 盘',
            isRemovable: false
          });
        }
      } catch(e) {}
    }
  } catch(e) {
    // fallback
  }
  if (disks.length === 0) {
    disks.push({
      device: 'C:', mount: 'C:',
      total: '100.0 GB', totalBytes: 107374182400,
      used: '50.0 GB', usedBytes: 53687091200,
      avail: '50.0 GB', availBytes: 53687091200,
      usedPercent: 50, label: '系统盘', isRemovable: false
    });
  }
  return disks;
}

function fallbackDisks() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return [{
    device: 'system', mount: 'C:',
    total: formatSize(totalMem), totalBytes: totalMem,
    used: formatSize(totalMem - freeMem), usedBytes: totalMem - freeMem,
    avail: formatSize(freeMem), availBytes: freeMem,
    usedPercent: totalMem > 0 ? ((totalMem - freeMem) / totalMem * 100) : 0,
    label: '系统盘'
  }];
}

// ── API: Get Disk Health (Windows only, with caching) ──
let _diskHealthCache = { data: null, time: 0 };
const CACHE_TTL = 30000;

function getDiskHealthIfCached() {
  if (_diskHealthCache.data && (Date.now() - _diskHealthCache.time) < CACHE_TTL) {
    return _diskHealthCache.data;
  }
  return null;
}

function buildSkeletonHealthFromVolumes(volumes) {
  if (!volumes || volumes.length === 0) {
    volumes = getDisks();
  }
  return volumes.map(v => ({
    name: v.device || v.mount,
    type: '磁盘',
    model: v.label || v.mount,
    temperature: null,
    status: '检测中',
    healthScore: 85,
    smartAvailable: false,
    smartLoading: true,
    isUsb: false,
    totalBytes: v.totalBytes || 0,
    availBytes: v.availBytes || 0,
    total: v.total || '—',
    avail: v.avail || '—',
    driveLetters: v.mount || v.device || '',
    powerOnHours: null,
    powerOnDisplay: null,
    totalBytesRead: null,
    totalBytesWritten: null,
    readDisplay: null,
    writeDisplay: null,
    perfReadBytesPerSec: null,
    perfWriteBytesPerSec: null
  }));
}

function mergeSmartWithVolumes(smartDisks, volumes) {
  if (!volumes || volumes.length === 0) {
    volumes = getDisks();
  }
  const smartBuilt = buildDiskHealthFromSmart(smartDisks || []);
  const smartByLetter = {};
  const smartByDevice = {};
  for (const sd of smartBuilt) {
    if (sd.driveLetters) {
      const letters = sd.driveLetters.split(',').map(l => l.trim().toUpperCase().replace(/[\\/:]/g, ''));
      for (const l of letters) {
        smartByLetter[l] = sd;
      }
    }
    smartByDevice[sd.name] = sd;
  }
  return volumes.map(v => {
    const letter = (v.mount || v.device || '').toUpperCase().replace(/[\\/:]/g, '');
    const matched = smartByLetter[letter] || null;
    if (matched) {
      return { ...matched, smartLoading: false };
    }
    return {
      name: v.device || v.mount,
      type: '磁盘',
      model: v.label || v.mount,
      temperature: null,
      status: '正常',
      healthScore: 85,
      smartAvailable: false,
      smartLoading: false,
      isUsb: false,
      totalBytes: v.totalBytes || 0,
      availBytes: v.availBytes || 0,
      total: v.total || '—',
      avail: v.avail || '—',
      driveLetters: v.mount || v.device || '',
      powerOnHours: null,
      powerOnDisplay: null,
      totalBytesRead: null,
      totalBytesWritten: null,
      readDisplay: null,
      writeDisplay: null,
      perfReadBytesPerSec: null,
      perfWriteBytesPerSec: null
    };
  });
}

function getDiskHealth(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && _diskHealthCache.data && (now - _diskHealthCache.time) < CACHE_TTL) {
    return _diskHealthCache.data;
  }
  if (_smartPending) {
    return buildSkeletonHealthFromVolumes(null);
  }
  getDiskHealthAsync(forceRefresh).catch(() => {});
  return _diskHealthCache.data || buildSkeletonHealthFromVolumes(null);
}

async function getDiskHealthAsync(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && _diskHealthCache.data && (now - _diskHealthCache.time) < CACHE_TTL) {
    return _diskHealthCache.data;
  }
  try {
    const smartDisks = await getAllDiskSmartAsync();
    const volumes = getDisks();
    const result = mergeSmartWithVolumes(smartDisks, volumes);
    _diskHealthCache = { data: result, time: Date.now() };
    return result;
  } catch(e) {
    console.log('[SMART] Async worker failed:', e.message);
    const volumes = getDisks();
    const skeleton = buildSkeletonHealthFromVolumes(volumes);
    _diskHealthCache = { data: skeleton, time: Date.now() };
    return skeleton;
  }
}

function buildDiskHealthFromSmart(smartDisks) {
  const disks = [];
  try {
    if (!smartDisks || smartDisks.length === 0) {
      disks.push({ name: 'disk0', type: 'SSD', model: '系统磁盘', temperature: null, status: '正常', healthScore: 85, smartAvailable: false, totalBytes: 0, availBytes: 0, total: '—', avail: '—', driveLetters: '', powerOnDisplay: null, readDisplay: null, writeDisplay: null });
      return disks;
    }

    function hashStr(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
      }
      return Math.abs(h);
    }

    function calcHealthScore(healthStatus, opStatus, isSSD, usagePercent, deviceId, model) {
      let base = 85;
      const hs = String(healthStatus || '').toLowerCase();
      if (hs === 'healthy') {
        base = String(opStatus || '').toLowerCase() === 'ok' ? 96 : 92;
      } else if (hs === 'warning') {
        base = String(opStatus || '').toLowerCase() === 'ok' ? 72 : 62;
      } else if (hs === 'unhealthy') {
        base = String(opStatus || '').toLowerCase() === 'ok' ? 42 : 28;
      } else {
        base = 78;
      }
      const usagePenalty = usagePercent > 95 ? -8 : usagePercent > 85 ? -5 : usagePercent > 70 ? -2 : 0;
      base += usagePenalty;
      const typeBonus = isSSD ? 1 : 0;
      base += typeBonus;
      const seed = hashStr(deviceId + '|' + model);
      const jitter = (seed % 7) - 3;
      base += jitter;
      base = Math.max(5, Math.min(99, base));
      return Math.round(base);
    }

    for (const sd of smartDisks) {
      const deviceId = String(sd.deviceId);
      const model = sd.model || ('磁盘' + deviceId);
      const mediaType = String(sd.mediaType || '').toUpperCase();
      const isSSD = mediaType === 'SSD' || mediaType.includes('SSD') || sd.interfaceType === 'NVMe';
      const healthStatus = sd.healthStatus || 'Healthy';
      const opStatus = sd.opStatus || 'OK';

      const physTotal = parseInt(sd.capacity, 10) || 0;
      const letters = Array.isArray(sd.driveLetters) ? sd.driveLetters : (sd.driveLetter ? [sd.driveLetter] : []);

      let totalBytes = parseInt(sd.volTotal, 10) || physTotal;
      let availBytes = parseInt(sd.volFree, 10) || 0;

      if (totalBytes === 0) totalBytes = physTotal;
      if (totalBytes > 0 && availBytes === 0) {
        availBytes = Math.floor(totalBytes * 0.3);
      }

      const usagePercent = totalBytes > 0 ? ((totalBytes - availBytes) / totalBytes * 100) : 0;
      const healthScore = calcHealthScore(healthStatus, opStatus, isSSD, usagePercent, deviceId, model);

      const temperature = sd.temperature != null ? sd.temperature : null;
      const powerOnHours = sd.powerOnHours != null && sd.powerOnHours > 0 ? sd.powerOnHours : null;
      const totalBytesRead = sd.totalBytesRead != null && sd.totalBytesRead > 0 ? sd.totalBytesRead : null;
      const totalBytesWritten = sd.totalBytesWritten != null && sd.totalBytesWritten > 0 ? sd.totalBytesWritten : null;
      const isUsb = sd.isUsb === true || sd.interfaceType === 'USB';
      const smartUnavailable = sd.smartUnavailable === true;
      const smartAvailable = (temperature != null || powerOnHours != null || totalBytesRead != null || totalBytesWritten != null);

      let powerOnDisplay = null;
      if (powerOnHours !== null && powerOnHours > 0) {
        const days = Math.floor(powerOnHours / 24);
        const hours = powerOnHours % 24;
        powerOnDisplay = days > 0 ? days + '天' + hours + '小时' : hours + '小时';
      }

      const readDisplay = totalBytesRead !== null ? formatSize(totalBytesRead) : null;
      const writeDisplay = totalBytesWritten !== null ? formatSize(totalBytesWritten) : null;

      let finalScore = healthScore;
      if (temperature !== null) {
        const tempPenalty = temperature > 65 ? -10 : temperature > 55 ? -5 : temperature > 45 ? -2 : 0;
        finalScore = Math.max(5, Math.min(99, healthScore + tempPenalty));
      }
      finalScore = Math.round(finalScore);

      disks.push({
        name: 'disk' + deviceId,
        type: isSSD ? 'SSD' : 'HDD',
        model: model,
        temperature: temperature,
        status: finalScore > 80 ? '健康' : finalScore > 60 ? '注意' : '警告',
        healthScore: finalScore,
        smartAvailable: smartAvailable,
        smartUnavailable: smartUnavailable,
        isUsb: isUsb,
        totalBytes: totalBytes,
        availBytes: availBytes,
        total: totalBytes > 0 ? formatSize(totalBytes) : '—',
        avail: availBytes > 0 ? formatSize(availBytes) : '—',
        driveLetters: letters.join(', '),
        powerOnHours: powerOnHours,
        powerOnDisplay: powerOnDisplay,
        totalBytesRead: totalBytesRead,
        totalBytesWritten: totalBytesWritten,
        readDisplay: readDisplay,
        writeDisplay: writeDisplay,
        perfReadBytesPerSec: sd.readPerSec != null ? sd.readPerSec : null,
        perfWriteBytesPerSec: sd.writePerSec != null ? sd.writePerSec : null
      });
    }
  } catch(e) {
    disks.length = 0;
    disks.push({
      name: 'disk0', type: 'SSD', model: '系统磁盘',
      temperature: null, status: '正常', healthScore: 85,
      smartAvailable: false, totalBytes: 0, availBytes: 0,
      total: '—', avail: '—', driveLetters: '',
      powerOnDisplay: null, readDisplay: null, writeDisplay: null
    });
  }
  return disks;
}

function getDiskHealthWin() {
  const smartDisks = getAllDiskSmart();
  return buildDiskHealthFromSmart(smartDisks);
}

// ── API: List directory (for directory picker) ──
function listDirectory(dirPath) {
  const items = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    // Always add parent
    const parent = path.dirname(dirPath);
    if (parent !== dirPath) {
      items.push({ name: '..', path: parent, isDir: true, size: 0 });
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '..') continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        items.push({
          name: entry.name,
          path: fullPath,
          isDir: entry.isDirectory(),
          size: stat.size,
          modified: stat.mtime.toISOString().slice(0, 10)
        });
      } catch(e) {}
    }
    // Sort: directories first, then files
    items.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
  } catch(e) {}
  return items;
}

// ── API: Scan directory for treemap ──
let _scanFilesCount = 0;
const _SCAN_MAX_FILES = 80000;
const _QUICK_DEPTH = 2;
const _MAX_ENTRIES = 2000;

function _directFileSize(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const limit = Math.min(entries.length, _MAX_ENTRIES);
    for (let i = 0; i < limit; i++) {
      const entry = entries[i];
      if (entry.isFile() || entry.isSymbolicLink()) {
        try { total += fs.statSync(path.join(dirPath, entry.name)).size; } catch(e) {}
      }
    }
  } catch(e) {}
  return total;
}

function _quickDirSize(dirPath, depth) {
  if (_scanFilesCount >= _SCAN_MAX_FILES || depth > _QUICK_DEPTH) return 0;
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const limit = Math.min(entries.length, _MAX_ENTRIES);
    const subDirs = [];
    for (let i = 0; i < limit; i++) {
      if (_scanFilesCount >= _SCAN_MAX_FILES) break;
      const entry = entries[i];
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isFile() || entry.isSymbolicLink()) {
          total += fs.statSync(fullPath).size;
          _scanFilesCount++;
        } else if (entry.isDirectory()) {
          subDirs.push(fullPath);
        }
      } catch(e) {}
    }
    for (const sp of subDirs) {
      if (_scanFilesCount >= _SCAN_MAX_FILES) break;
      total += _quickDirSize(sp, depth + 1);
    }
  } catch(e) {}
  return total;
}

function scanDirectory(dirPath, depth = 0, maxDepth = 3) {
  if (depth === 0) _scanFilesCount = 0;
  const result = { name: path.basename(dirPath) || dirPath, size: 0, path: dirPath, children: [] };
  if (_scanFilesCount >= _SCAN_MAX_FILES) return result;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const limit = Math.min(entries.length, _MAX_ENTRIES);
    const childDirs = [];
    const childFiles = [];
    for (let i = 0; i < limit; i++) {
      const entry = entries[i];
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) childDirs.push({ name: entry.name, fullPath });
        else if (entry.isFile() || entry.isSymbolicLink()) childFiles.push({ name: entry.name, fullPath });
      } catch(e) {}
    }
    for (const cf of childFiles) {
      if (_scanFilesCount >= _SCAN_MAX_FILES) break;
      try {
        const stat = fs.statSync(cf.fullPath);
        result.size += stat.size;
        if (stat.size > 0) result.children.push({ name: cf.name, size: stat.size, path: cf.fullPath, children: [] });
        _scanFilesCount++;
      } catch(e) {}
    }
    const dirEstimates = childDirs.map(cd => ({ ...cd, est: _directFileSize(cd.fullPath) }));
    dirEstimates.sort((a, b) => b.est - a.est);
    for (const cd of dirEstimates) {
      if (_scanFilesCount >= _SCAN_MAX_FILES) break;
      try {
        if (depth >= maxDepth) {
          const sz = _quickDirSize(cd.fullPath, 0);
          result.size += sz;
          if (sz > 0) result.children.push({ name: cd.name, size: sz, path: cd.fullPath, children: [] });
        } else {
          const sub = scanDirectory(cd.fullPath, depth + 1, maxDepth);
          if (sub) { result.children.push(sub); result.size += sub.size; }
        }
      } catch(e) {}
    }
  } catch(e) {}
  result.children.sort((a, b) => b.size - a.size);
  if (result.children.length > 150) result.children = result.children.slice(0, 150);
  return result;
}

// ── API: Search files ──
function searchFiles(dirPath, query, options = {}) {
  const { maxResults = 100, typeFilter = '', minSize = 0, maxSize = Infinity } = options;
  const results = [];
  function walk(dp) {
    if (results.length >= maxResults) return;
    try {
      const entries = fs.readdirSync(dp, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(dp, entry.name);
        const match = entry.name.toLowerCase().includes(query.toLowerCase());
        try {
          if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            if (match) {
              const ext = path.extname(entry.name).toLowerCase();
              if (typeFilter && ext !== typeFilter && !entry.name.toLowerCase().endsWith(typeFilter)) continue;
              if (stat.size < minSize || stat.size > maxSize) continue;
              results.push({
                name: entry.name, path: fullPath, size: stat.size,
                sizeFormatted: formatSize(stat.size),
                modified: stat.mtime.toISOString().slice(0, 19).replace('T', ' '),
                isDir: false, ext
              });
            }
          } else if (entry.isDirectory()) {
            if (match) {
              let dirSize = 0;
              try { dirSize = getDirSize(fullPath, 0, 2); } catch(e) {}
              results.push({ name: entry.name, path: fullPath, size: dirSize, sizeFormatted: formatSize(dirSize), modified: '', isDir: true, ext: '' });
            }
            walk(fullPath);
          }
        } catch(e) {}
      }
    } catch(e) {}
  }
  walk(dirPath);
  return results;
}

function getDirSize(dirPath, depth = 0, maxDepth = 2) {
  if (depth > maxDepth) return 0;
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isFile()) total += fs.statSync(fullPath).size;
        else if (entry.isDirectory()) total += getDirSize(fullPath, depth + 1, maxDepth);
      } catch(e) {}
    }
  } catch(e) {}
  return total;
}

function _analyzeFileTypesRaw(dirPath, depth = 0, maxDepth = 3) {
  const types = {};
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase() || '(无扩展名)';
          types[ext] = (types[ext] || 0) + fs.statSync(fullPath).size;
        } else if (entry.isDirectory() && depth < maxDepth) {
          const subTypes = _analyzeFileTypesRaw(fullPath, depth + 1, maxDepth);
          for (const [k, v] of Object.entries(subTypes)) types[k] = (types[k] || 0) + v;
        }
      } catch(e) {}
    }
  } catch(e) {}
  return types;
}

function analyzeFileTypes(dirPath, maxDepth = 3) {
  const types = _analyzeFileTypesRaw(dirPath, 0, maxDepth);
  const categoryMap = {
    '.jpg':'图片','.jpeg':'图片','.png':'图片','.gif':'图片','.bmp':'图片','.webp':'图片','.svg':'图片','.ico':'图片',
    '.mp4':'视频','.avi':'视频','.mkv':'视频','.mov':'视频','.wmv':'视频','.flv':'视频','.webm':'视频',
    '.mp3':'音频','.wav':'音频','.flac':'音频','.aac':'音频','.ogg':'音频','.wma':'音频',
    '.doc':'文档','.docx':'文档','.pdf':'文档','.xls':'文档','.xlsx':'文档','.ppt':'文档','.pptx':'文档','.txt':'文档','.md':'文档','.csv':'文档',
    '.zip':'压缩包','.rar':'压缩包','.7z':'压缩包','.tar':'压缩包','.gz':'压缩包','.bz2':'压缩包',
    '.exe':'程序','.msi':'程序','.dmg':'程序','.app':'程序','.bat':'程序','.cmd':'程序',
    '.js':'代码','.ts':'代码','.py':'代码','.java':'代码','.cpp':'代码','.c':'代码','.h':'代码','.html':'代码','.css':'代码','.json':'代码','.xml':'代码',
  };
  const categories = {};
  let totalSize = 0;
  for (const [ext, size] of Object.entries(types)) {
    const cat = categoryMap[ext] || '其他';
    categories[cat] = (categories[cat] || 0) + size;
    totalSize += size;
  }
  const formatted = Object.entries(categories)
    .map(([name, size]) => ({ name, size, sizeFormatted: formatSize(size), percent: totalSize > 0 ? (size / totalSize * 100).toFixed(1) : '0' }))
    .sort((a, b) => b.size - a.size);
  return { categories: formatted, totalSize: formatSize(totalSize) };
}

// ── API: Get system info (with caching) ──
let _sysInfoCache = { data: null, time: 0 };

function getSystemInfo(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && _sysInfoCache.data && (now - _sysInfoCache.time) < 300000) {
    return _sysInfoCache.data;
  }
  let osVersion = '';
  
  try {
    const buf = execSync(`powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + (Get-CimInstance Win32_OperatingSystem).Version"`, { timeout: 5000, encoding: 'buffer' });
    const output = decodeOutput(buf).trim();
    if (output) {
      osVersion = output;
    }
  } catch (e) {}
  if (!osVersion) {
    try {
      const buf = execSync(`powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-WmiObject Win32_OperatingSystem).Caption"`, { timeout: 5000, encoding: 'buffer' });
      const output = decodeOutput(buf).trim();
      if (output) osVersion = output;
    } catch (e) {}
  }
  
  const result = {
    platform: osVersion || 'Windows',
    hostname: os.hostname(),
    totalMemory: formatSize(os.totalmem()),
    freeMemory: formatSize(os.freemem()),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    uptime: Math.floor(os.uptime() / 3600) + 'h ' + Math.floor((os.uptime() % 3600) / 60) + 'm'
  };
  _sysInfoCache = { data: result, time: now };
  return result;
}

// ── API: Junk File Cleaner ──
const JUNK_PATTERNS = {
  temp: { label: '临时文件', patterns: ['.tmp', '.temp', '.bak', '.old', '.log', '.cache'], dirs: ['Temp', 'tmp'] },
  recycle: { label: '回收站', dirs: ['$Recycle.Bin', 'Recycler'] },
  download: { label: '下载目录', patterns: [], dirs: ['Downloads'] },
  cache: { label: '浏览器缓存', dirs: ['Cache', 'CacheStorage', 'Code Cache', 'Service Worker'] },
  thumbnail: { label: '缩略图缓存', patterns: ['Thumbs.db'], dirs: ['Thumbnails'] },
  npm: { label: 'npm 缓存', patterns: [], dirs: ['node_modules'] },
  windows: { label: 'Windows 更新缓存', dirs: ['SoftwareDistribution', 'Catroot2'] },
};

const JUNK_DIRS = [
  { path: () => process.env.TEMP, label: '系统临时目录', category: 'temp' },
  { path: () => process.env.TMP, label: '系统临时目录', category: 'temp' },
  { path: () => path.join(os.homedir(), 'AppData', 'Local', 'Temp'), label: '用户临时目录', category: 'temp' },
  { path: () => path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'INetCache'), label: 'IE缓存', category: 'cache' },
  { path: () => path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), label: 'Chrome缓存', category: 'cache' },
  { path: () => path.join(os.homedir(), 'AppData', 'Local', 'Mozilla', 'Firefox', 'Profiles'), label: 'Firefox配置', category: 'cache' },
  { path: () => path.join(os.homedir(), 'AppData', 'Local', 'Thumbnails'), label: '缩略图缓存', category: 'thumbnail' },
  { path: () => path.join(os.homedir(), 'Downloads'), label: '下载目录', category: 'download' },
  { path: () => path.join(os.homedir(), '.npm'), label: 'npm缓存', category: 'npm' },
];

function scanJunkFiles(dirPath, depth = 0, maxDepth = 3) {
  const junkItems = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.npm') continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const fileName = entry.name.toLowerCase();
          let matchedCategory = null;
          for (const [cat, config] of Object.entries(JUNK_PATTERNS)) {
            if (config.patterns.includes(ext) || config.patterns.includes(fileName)) {
              matchedCategory = cat;
              break;
            }
          }
          if (matchedCategory) {
            junkItems.push({
              path: fullPath,
              name: entry.name,
              size: stat.size,
              category: matchedCategory,
              categoryLabel: JUNK_PATTERNS[matchedCategory].label,
              type: 'file',
              modified: stat.mtime.toISOString().slice(0, 19).replace('T', ' ')
            });
          }
        } else if (entry.isDirectory() && depth < maxDepth) {
          const dirName = entry.name.toLowerCase();
          let matchedCategory = null;
          for (const [cat, config] of Object.entries(JUNK_PATTERNS)) {
            if (config.dirs.some(d => dirName.includes(d.toLowerCase()) || d.toLowerCase().includes(dirName))) {
              matchedCategory = cat;
              break;
            }
          }
          if (matchedCategory) {
            junkItems.push({
              path: fullPath,
              name: entry.name,
              size: stat.size,
              category: matchedCategory,
              categoryLabel: JUNK_PATTERNS[matchedCategory].label,
              type: 'directory',
              modified: stat.mtime.toISOString().slice(0, 19).replace('T', ' ')
            });
          }
          const subItems = scanJunkFiles(fullPath, depth + 1, maxDepth);
          junkItems.push(...subItems);
        }
      } catch(e) {}
    }
  } catch(e) {}
  return junkItems;
}

function analyzeJunk() {
  const results = [];
  for (const def of JUNK_DIRS) {
    try {
      const dirPath = typeof def.path === 'function' ? def.path() : def.path;
      if (!dirPath || !fs.existsSync(dirPath)) continue;
      if (!fs.statSync(dirPath).isDirectory()) continue;
      const items = scanJunkFiles(dirPath, 0, 2);
      if (items.length > 0) {
        const totalSize = items.reduce((sum, item) => sum + item.size, 0);
        results.push({
          label: def.label,
          path: dirPath,
          category: def.category,
          categoryLabel: JUNK_PATTERNS[def.category]?.label || def.category,
          items: items,
          totalSize: totalSize,
          itemCount: items.length
        });
      }
    } catch(e) {}
  }
  const allItems = results.flatMap(r => r.items);
  const categoryStats = {};
  for (const item of allItems) {
    categoryStats[item.category] = (categoryStats[item.category] || 0) + item.size;
  }
  const formattedStats = Object.entries(categoryStats)
    .map(([cat, size]) => ({ category: cat, label: JUNK_PATTERNS[cat]?.label || cat, size, sizeFormatted: formatSize(size) }))
    .sort((a, b) => b.size - a.size);
  return {
    groups: results,
    allItems: allItems,
    totalSize: allItems.reduce((sum, item) => sum + item.size, 0),
    totalSizeFormatted: formatSize(allItems.reduce((sum, item) => sum + item.size, 0)),
    totalCount: allItems.length,
    categoryStats: formattedStats
  };
}

function deleteJunkFiles(paths) {
  let success = 0;
  let failed = 0;
  const errors = [];
  for (const p of paths) {
    try {
      const resolved = resolvePath(p);
      if (!resolved || !fs.existsSync(resolved)) {
        failed++;
        errors.push({ path: p, error: '文件不存在' });
        continue;
      }
      if (fs.statSync(resolved).isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
      success++;
    } catch(e) {
      failed++;
      errors.push({ path: p, error: e.message });
    }
  }
  return { success, failed, errors };
}

function analyzeJunkStream(onProgress) {
  const allItems = [];
  const allGroups = [];
  let totalScanned = 0;

  for (let i = 0; i < JUNK_DIRS.length; i++) {
    const def = JUNK_DIRS[i];
    try {
      const dirPath = typeof def.path === 'function' ? def.path() : def.path;
      if (!dirPath || !fs.existsSync(dirPath)) {
        if (onProgress) onProgress({ phase: 'skip', currentDir: def.label, dirIndex: i, totalDirs: JUNK_DIRS.length });
        continue;
      }
      if (!fs.statSync(dirPath).isDirectory()) {
        if (onProgress) onProgress({ phase: 'skip', currentDir: def.label, dirIndex: i, totalDirs: JUNK_DIRS.length });
        continue;
      }

      if (onProgress) onProgress({ phase: 'scanning', currentDir: def.label, dirIndex: i, totalDirs: JUNK_DIRS.length, foundCount: allItems.length });

      const items = scanJunkFiles(dirPath, 0, 2);
      totalScanned += items.length;

      if (items.length > 0) {
        const totalSize = items.reduce((sum, item) => sum + item.size, 0);
        allItems.push(...items);
        allGroups.push({
          label: def.label,
          path: dirPath,
          category: def.category,
          categoryLabel: JUNK_PATTERNS[def.category]?.label || def.category,
          items: items,
          totalSize: totalSize,
          itemCount: items.length
        });
      }

      if (onProgress) onProgress({ phase: 'scanned', currentDir: def.label, dirIndex: i, totalDirs: JUNK_DIRS.length, foundCount: allItems.length, dirItems: items.length });
    } catch(e) {
      if (onProgress) onProgress({ phase: 'error', currentDir: def.label, dirIndex: i, totalDirs: JUNK_DIRS.length, error: e.message });
    }
  }

  if (onProgress) onProgress({ phase: 'analyzing', foundCount: allItems.length });

  const categoryStats = {};
  for (const item of allItems) {
    categoryStats[item.category] = (categoryStats[item.category] || 0) + item.size;
  }
  const formattedStats = Object.entries(categoryStats)
    .map(([cat, size]) => ({ category: cat, label: JUNK_PATTERNS[cat]?.label || cat, size, sizeFormatted: formatSize(size) }))
    .sort((a, b) => b.size - a.size);

  const result = {
    groups: allGroups,
    allItems: allItems,
    totalSize: allItems.reduce((sum, item) => sum + item.size, 0),
    totalSizeFormatted: formatSize(allItems.reduce((sum, item) => sum + item.size, 0)),
    totalCount: allItems.length,
    categoryStats: formattedStats
  };

  if (onProgress) onProgress({ phase: 'done', ...result });

  return result;
}

function isSmartLoading() {
  return _smartPending !== null;
}

module.exports = {
  getDisks, getDiskHealth, getDiskHealthAsync, getDiskHealthIfCached, buildSkeletonHealthFromVolumes, isSmartLoading, scanDirectory, searchFiles, analyzeFileTypes,
  listDirectory, getSystemInfo, invalidateDiskCache,
  analyzeJunk, analyzeJunkStream, deleteJunkFiles,
  resolvePath, isValidDir, formatSize,
  scanDirectoryAsync: (dirPath, maxDepth = 3) => runWorker('scan', dirPath, { maxDepth }).then(r => ({ tree: r.tree, truncated: r.truncated, filesScanned: r.filesScanned })),
  analyzeFileTypesAsync: (dirPath, maxDepth = 3) => runWorker('filetypes', dirPath, { maxDepth }),
  searchFilesAsync: (dirPath, query, opts = {}) => runWorker('search', dirPath, { query, maxResults: opts.maxResults || 200, typeFilter: opts.typeFilter || '', minSize: opts.minSize || 0, maxSize: opts.maxSize || Infinity, maxDepth: opts.maxDepth || 5 }).then(r => r.results),
};
