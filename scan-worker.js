const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const { task, dirPath, maxDepth } = workerData;

let filesScanned = 0;
const MAX_FILES_TOTAL = 80000;
const QUICK_DEPTH = 2;
const MAX_ENTRIES_PER_DIR = 2000;

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function _directFileSize(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const limit = Math.min(entries.length, MAX_ENTRIES_PER_DIR);
    for (let i = 0; i < limit; i++) {
      const entry = entries[i];
      if (entry.isFile() || entry.isSymbolicLink()) {
        try { total += fs.statSync(path.join(dirPath, entry.name)).size; } catch(e) {}
      }
    }
  } catch(e) {}
  return total;
}

function quickDirSize(dirPath, depth) {
  if (filesScanned >= MAX_FILES_TOTAL || depth > QUICK_DEPTH) return 0;
  let totalSize = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const limit = Math.min(entries.length, MAX_ENTRIES_PER_DIR);
    const subDirs = [];
    for (let i = 0; i < limit; i++) {
      if (filesScanned >= MAX_FILES_TOTAL) break;
      const entry = entries[i];
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isFile() || entry.isSymbolicLink()) {
          const stat = fs.statSync(fullPath);
          totalSize += stat.size;
          filesScanned++;
        } else if (entry.isDirectory()) {
          subDirs.push(fullPath);
        }
      } catch(e) {}
    }
    for (const sp of subDirs) {
      if (filesScanned >= MAX_FILES_TOTAL) break;
      totalSize += quickDirSize(sp, depth + 1);
    }
  } catch(e) {}
  return totalSize;
}

function scanTree(dirPath, depth, maxDepth) {
  if (filesScanned >= MAX_FILES_TOTAL) {
    return { name: path.basename(dirPath) || dirPath, size: 0, path: dirPath, children: [] };
  }
  const result = { name: path.basename(dirPath) || dirPath, size: 0, path: dirPath, children: [] };
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const limit = Math.min(entries.length, MAX_ENTRIES_PER_DIR);
    const childDirs = [];
    const childFiles = [];

    for (let i = 0; i < limit; i++) {
      const entry = entries[i];
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          childDirs.push({ name: entry.name, fullPath });
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          childFiles.push({ name: entry.name, fullPath });
        }
      } catch(e) {}
    }

    for (const cf of childFiles) {
      if (filesScanned >= MAX_FILES_TOTAL) break;
      try {
        const stat = fs.statSync(cf.fullPath);
        result.size += stat.size;
        if (stat.size > 0) {
          result.children.push({ name: cf.name, size: stat.size, path: cf.fullPath, children: [] });
        }
        filesScanned++;
      } catch(e) {}
    }

    const dirEstimates = childDirs.map(cd => ({ ...cd, est: _directFileSize(cd.fullPath) }));
    dirEstimates.sort((a, b) => b.est - a.est);

    for (const cd of dirEstimates) {
      if (filesScanned >= MAX_FILES_TOTAL) break;
      try {
        if (depth >= maxDepth) {
          const dirSize = quickDirSize(cd.fullPath, 0);
          result.size += dirSize;
          if (dirSize > 0) {
            result.children.push({ name: cd.name, size: dirSize, path: cd.fullPath, children: [] });
          }
        } else {
          const sub = scanTree(cd.fullPath, depth + 1, maxDepth);
          if (sub) {
            result.children.push(sub);
            result.size += sub.size;
          }
        }
      } catch(e) {}
    }
  } catch(e) {}

  result.children.sort((a, b) => b.size - a.size);
  if (result.children.length > 150) {
    result.children = result.children.slice(0, 150);
  }
  return result;
}

function walkTypes(dp, types, depth) {
  if (filesScanned >= MAX_FILES_TOTAL || depth > 6) return;
  try {
    const entries = fs.readdirSync(dp, { withFileTypes: true });
    const limit = Math.min(entries.length, MAX_ENTRIES_PER_DIR);
    for (let i = 0; i < limit; i++) {
      if (filesScanned >= MAX_FILES_TOTAL) break;
      const entry = entries[i];
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dp, entry.name);
      try {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase() || '(无扩展名)';
          const sz = fs.statSync(fullPath).size;
          types[ext] = (types[ext] || 0) + sz;
          filesScanned++;
        } else if (entry.isDirectory()) {
          walkTypes(fullPath, types, depth + 1);
        }
      } catch(e) {}
    }
  } catch(e) {}
}

function analyzeTypes(dirPath) {
  const types = {};
  walkTypes(dirPath, types, 0);
  return types;
}

function walkSearch(dp, results, opts, depth) {
  const { query, maxResults, validExts, minSize, maxSize, qLower } = opts;
  if (results.length >= maxResults || depth > 10) return;
  try {
    const entries = fs.readdirSync(dp, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dp, entry.name);
      const match = !qLower || entry.name.toLowerCase().includes(qLower);
      try {
        if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          if (match) {
            const ext = path.extname(entry.name).toLowerCase();
            if (validExts && !validExts.includes(ext)) continue;
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
            const dirSize = quickDirSize(fullPath, 0);
            results.push({ name: entry.name, path: fullPath, size: dirSize, sizeFormatted: formatSize(dirSize), modified: '', isDir: true, ext: '' });
          }
          walkSearch(fullPath, results, opts, depth + 1);
        }
      } catch(e) {}
    }
  } catch(e) {}
}

try {
  if (task === 'scan') {
    filesScanned = 0;
    const depth = maxDepth || 3;
    const tree = scanTree(dirPath, 0, depth);
    parentPort.postMessage({ success: true, tree, filesScanned, truncated: filesScanned >= MAX_FILES_TOTAL });
  } else if (task === 'filetypes') {
    filesScanned = 0;
    const types = analyzeTypes(dirPath);
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
    parentPort.postMessage({ success: true, categories: formatted, totalSize: formatSize(totalSize), filesScanned, truncated: filesScanned >= MAX_FILES_TOTAL });
  } else if (task === 'search') {
    filesScanned = 0;
    const { query, maxResults, typeFilter, minSize, maxSize } = workerData;
    const results = [];
    const typeExts = { image: ['.jpg','.jpeg','.png','.gif','.bmp','.webp'], video: ['.mp4','.avi','.mkv','.mov','.wmv','.flv'], audio: ['.mp3','.wav','.flac','.aac','.ogg'], document: ['.doc','.docx','.pdf','.xls','.xlsx','.ppt','.pptx','.txt','.md','.csv'], archive: ['.zip','.rar','.7z','.tar','.gz'], code: ['.js','.ts','.py','.java','.cpp','.c','.h','.html','.css','.json'] };
    const validExts = typeFilter && typeExts[typeFilter] ? typeExts[typeFilter] : null;
    const qLower = (query || '').toLowerCase();
    walkSearch(dirPath, results, { query, maxResults, validExts, minSize: minSize || 0, maxSize: maxSize || Infinity, qLower }, 0);
    parentPort.postMessage({ success: true, results });
  } else {
    parentPort.postMessage({ success: false, error: 'Unknown task: ' + task });
  }
} catch(e) {
  parentPort.postMessage({ success: false, error: e.message, stack: e.stack });
}
