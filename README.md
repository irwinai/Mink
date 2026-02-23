# Mink 🐾

🌐 **官网 / Website**: [https://website-xi-jet-21.vercel.app](https://website-xi-jet-21.vercel.app)

[中文](#中文) | [English](#english)

---

<a id="中文"></a>

## 中文

**Mink** — 一款极简 WYSIWYG Markdown 桌面编辑器。

> "Mink" 读起来像 "ink"（墨水），象征书写与创作。

### ✨ 功能特性

- **所见即所得** — 输入 Markdown，实时渲染
- **极简设计** — 无干扰写作体验
- **文件管理** — 侧边栏文件树，支持新建/重命名/删除
- **大纲导航** — 自动生成标题大纲
- **源码模式** — `Cmd+/` 切换原始 Markdown
- **搜索替换** — `Cmd+F` 全文搜索与替换
- **深色主题** — 一键切换明暗主题
- **代码高亮** — 内置 One Dark 语法高亮
- **表格编辑** — 可视化表格
- **任务列表** — 可勾选的 TODO 项
- **国际化** — 中英文界面可切换
- **实时统计** — 字数/字符/行数

### 🚀 快速开始

```bash
# 安装依赖
npm install

# 启动开发
npm start

# 打包发布
npm run make
```

### ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd+N` | 新建文件 |
| `Cmd+O` | 打开文件 |
| `Cmd+S` | 保存 |
| `Cmd+F` | 搜索与替换 |
| `Cmd+B/I/E` | 加粗/斜体/行内代码 |
| `Cmd+K` | 插入链接 |
| `Cmd+1~4` | 标题 1-4 |
| `Cmd+/` | 源代码模式 |
| `Cmd+\` | 切换侧边栏 |

### 🏗 技术栈

| 技术 | 用途 |
|------|------|
| Electron | 桌面应用框架 |
| TipTap (ProseMirror) | 所见即所得编辑器 |
| Vite | 构建工具 |
| Turndown + Marked | Markdown ↔ HTML |
| lowlight | 代码语法高亮 |

### 📦 打包部署

```bash
# 打包成 macOS .app（未签名，本地使用）
npm run package

# 生成可分发的 .dmg + .zip
npm run make
```

打包产物在 `out/` 目录下：

| 命令 | 产物路径 | 格式 |
|------|---------|------|
| `npm run package` | `out/Mink-darwin-arm64/Mink.app` | 可直接运行的 .app |
| `npm run make` | `out/make/Mink-x.x.x-arm64.dmg` | macOS 安装镜像 |
| `npm run make` | `out/make/zip/darwin/arm64/` | 可分发的 .zip |

> **注意**：如需发布到 Mac App Store 或让其他用户无警告运行，  
> 需要配置 Apple Developer 签名证书。

### 📜 许可证

[MIT](LICENSE)

---

<a id="english"></a>

## English

**Mink** — A minimalist WYSIWYG Markdown desktop editor.

> The name "Mink" sounds like "ink", symbolizing writing and creation.

### ✨ Features

- **WYSIWYG** — Type Markdown, see it rendered instantly
- **Minimalist UI** — Distraction-free writing experience
- **File Management** — Sidebar file tree with create/rename/delete
- **Outline Navigation** — Auto-generated heading outline
- **Source Mode** — Toggle raw Markdown with `Cmd+/`
- **Search & Replace** — `Cmd+F` full-text search and replace
- **Dark Theme** — One-click light/dark switch
- **Code Highlighting** — Built-in syntax highlighting (One Dark)
- **Table Editing** — Visual tables with resizable columns
- **Task Lists** — Checkable todo items
- **i18n** — Chinese and English interface
- **Live Stats** — Word/character/line count

### 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development
npm start

# Package for distribution
npm run make
```

### ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|--------|------|
| `Cmd+N` | New file |
| `Cmd+O` | Open file |
| `Cmd+S` | Save |
| `Cmd+F` | Search & Replace |
| `Cmd+B/I/E` | Bold/Italic/Inline code |
| `Cmd+K` | Insert link |
| `Cmd+1~4` | Heading 1-4 |
| `Cmd+/` | Source code mode |
| `Cmd+\` | Toggle sidebar |

### 🏗 Tech Stack

| Technology | Purpose |
|------|------|
| Electron | Desktop app framework |
| TipTap (ProseMirror) | WYSIWYG editor core |
| Vite | Build tool |
| Turndown + Marked | Markdown ↔ HTML conversion |
| lowlight (highlight.js) | Code syntax highlighting |

### 📦 Packaging & Distribution

```bash
# Package as macOS .app (unsigned, for local use)
npm run package

# Build distributable .dmg + .zip
npm run make
```

Output in the `out/` directory:

| Command | Output Path | Format |
|---------|-----------|--------|
| `npm run package` | `out/Mink-darwin-arm64/Mink.app` | Runnable .app bundle |
| `npm run make` | `out/make/Mink-x.x.x-arm64.dmg` | macOS disk image |
| `npm run make` | `out/make/zip/darwin/arm64/` | Distributable .zip |

> **Note**: To distribute via the Mac App Store or allow other users to run without Gatekeeper warnings,
> you'll need to configure Apple Developer code signing.

### 📜 License

[MIT](LICENSE)

---

## 🔗 Links

- **官网 / Website**: [https://website-xi-jet-21.vercel.app](https://website-xi-jet-21.vercel.app)
- **GitHub**: [https://github.com/irwinai/Mink](https://github.com/irwinai/Mink)
- **Issues**: [https://github.com/irwinai/Mink/issues](https://github.com/irwinai/Mink/issues)
- **Releases**: [https://github.com/irwinai/Mink/releases](https://github.com/irwinai/Mink/releases)
