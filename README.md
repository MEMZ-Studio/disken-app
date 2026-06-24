# Disken - 磁盘精灵

![GitHub release (latest by date)](https://img.shields.io/github/v/release/MEMZ-Studio/disken-app)
![GitHub All Releases](https://img.shields.io/github/downloads/MEMZ-Studio/disken-app/total)
![License](https://img.shields.io/github/license/MEMZ-Studio/disken-app)
![GitHub Stars](https://img.shields.io/github/stars/MEMZ-Studio/disken-app?style=social)

> 简约高效的硬盘管理工具，让你的磁盘空间一目了然。

---

## ✨ 功能特性

### 📊 磁盘概览
- 实时显示所有磁盘驱动器的容量、已用、可用空间
- 直观的磁盘空间使用进度条
- 支持多个硬盘/分区同时管理

### 🗺️ 空间可视化
- **Treemap 方块图**：类似 SpaceSniffer 的可视化效果
- **层级下钻**：点击文件夹深入查看子目录占用
- **面包屑导航**：快速返回上级目录
- **一键操作**：右键支持删除、复制、打开等操作

### 🔍 极速搜索
- **索引搜索**：首次构建索引后，搜索响应时间 < 100ms
- **实时回退**：未建立索引时自动切换到实时搜索
- **智能过滤**：支持按文件类型、大小范围筛选
- **结果高亮**：搜索关键词自动高亮显示

### 📈 文件类型分析
- 统计磁盘上各种文件类型的数量和占比
- 饼图直观展示文件类型分布
- 帮助用户了解空间占用构成

### 💽 硬盘状态监控
- 实时监测硬盘温度
- 显示 S.M.A.R.T. 健康状态
- 查看硬盘使用时长、通电次数等信息
- 提前预警潜在故障风险

---

## 🚀 快速开始

### 下载安装

**便携版（推荐）**
```
下载 Disken-Portable-x.x.x.exe，双击直接运行，无需安装
```

**绿色版**
```
解压 win-unpacked.zip，运行 Disken.exe
```

### 构建开发

```bash
# 克隆仓库
git clone https://github.com/MEMZ-Studio/disken-app.git
cd disken-app

# 安装依赖
npm install

# 启动开发模式
npm run dev

# 构建生产版本
npm run build:win
```

---

## 🎯 使用指南

### 空间可视化
1. 点击左侧菜单「空间可视化」
2. 在顶部选择要分析的磁盘或目录
3. 点击扫描按钮开始分析
4. 使用方块图查看空间分布，点击文件夹下钻
5. 使用面包屑导航返回上级目录

### 极速搜索
1. 点击左侧菜单「文件搜索」
2. 首次使用点击「构建索引」按钮
3. 等待索引构建完成
4. 输入关键词即可瞬间获取搜索结果
5. 支持双击打开文件，右键查看更多操作

### 硬盘状态
1. 点击左侧菜单「硬盘状态」
2. 查看所有硬盘的健康状态、温度、使用时长等信息

---

## 🛠️ 技术栈

- **框架**: Electron 33.x
- **语言**: JavaScript (ES6+)
- **UI**: 原生 HTML/CSS/JavaScript
- **图表**: ECharts
- **构建**: electron-builder
- **文件操作**: Node.js fs/path 模块

---

## 📁 项目结构

```
disken/
├── main.js              # Electron 主进程入口
├── server-core.js       # 后端 API 服务核心
├── file-index.js        # 文件索引管理模块
├── scan-worker.js       # 文件扫描 Worker
├── renderer/            # 渲染进程（前端页面）
│   └── pages/
│       ├── index.html   # 概览页面
│       ├── search.html  # 文件搜索页面
│       ├── visualization.html  # 空间可视化页面
│       ├── health.html  # 硬盘状态页面
│       ├── utils.js     # 前端工具函数
│       └── styles.css   # 全局样式
├── assets/              # 静态资源
├── _shared/             # 共享资源（如 ECharts）
└── dist/                # 构建输出目录
```

---

## ⚡ 性能特点

- **多线程扫描**：使用 Worker 线程避免 UI 卡顿
- **索引缓存**：索引数据持久化到本地，重启后无需重建
- **增量更新**：支持索引的增量更新，无需全量重建
- **内存优化**：采用扁平数组存储索引，内存占用低

---

## 🔒 安全特性

- **本地运行**：所有操作在本地完成，数据不上传云端
- **权限控制**：仅请求必要的文件系统访问权限
- **错误处理**：完善的异常捕获和错误提示

---

## 📝 更新日志

### v1.0.0
- ✅ 实现磁盘概览功能
- ✅ 实现空间可视化（Treemap）
- ✅ 实现极速搜索（索引模式）
- ✅ 实现文件类型分析
- ✅ 实现硬盘状态监控
- ✅ 支持文件操作（复制/剪切/删除/打开）
- ✅ 支持快捷键操作

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发规范
1. 代码风格：使用 ES6+ 语法，保持代码简洁
2. 提交信息：使用语义化提交信息
3. PR 流程：先提 Issue 讨论，再提交 PR

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE)

---

## 📮 联系方式

- 项目地址：https://github.com/MEMZ-Studio/disken-app
- 反馈邮箱：support@disken.app

---

**如果觉得这个工具对你有帮助，请给个 ⭐ Star 支持一下！**
