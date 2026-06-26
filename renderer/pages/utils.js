/* Disken Shared Utilities */
const Disken = {
  // API helper
  async api(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch(e) {
      console.error('API error:', url, e);
      return null;
    }
  },

  // Format bytes
  formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  },

  // File type icon
  getTypeIcon(ext) {
    const map = {
      '.jpg':'🖼️','.jpeg':'🖼️','.png':'🖼️','.gif':'🖼️','.webp':'🖼️','.svg':'🖼️',
      '.mp4':'🎬','.avi':'🎬','.mkv':'🎬','.mov':'🎬',
      '.mp3':'🎵','.wav':'🎵','.flac':'🎵',
      '.pdf':'📄','.doc':'📄','.docx':'📄','.txt':'📄','.md':'📄',
      '.zip':'📦','.rar':'📦','.7z':'📦',
      '.exe':'⚙️','.msi':'⚙️',
      '.js':'📜','.ts':'📜','.py':'📜','.html':'📜','.css':'📜','.json':'📜',
      '.xls':'📊','.xlsx':'📊','.ppt':'📊','.pptx':'📊'
    };
    return map[ext] || '📄';
  },

  // Category color
  getCategoryColor(cat) {
    const map = {
      '图片': '#3b82f6', '视频': '#8b5cf6', '音频': '#ec4899',
      '文档': '#10b981', '压缩包': '#f59e0b', '程序': '#ef4444',
      '代码': '#06b6d4', '其他': '#6b7280'
    };
    return map[cat] || '#6b7280';
  },

  // Read CSS var
  cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  },

  // Get system home path via API, fallback to '/'
  async getHomePath() {
    const info = await this.api('/api/system-info');
    if (info && info.homeDir) return info.homeDir;
    if (info && info.user && info.homedir) return info.homedir;
    return '/';
  },

  // Add a directory picker UI into the specified container
  // onSelectCallback(selectedPath) is called when user picks a directory
  addDirPicker(containerId, onSelectCallback) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let currentPath = '/';

    // Create picker HTML
    container.innerHTML = '<div class="dir-picker">' +
      '<input type="text" class="dir-picker-input" id="' + containerId + '_input" value="/" readonly>' +
      '<button class="dir-picker-btn" id="' + containerId + '_browse">浏览</button>' +
    '</div>';

    const inputEl = document.getElementById(containerId + '_input');
    const browseBtn = document.getElementById(containerId + '_browse');

    // Initialize with home path (but allow user to switch to any drive)
    this.getHomePath().then(home => {
      currentPath = home;
      inputEl.value = home;
      if (onSelectCallback) onSelectCallback(home);
    });

    // Browse button click -> open modal
    browseBtn.addEventListener('click', () => {
      this._openDirModal(currentPath, (selectedPath) => {
        currentPath = selectedPath;
        inputEl.value = selectedPath;
        if (onSelectCallback) onSelectCallback(selectedPath);
      });
    });
  },

  // Internal: open directory browsing modal
  _openDirModal(initialPath, onSelect) {
    // Remove existing modal if any
    const existing = document.getElementById('diskenDirModal');
    if (existing) existing.remove();

    let currentDir = initialPath || '/';
    let drives = []; // available drives list

    const overlay = document.createElement('div');
    overlay.id = 'diskenDirModal';
    overlay.className = 'dir-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'dir-modal';

    const header = document.createElement('div');
    header.className = 'dir-modal-header';
    header.innerHTML = '<span class="dir-modal-title">选择目录</span>' +
      '<button class="dir-modal-close" id="dirModalClose">&times;</button>';

    // Body: sidebar (drives) + main content (path + list)
    const body = document.createElement('div');
    body.className = 'dir-modal-body';

    const sidebar = document.createElement('div');
    sidebar.className = 'dir-modal-sidebar';
    sidebar.innerHTML = '<div class="dir-sidebar-title">盘符</div>' +
      '<div class="dir-drives-list" id="dirDrivesList"><div class="loading-mini">加载中...</div></div>';

    const main = document.createElement('div');
    main.className = 'dir-modal-main';

    const pathDisplay = document.createElement('div');
    pathDisplay.className = 'dir-modal-path';
    pathDisplay.textContent = currentDir;

    const dirList = document.createElement('div');
    dirList.className = 'dir-list';
    dirList.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    main.appendChild(pathDisplay);
    main.appendChild(dirList);

    body.appendChild(sidebar);
    body.appendChild(main);

    const footer = document.createElement('div');
    footer.className = 'dir-modal-footer';
    footer.innerHTML = '<button class="dir-modal-cancel" id="dirModalCancel">取消</button>' +
      '<button class="dir-modal-select" id="dirModalSelect">选择此目录</button>';

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close handlers
    const closeModal = () => overlay.remove();
    document.getElementById('dirModalClose').addEventListener('click', closeModal);
    document.getElementById('dirModalCancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

    // Select handler
    document.getElementById('dirModalSelect').addEventListener('click', () => {
      onSelect(currentDir);
      closeModal();
    });

    // Extract drive root from a path (e.g. "C:\\foo\\bar" -> "C:\\", "C:/foo" -> "C:/", "C:" -> "C:")
    function getDriveRoot(p) {
      if (!p) return '';
      // Match Windows drive letter (C: or C:\ or C:/)
      const m = p.match(/^([A-Za-z]:)([\\\/].*)?$/);
      if (m) {
        // Return with trailing slash if path goes deeper, or "C:" for root
        return m[2] ? m[1] + m[2].charAt(0) : m[1];
      }
      // Unix root
      if (p.startsWith('/')) return '/';
      return '';
    }

    // Render drives in sidebar
    function renderDrives() {
      const list = document.getElementById('dirDrivesList');
      if (!list) return;
      if (!drives || drives.length === 0) {
        list.innerHTML = '<div class="empty-state-mini">未检测到盘符</div>';
        return;
      }
      const currentRoot = getDriveRoot(currentDir);
      let html = '';
      drives.forEach(function(d) {
        // Normalize root path: ensure it ends with slash for loading
        let root = d.mount || d.drive || (d.letter ? d.letter + ':' : '');
        if (!root) return;
        // Add backslash for Windows drives if not present
        const loadRoot = /^[A-Za-z]:$/.test(root) ? root + '\\' : root;
        const isActive = currentRoot && root.toLowerCase() === currentRoot.toLowerCase();
        const name = d.label || d.name || root;
        html += '<div class="dir-drive-item' + (isActive ? ' active' : '') + '" data-root="' + loadRoot + '">' +
          '<div class="dir-drive-icon">💾</div>' +
          '<div class="dir-drive-info">' +
            '<div class="dir-drive-name">' + name + '</div>' +
            '<div class="dir-drive-root">' + root + '</div>' +
          '</div>' +
        '</div>';
      });
      list.innerHTML = html;
      list.querySelectorAll('.dir-drive-item').forEach(function(el) {
        el.addEventListener('click', function() {
          loadDir(el.dataset.root);
        });
      });
    }

    // Load directory listing
    async function loadDir(dirPath) {
      currentDir = dirPath;
      pathDisplay.textContent = dirPath;
      dirList.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      renderDrives(); // update active drive highlight

      const data = await Disken.api('/api/list-dir?path=' + encodeURIComponent(dirPath));
      if (!data || !data.items) {
        dirList.innerHTML = '<div class="empty-state"><div class="empty-text">无法读取目录</div></div>';
        return;
      }

      // 后端返回的字段是 isDir（不是 isDirectory），且 name 为 ".." 时表示父目录
      const dirs = data.items.filter(function(item) { return item.isDir; });
      let html = '';

      // Sort directories alphabetically (put ".." first)
      dirs.sort(function(a, b) {
        if (a.name === '..') return -1;
        if (b.name === '..') return 1;
        return a.name.localeCompare(b.name);
      });

      dirs.forEach(function(item) {
        const isParent = item.name === '..';
        const fullPath = item.path || (dirPath === '/' ? '/' + item.name : dirPath + '/' + item.name);
        const displayName = isParent ? '.. (上级目录)' : item.name;
        const icon = isParent ? '⬆️' : '📁';
        html += '<div class="dir-item' + (isParent ? ' dir-item-parent' : '') + '" data-path="' + fullPath + '">' +
          '<span class="dir-item-icon">' + icon + '</span>' +
          '<span class="dir-item-name">' + displayName + '</span>' +
        '</div>';
      });

      if (dirs.length === 0) {
        html = '<div class="empty-state"><div class="empty-text">没有子目录</div></div>';
      }

      dirList.innerHTML = html;

      // Bind click events
      dirList.querySelectorAll('.dir-item').forEach(function(el) {
        el.addEventListener('click', function() {
          loadDir(el.dataset.path);
        });
      });
    }

    // Load drives list from API
    this.api('/api/disks').then(function(data) {
      if (data && data.disks) {
        drives = data.disks;
        renderDrives();
      }
    }).catch(function() {
      // fallback: build drives from currentDir or default
      drives = [{ mount: getDriveRoot(currentDir) || 'C:\\', label: 'C:', name: 'C:' }];
      renderDrives();
    });

    loadDir(currentDir);
  },

  // Add a refresh button to the specified container
  addRefreshButton(containerId, callback) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const btn = document.createElement('button');
    btn.className = 'refresh-btn';
    btn.innerHTML = '&#x21bb; 刷新';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.innerHTML = '&#x21bb; 刷新中...';
      const done = () => {
        btn.disabled = false;
        btn.innerHTML = '&#x21bb; 刷新';
      };
      if (callback) {
        const result = callback();
        if (result && typeof result.then === 'function') {
          result.then(done).catch(done);
        } else {
          done();
        }
      } else {
        done();
      }
    });
    container.appendChild(btn);
    return btn;
  },

  // Custom confirm dialog (replaces native confirm())
  showConfirm(message, onConfirm, onCancel) {
    const existing = document.getElementById('diskenConfirmOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'diskenConfirmOverlay';
    overlay.className = 'confirm-overlay';

    overlay.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-message">${message}</div>
        <div class="confirm-actions">
          <button class="confirm-cancel" id="confirmCancelBtn">取消</button>
          <button class="confirm-ok" id="confirmOkBtn">确定</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    document.getElementById('confirmCancelBtn').addEventListener('click', () => {
      close();
      if (onCancel) onCancel();
    });
    document.getElementById('confirmOkBtn').addEventListener('click', () => {
      close();
      if (onConfirm) onConfirm();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        close();
        if (onCancel) onCancel();
      }
    });
  },

  // Show loading overlay
  showLoading(text) {
    let overlay = document.getElementById('diskenLoadingOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'diskenLoadingOverlay';
      overlay.className = 'loading-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="loading-overlay-content">
        <div class="spinner" style="width:40px;height:40px;margin-bottom:0.75rem"></div>
        <div class="loading-overlay-text">${text || '加载中...'}</div>
      </div>
    `;
    overlay.style.display = 'flex';
    return overlay;
  },

  // Hide loading overlay
  hideLoading() {
    const overlay = document.getElementById('diskenLoadingOverlay');
    if (overlay) overlay.style.display = 'none';
  },

  // Build sidebar HTML
  sidebar(activePage) {
    const pages = [
      { id: 'index', icon: '📊', label: '概览', href: '/pages/index.html' },
      { id: 'search', icon: '🔍', label: '文件搜索', href: '/pages/search.html' },
      { id: 'visualization', icon: '📁', label: '空间可视化', href: '/pages/visualization.html' },
      { id: 'cleaner', icon: '🧹', label: '垃圾清理', href: '/pages/cleaner.html' },
      { id: 'health', icon: '💽', label: '硬盘状态', href: '/pages/health.html' },
    ];
    return `
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="logo">磁</div>
        <h1>磁盘精灵</h1>
      </div>
      <nav class="sidebar-nav">
        ${pages.map(p => `
          <a class="nav-item ${p.id === activePage ? 'active' : ''}" href="${p.href}">
            <span class="nav-icon">${p.icon}</span> ${p.label}
          </a>
        `).join('')}
      </nav>
      <div class="sidebar-footer">磁盘精灵 v1.4.2</div>
    </aside>`;
  },

  // Build topbar
  topbar(title) {
    return `
    <div class="topbar">
      <span class="topbar-title">${title}</span>
    </div>`;
  },

  // Init page structure
  initPage(activePage, title) {
    document.body.innerHTML = this.sidebar(activePage) + `
    <div class="main">
      ${this.topbar(title)}
      <div class="content" id="content"></div>
    </div>`;

    if (window.diskenAPI && window.diskenAPI.onShowAbout) {
      window.diskenAPI.onShowAbout(() => {
        Disken.showAbout();
      });
    }

    return document.getElementById('content');
  },

  showAbout() {
    const existing = document.getElementById('diskenAboutOverlay');
    if (existing) {
      existing.remove();
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'diskenAboutOverlay';
    overlay.className = 'about-overlay';

    overlay.innerHTML = `
      <div class="about-modal">
        <div class="about-header">
          <div class="about-logo">磁</div>
          <div class="about-title-group">
            <h2 class="about-title">磁盘精灵</h2>
            <div class="about-subtitle">Disken v1.4.0</div>
          </div>
        </div>
        <div class="about-body">
          <p class="about-desc">
            简约高效的硬盘管理工具，让你的磁盘空间一目了然。<br/>
            支持空间可视化、极速搜索、文件类型分析、硬盘健康监控等功能。
          </p>
          <div class="about-links">
            <a href="#" class="about-link" data-action="github">
              <span class="link-icon">🐙</span> GitHub 仓库
            </a>
            <a href="#" class="about-link" data-action="forum">
              <span class="link-icon">💬</span> 比赛论坛
            </a>
            <a href="#" class="about-link" data-action="feedback">
              <span class="link-icon">📧</span> 反馈建议
            </a>
          </div>
          <div class="about-tech">
            <span>Electron 33</span>
            <span>·</span>
            <span>ECharts</span>
            <span>·</span>
            <span>Node.js</span>
          </div>
        </div>
        <div class="about-footer">
          <button class="about-close-btn" id="aboutCloseBtn">关闭</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('aboutCloseBtn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    overlay.querySelectorAll('.about-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const action = link.dataset.action;
        if (action === 'github') {
          window.open('https://github.com/MEMZ-Studio/disken-app', '_blank');
        } else if (action === 'forum') {
          window.open('https://forum.trae.cn/t/topic/42832', '_blank');
        } else if (action === 'feedback') {
          window.location.href = 'mailto:renxplain@qq.com?subject=Disken%20%E7%A1%AC%E7%9B%98%E7%B2%BE%E7%81%B5%20-%20%E5%8F%8D%E9%A6%88';
        }
      });
    });
  }
};
