# Disken v1.0.0

🎉 首个正式版本发布！

## ✨ 主要功能

- **空间可视化（SpaceSniffer 风格）** - Treemap 层级展示磁盘空间占用，支持点击下钻、面包屑导航
- **文件类型分析** - 按文件类型分类统计，图表可视化
- **文件搜索** - 快速定位文件和文件夹
- **磁盘健康监控** - 实时显示磁盘状态信息
- **文件操作** - 复制、剪切、粘贴、重命名、删除、打开所在文件夹

## 🛠️ 技术栈

- Electron + Node.js
- ECharts（数据可视化）
- HTML5 / CSS3 / Vanilla JavaScript
- Worker Threads（异步扫描）

## 📦 安装与运行

### Windows 用户
1. 下载 `disken-app-v1.0.0-win-x64.zip`
2. 解压后双击 `Disken.exe` 即可运行

### 开发者
```bash
git clone https://github.com/MEMZ-Studio/disken-app.git
cd disken-app
npm install
npm start
```

## 📋 系统要求

- Windows 10 / 11（64 位）
- 至少 500MB 可用磁盘空间

## 🐛 反馈

如有问题，请在 [Issues](https://github.com/MEMZ-Studio/disken-app/issues) 页面提交反馈。
