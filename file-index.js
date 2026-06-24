// Disken File Index — 快速文件搜索索引（Everything 风格）
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';

// 索引缓存目录
function getCacheDir() {
  const base = process.env.DISKEN_CACHE || path.join(os.homedir(), '.disken');
  try { fs.mkdirSync(base, { recursive: true }); } catch(e) {}
  return base;
}

function getCachePath(drive) {
  const safeDrive = drive.replace(/[:\\/]/g, '_');
  return path.join(getCacheDir(), `index-${safeDrive}.json`);
}

// 格式大小
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// ── 索引数据结构 ──
// 为了节省内存，使用扁平数组 + TypedArray 优化
// 每条记录: [nameLower, name, dirIdx, size, mtime, isDir]
// 目录单独存储为字典

class FileIndex {
  constructor() {
    this.files = [];      // 文件记录数组
    this.dirs = [];       // 目录路径数组
    this.dirMap = {};     // dirPath -> index
    this.drive = '';
    this.fileCount = 0;
    this.dirCount = 0;
    this.totalSize = 0;
    this.builtAt = 0;
    this.isBuilding = false;
    this.buildProgress = 0;
    this._scanCancel = false;
  }

  // 获取目录索引（复用，节省内存）
  _getDirIdx(dirPath) {
    let idx = this.dirMap[dirPath];
    if (idx === undefined) {
      idx = this.dirs.length;
      this.dirs.push(dirPath);
      this.dirMap[dirPath] = idx;
      this.dirCount++;
    }
    return idx;
  }

  // ── 扫描构建索引 ──
  async build(rootPath, onProgress) {
    if (this.isBuilding) return;
    this.isBuilding = true;
    this._scanCancel = false;
    this.files = [];
    this.dirs = [];
    this.dirMap = {};
    this.fileCount = 0;
    this.dirCount = 0;
    this.totalSize = 0;
    this.drive = rootPath;
    this.buildProgress = 0;

    const start = Date.now();
    let count = 0;
    let lastReport = 0;

    // 用异步递归避免阻塞
    const self = this;
    async function walk(dir) {
      if (self._scanCancel) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch(e) { return; }

      for (const entry of entries) {
        if (self._scanCancel) return;
        // 跳过系统隐藏文件和常见的大目录
        if (entry.name.startsWith('$') || entry.name.startsWith('.') ||
            entry.name === 'System Volume Information' ||
            entry.name === 'RECYCLE.BIN' || entry.name === '$Recycle.Bin' ||
            entry.name === 'node_modules' || entry.name === 'ProgramData') continue;

        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            const dirIdx = self._getDirIdx(fullPath);
            self.files.push({
              nameLower: entry.name.toLowerCase(),
              name: entry.name,
              dirIdx,
              size: 0,
              mtime: 0,
              isDir: true
            });
            count++;
            // 每 10000 条让出一下事件循环
            if (count % 10000 === 0) {
              self.fileCount = self.files.length;
              const now = Date.now();
              if (now - lastReport > 200 && onProgress) {
                lastReport = now;
                onProgress({ count: self.fileCount, dirs: self.dirCount, size: self.totalSize });
              }
              await new Promise(r => setTimeout(r, 0));
            }
            await walk(fullPath);
          } else if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            const dirIdx = self._getDirIdx(dir);
            self.files.push({
              nameLower: entry.name.toLowerCase(),
              name: entry.name,
              dirIdx,
              size: stat.size,
              mtime: Math.floor(stat.mtimeMs),
              isDir: false
            });
            self.totalSize += stat.size;
            count++;
            if (count % 10000 === 0) {
              self.fileCount = self.files.length;
              const now = Date.now();
              if (now - lastReport > 200 && onProgress) {
                lastReport = now;
                onProgress({ count: self.fileCount, dirs: self.dirCount, size: self.totalSize });
              }
              await new Promise(r => setTimeout(r, 0));
            }
          }
        } catch(e) {}
      }
    }

    await walk(rootPath);

    this.fileCount = this.files.filter(f => !f.isDir).length;
    this.builtAt = Date.now();
    this.isBuilding = false;
    this.buildProgress = 100;

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (onProgress) onProgress({
      count: this.fileCount,
      dirs: this.dirCount,
      size: this.totalSize,
      done: true,
      elapsed
    });

    // 自动保存缓存
    this.saveCache(rootPath);
    return { fileCount: this.fileCount, dirCount: this.dirCount, totalSize: this.totalSize, elapsed };
  }

  cancelBuild() {
    this._scanCancel = true;
  }

  // ── 内存搜索（瞬间响应） ──
  search(query, options = {}) {
    const {
      maxResults = 200,
      typeFilter = '',
      minSize = 0,
      maxSize = Infinity,
      searchPath = ''
    } = options;

    if (!query || this.files.length === 0) return [];

    const q = query.toLowerCase();
    const results = [];
    const files = this.files;
    const dirs = this.dirs;
    const searchPathLower = searchPath ? searchPath.toLowerCase() : '';
    const typeFilterLower = typeFilter.toLowerCase();

    // 预计算类型映射
    const categoryMap = {
      image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif', '.raw', '.heic', '.psd'],
      video: ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp'],
      audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.ape', '.opus'],
      document: ['.doc', '.docx', '.pdf', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf', '.odt', '.epub'],
      archive: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.cab'],
      code: ['.js', '.ts', '.py', '.java', '.cpp', '.c', '.h', '.html', '.css', '.json', '.xml', '.php', '.rb', '.go', '.rs', '.vue', '.jsx', '.tsx', '.sh', '.bat', '.sql']
    };
    const typeExts = categoryMap[typeFilterLower] || [];

    for (let i = 0; i < files.length && results.length < maxResults; i++) {
      const f = files[i];

      // 文件名匹配
      if (!f.nameLower.includes(q)) continue;

      // 路径过滤
      if (searchPathLower) {
        const dirPath = dirs[f.dirIdx];
        if (!dirPath || !dirPath.toLowerCase().startsWith(searchPathLower)) continue;
      }

      // 类型过滤
      if (typeFilterLower && !f.isDir) {
        if (typeExts.length > 0) {
          const ext = path.extname(f.name).toLowerCase();
          if (!typeExts.includes(ext)) continue;
        } else {
          // 按扩展名关键字过滤
          const ext = path.extname(f.name).toLowerCase();
          if (ext !== typeFilterLower && !f.nameLower.endsWith(typeFilterLower)) continue;
        }
      }

      // 大小过滤（只对文件）
      if (!f.isDir) {
        if (minSize > 0 && f.size < minSize) continue;
        if (maxSize > 0 && maxSize !== Infinity && f.size > maxSize) continue;
      }

      const dirPath = dirs[f.dirIdx] || '';
      const fullPath = f.isDir ? dirPath : path.join(dirPath, f.name);
      results.push({
        name: f.name,
        path: fullPath,
        size: f.size,
        sizeFormatted: formatSize(f.size),
        modified: f.mtime ? new Date(f.mtime).toISOString().slice(0, 19).replace('T', ' ') : '',
        isDir: f.isDir,
        ext: path.extname(f.name).toLowerCase()
      });
    }

    return results;
  }

  // ── 缓存持久化 ──
  saveCache(rootPath) {
    try {
      const cachePath = getCachePath(rootPath);
      const data = {
        drive: this.drive,
        builtAt: this.builtAt,
        fileCount: this.fileCount,
        dirCount: this.dirCount,
        totalSize: this.totalSize,
        dirs: this.dirs,
        files: this.files.map(f => [f.nameLower, f.name, f.dirIdx, f.size, f.mtime, f.isDir ? 1 : 0])
      };
      fs.writeFileSync(cachePath, JSON.stringify(data), 'utf8');
      return true;
    } catch(e) {
      console.error('保存索引缓存失败:', e.message);
      return false;
    }
  }

  loadCache(rootPath) {
    try {
      const cachePath = getCachePath(rootPath);
      if (!fs.existsSync(cachePath)) return false;

      const raw = fs.readFileSync(cachePath, 'utf8');
      const data = JSON.parse(raw);

      this.drive = data.drive;
      this.builtAt = data.builtAt;
      this.fileCount = data.fileCount;
      this.dirCount = data.dirCount;
      this.totalSize = data.totalSize;
      this.dirs = data.dirs || [];
      this.files = (data.files || []).map(arr => ({
        nameLower: arr[0],
        name: arr[1],
        dirIdx: arr[2],
        size: arr[3],
        mtime: arr[4],
        isDir: arr[5] === 1
      }));

      // 重建 dirMap
      this.dirMap = {};
      for (let i = 0; i < this.dirs.length; i++) {
        this.dirMap[this.dirs[i]] = i;
      }

      return true;
    } catch(e) {
      console.error('加载索引缓存失败:', e.message);
      return false;
    }
  }

  hasCache(rootPath) {
    return fs.existsSync(getCachePath(rootPath));
  }

  getCacheAge(rootPath) {
    try {
      const cachePath = getCachePath(rootPath);
      if (!fs.existsSync(cachePath)) return -1;
      const stat = fs.statSync(cachePath);
      return Date.now() - stat.mtimeMs;
    } catch(e) { return -1; }
  }

  clearCache(rootPath) {
    try {
      const cachePath = getCachePath(rootPath);
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
        return true;
      }
      return false;
    } catch(e) { return false; }
  }

  // ── 状态 ──
  getStatus() {
    return {
      drive: this.drive,
      fileCount: this.fileCount,
      dirCount: this.dirCount,
      totalSize: this.totalSize,
      totalSizeFormatted: formatSize(this.totalSize),
      builtAt: this.builtAt,
      builtAtFormatted: this.builtAt ? new Date(this.builtAt).toLocaleString('zh-CN') : '',
      isBuilding: this.isBuilding,
      buildProgress: this.buildProgress,
      hasIndex: this.files.length > 0
    };
  }
}

// 全局单例（按盘符管理）
const indexes = {};

function getIndex(drive) {
  const key = drive || 'default';
  if (!indexes[key]) {
    indexes[key] = new FileIndex();
  }
  return indexes[key];
}

// 获取所有索引状态
function getAllStatus() {
  const result = {};
  for (const [k, v] of Object.entries(indexes)) {
    result[k] = v.getStatus();
  }
  return result;
}

module.exports = {
  FileIndex,
  getIndex,
  getAllStatus,
  getCachePath,
  getCacheDir
};
