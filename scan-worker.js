const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const { task, dirPath, maxDepth } = workerData;

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function scanTree(dirPath, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return null;
  const result = { name: path.basename(dirPath) || dirPath, size: 0, path: dirPath, children: [] };
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          const sub = scanTree(fullPath, depth + 1, maxDepth);
          if (sub && sub.size > 0) { result.children.push(sub); result.size += sub.size; }
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          const stat = fs.statSync(fullPath);
          result.size += stat.size;
          result.children.push({ name: entry.name, size: stat.size, path: fullPath, children: [] });
        }
      } catch(e) {}
    }
  } catch(e) {}
  return result;
}

function analyzeTypes(dirPath, depth = 0, maxDepth = 3) {
  const types = {};
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase() || '(无扩展名)';
          types[ext] = (types[ext] || 0) + fs.statSync(fullPath).size;
        } else if (entry.isDirectory() && depth < maxDepth) {
          const subTypes = analyzeTypes(fullPath, depth + 1, maxDepth);
          for (const [k, v] of Object.entries(subTypes)) types[k] = (types[k] || 0) + v;
        }
      } catch(e) {}
    }
  } catch(e) {}
  return types;
}

try {
  if (task === 'scan') {
    const tree = scanTree(dirPath, 0, maxDepth || 3);
    parentPort.postMessage({ success: true, tree });
  } else if (task === 'filetypes') {
    const types = analyzeTypes(dirPath, 0, maxDepth || 3);
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
    parentPort.postMessage({ success: true, categories: formatted, totalSize: formatSize(totalSize) });
  } else if (task === 'search') {
    const { query, maxResults, typeFilter, minSize, maxSize } = workerData;
    const results = [];
    const typeExts = { image: ['.jpg','.jpeg','.png','.gif','.bmp','.webp'], video: ['.mp4','.avi','.mkv','.mov','.wmv','.flv'], audio: ['.mp3','.wav','.flac','.aac','.ogg'], document: ['.doc','.docx','.pdf','.xls','.xlsx','.ppt','.pptx','.txt','.md','.csv'], archive: ['.zip','.rar','.7z','.tar','.gz'], code: ['.js','.ts','.py','.java','.cpp','.c','.h','.html','.css','.json'] };
    const validExts = typeFilter && typeExts[typeFilter] ? typeExts[typeFilter] : null;
    const qLower = (query || '').toLowerCase();

    function walk(dp, depth = 0) {
      if (results.length >= maxResults) return;
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
                let dirSize = 0;
                try {
                  const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
                  for (const e of subEntries) {
                    if (e.name.startsWith('.')) continue;
                    try {
                      if (e.isFile()) dirSize += fs.statSync(path.join(fullPath, e.name)).size;
                    } catch(e) {}
                  }
                } catch(e) {}
                results.push({ name: entry.name, path: fullPath, size: dirSize, sizeFormatted: formatSize(dirSize), modified: '', isDir: true, ext: '' });
              }
              walk(fullPath, depth + 1);
            }
          } catch(e) {}
        }
      } catch(e) {}
    }
    walk(dirPath);
    parentPort.postMessage({ success: true, results });
  } else {
    parentPort.postMessage({ success: false, error: 'Unknown task: ' + task });
  }
} catch(e) {
  parentPort.postMessage({ success: false, error: e.message, stack: e.stack });
}
