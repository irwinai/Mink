// Main Process — 窗口管理、文件系统、菜单
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('https');
const http = require('http');

// ===== Inlined AI Service =====
async function callAI(opts) {
  const { provider, apiKey, model, baseUrl, messages, stream = false, onChunk } = opts;
  switch (provider) {
    case 'openai': return _callOpenAI({ apiKey, model, baseUrl, messages, stream, onChunk });
    case 'claude': return _callClaude({ apiKey, model, baseUrl, messages, stream, onChunk });
    case 'ollama': return _callOllama({ model, baseUrl, messages, stream, onChunk });
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

async function _callOpenAI({ apiKey, model, baseUrl, messages, stream, onChunk }) {
  // Normalize baseUrl: accept base like http://host/v1 or full endpoint
  let endpoint = baseUrl || 'https://api.openai.com/v1/chat/completions';
  if (endpoint && !endpoint.endsWith('/chat/completions')) {
    // Fix common mistake: /v1/completions → /v1/chat/completions
    if (endpoint.endsWith('/completions')) {
      endpoint = endpoint.replace(/\/completions$/, '/chat/completions');
    } else {
      // Assume it's a base like http://host/v1
      endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
    }
  }
  const url = new URL(endpoint);
  const body = JSON.stringify({ model: model || 'gpt-4o-mini', messages, stream });
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  if (stream) {
    return _streamReq(url, headers, body, (line) => {
      if (line === 'data: [DONE]') return null;
      if (!line.startsWith('data: ')) return '';
      try { return JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; }
    }, onChunk);
  }
  const data = await _jsonReq(url, headers, body);
  return data.choices?.[0]?.message?.content || '';
}

async function _callClaude({ apiKey, model, baseUrl, messages, stream, onChunk }) {
  const url = new URL(baseUrl || 'https://api.anthropic.com/v1/messages');
  let system = '';
  const filtered = [];
  for (const msg of messages) { if (msg.role === 'system') system += (system ? '\n' : '') + msg.content; else filtered.push(msg); }
  const bodyObj = { model: model || 'claude-3-5-sonnet-20241022', max_tokens: 4096, messages: filtered, stream };
  if (system) bodyObj.system = system;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  if (stream) {
    return _streamReq(url, headers, JSON.stringify(bodyObj), (line) => {
      if (!line.startsWith('data: ')) return '';
      try { const j = JSON.parse(line.slice(6)); return j.type === 'content_block_delta' ? (j.delta?.text || '') : ''; } catch { return ''; }
    }, onChunk);
  }
  const data = await _jsonReq(url, headers, JSON.stringify(bodyObj));
  return data.content?.[0]?.text || '';
}

async function _callOllama({ model, baseUrl, messages, stream, onChunk }) {
  const url = new URL(baseUrl || 'http://localhost:11434/api/chat');
  const body = JSON.stringify({ model: model || 'llama3', messages, stream });
  const headers = { 'Content-Type': 'application/json' };
  if (stream) {
    return _streamReq(url, headers, body, (line) => {
      try { return JSON.parse(line).message?.content || ''; } catch { return ''; }
    }, onChunk);
  }
  const data = await _jsonReq(url, headers, body);
  return data.message?.content || '';
}

function _jsonReq(url, headers, body) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method: 'POST', headers }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`API ${res.statusCode}: ${d.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`Invalid JSON: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

function _streamReq(url, headers, body, parseLine, onChunk) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let full = '', buf = '';
    const req = lib.request(url, { method: 'POST', headers }, (res) => {
      if (res.statusCode >= 400) { let e = ''; res.on('data', c => e += c); res.on('end', () => reject(new Error(`API ${res.statusCode}: ${e.slice(0, 300)}`))); return; }
      res.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) { const t = l.trim(); if (!t) continue; const txt = parseLine(t); if (txt === null) continue; if (txt) { full += txt; if (onChunk) onChunk(txt); } }
      });
      res.on('end', () => { if (buf.trim()) { const txt = parseLine(buf.trim()); if (txt && txt !== null) { full += txt; if (onChunk) onChunk(txt); } } resolve(full); });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Stream timeout')); });
    req.write(body); req.end();
  });
}

// ===== Inline i18n =====
const i18nLocales = {
  zh: {
    about: '关于 Mink', hide: '隐藏', hideOthers: '隐藏其他', showAll: '显示全部', quit: '退出',
    file: '文件', newFile: '新建', open: '打开…', openFolder: '打开文件夹…',
    recentOpen: '最近打开', files: '文件', folders: '文件夹', noRecent: '无最近记录', clearRecent: '清除最近记录',
    save: '保存', saveAs: '另存为…',
    edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    paragraph: '段落', heading: '标题', increaseHeading: '提升标题级别', decreaseHeading: '降低标题级别',
    bold: '加粗', italic: '斜体', strikethrough: '删除线', inlineCode: '行内代码',
    bulletList: '无序列表', orderedList: '有序列表', taskList: '任务列表',
    blockquote: '引用', codeBlock: '代码块', horizontalRule: '水平线', table: '插入表格', link: '插入链接',
    view: '视图', toggleSidebar: '切换侧边栏', toggleOutline: '显示大纲',
    toggleSource: '源代码模式', toggleTheme: '切换主题',
    toggleFullscreen: '切换全屏', toggleDevTools: '开发者工具',
    help: '帮助', website: '官方网站', changelog: '更新日志', reportBug: '报告问题',
    openSource: '开源信息', license: '开源协议',
    language: '语言', chinese: '中文', english: 'English',
    untitled: '未命名', saveFailed: '保存失败', openFailed: '打开失败',
    unsavedTitle: '当前文件有未保存的更改', unsavedDetail: '是否保存更改?',
    btnSave: '保存', btnDontSave: '不保存', btnCancel: '取消',
    confirmDelete: '确定删除', deleteIrreversible: '此操作不可撤销', btnDelete: '删除',
    newMarkdown: '新建 Markdown 文件',
    aiSettings: 'AI 设置…',
  },
  en: {
    about: 'About Mink', hide: 'Hide', hideOthers: 'Hide Others', showAll: 'Show All', quit: 'Quit',
    file: 'File', newFile: 'New', open: 'Open…', openFolder: 'Open Folder…',
    recentOpen: 'Open Recent', files: 'Files', folders: 'Folders', noRecent: 'No Recent Items', clearRecent: 'Clear Recent',
    save: 'Save', saveAs: 'Save As…',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    paragraph: 'Paragraph', heading: 'Heading', increaseHeading: 'Increase Heading', decreaseHeading: 'Decrease Heading',
    bold: 'Bold', italic: 'Italic', strikethrough: 'Strikethrough', inlineCode: 'Inline Code',
    bulletList: 'Bullet List', orderedList: 'Ordered List', taskList: 'Task List',
    blockquote: 'Blockquote', codeBlock: 'Code Block', horizontalRule: 'Horizontal Rule', table: 'Insert Table', link: 'Insert Link',
    view: 'View', toggleSidebar: 'Toggle Sidebar', toggleOutline: 'Show Outline',
    toggleSource: 'Source Mode', toggleTheme: 'Toggle Theme',
    toggleFullscreen: 'Toggle Full Screen', toggleDevTools: 'Developer Tools',
    help: 'Help', website: 'Official Website', changelog: 'Changelog', reportBug: 'Report Issue',
    openSource: 'Open Source Info', license: 'License',
    language: 'Language', chinese: '中文', english: 'English',
    untitled: 'Untitled', saveFailed: 'Save Failed', openFailed: 'Open Failed',
    unsavedTitle: 'You have unsaved changes', unsavedDetail: 'Save changes?',
    btnSave: 'Save', btnDontSave: "Don't Save", btnCancel: 'Cancel',
    confirmDelete: 'Confirm delete', deleteIrreversible: 'This action cannot be undone', btnDelete: 'Delete',
    newMarkdown: 'New Markdown File',
    aiSettings: 'AI Settings…',
  },
};
let currentLang = 'zh';
function setLang(lang) { currentLang = lang; }
function getLang() { return currentLang; }
function t(key) { return (i18nLocales[currentLang] && i18nLocales[currentLang][key]) || key; }

// App icon path - resolve dynamically for dev and production
function resolveIcon() {
  // Try app root first (works in dev mode)
  const fromApp = path.join(app.getAppPath(), 'assets', 'icon.png');
  if (fs.existsSync(fromApp)) return fromApp;
  // Try __dirname-based paths (production)
  const fromDir2 = path.join(__dirname, '../../assets/icon.png');
  if (fs.existsSync(fromDir2)) return fromDir2;
  const fromDir1 = path.join(__dirname, '../assets/icon.png');
  if (fs.existsSync(fromDir1)) return fromDir1;
  return null;
}

// Handle Squirrel startup (Windows only)
if (process.platform === 'win32') {
  try { if (require('electron-squirrel-startup')) app.quit(); } catch { }
}

// Set app name (shows in macOS menu bar)
app.name = 'Mink';

let mainWindow;
let currentFilePath = null;
let currentFolderPath = null;
let isModified = false;
let isWelcomeDoc = false;

// ===== Config Persistence =====
const configPath = path.join(app.getPath('userData'), 'mink-config.json');
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch { }
  return { recentFiles: [], recentFolders: [], lastFolder: null, lastFile: null, welcomeShown: false, lang: 'zh' };
}
function saveConfig(config) {
  try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8'); } catch { }
}
function setLastFile(filePath) {
  const config = loadConfig();
  config.lastFile = filePath || null;
  saveConfig(config);
}
function addRecentFile(filePath) {
  const config = loadConfig();
  config.recentFiles = [filePath, ...config.recentFiles.filter(f => f !== filePath)].slice(0, 10);
  saveConfig(config);
  buildMenu();
}
function addRecentFolder(folderPath) {
  const config = loadConfig();
  const folders = config.recentFolders || [];
  config.recentFolders = [folderPath, ...folders.filter(f => f !== folderPath)].slice(0, 5);
  saveConfig(config);
  buildMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    show: false, // Prevent FOUC — show after ready-to-show
    icon: resolveIcon(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load the app - Vite plugin injects these variables
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    // Open DevTools in dev mode
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  updateTitle();
  buildMenu();

  // Show window only after first paint — prevents FOUC
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  // On page load: restore last file/folder, fallback to welcome doc.
  mainWindow.webContents.on('did-finish-load', () => {
    const config = loadConfig();
    let restoredLastFile = false;

    // If we already have a file open (HMR reload), re-send it
    if (currentFilePath && fs.existsSync(currentFilePath)) {
      try {
        const content = fs.readFileSync(currentFilePath, 'utf-8');
        mainWindow.webContents.send('file-opened', { content, path: currentFilePath });
        restoredLastFile = true;
      } catch { }
    }

    // Restore last opened file on fresh start
    if (!restoredLastFile && !currentFilePath && config.lastFile && fs.existsSync(config.lastFile)) {
      try {
        const content = fs.readFileSync(config.lastFile, 'utf-8');
        currentFilePath = config.lastFile;
        isModified = false;
        isWelcomeDoc = false;
        addRecentFile(config.lastFile);
        mainWindow.webContents.send('file-opened', { content, path: config.lastFile });
        updateTitle();
        restoredLastFile = true;
      } catch { }
    }

    // Show welcome doc only on very first launch if no file was restored.
    if (!restoredLastFile && !currentFilePath && !config.welcomeShown) {
      try {
        const welcomePath = path.join(__dirname, '../src/welcome.md');
        let content;
        if (fs.existsSync(welcomePath)) {
          content = fs.readFileSync(welcomePath, 'utf-8');
        } else {
          const altPath = path.join(app.getAppPath(), 'src/welcome.md');
          if (fs.existsSync(altPath)) {
            content = fs.readFileSync(altPath, 'utf-8');
          }
        }
        if (content) {
          isWelcomeDoc = true;
          mainWindow.webContents.send('file-opened', { content, path: null, isWelcome: true });
        }
      } catch { }
      config.welcomeShown = true;
      saveConfig(config);
    }

    // Always restore last folder
    if (config.lastFolder && fs.existsSync(config.lastFolder)) {
      currentFolderPath = config.lastFolder;
      const tree = readFolderTree(config.lastFolder);
      mainWindow.webContents.send('folder-opened', { path: config.lastFolder, tree });
    }
  });
}

function updateTitle() {
  const name = currentFilePath ? path.basename(currentFilePath) : t('untitled');
  const mod = isModified ? ' •' : '';
  mainWindow.setTitle(`${name}${mod}`);
  mainWindow.webContents.send('title-changed', { name, isModified, path: currentFilePath });
}

// ===== File Operations =====
async function newFile() {
  if (isModified && !isWelcomeDoc) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [t('btnSave'), t('btnDontSave'), t('btnCancel')],
      defaultId: 0,
      message: t('unsavedTitle'),
      detail: t('unsavedDetail'),
    });
    if (result.response === 0) await saveFile();
    if (result.response === 2) return;
  }
  currentFilePath = null;
  setLastFile(null);
  isModified = false;
  isWelcomeDoc = false;
  mainWindow.webContents.send('file-new');
  updateTitle();
}

async function openFile(filePath) {
  if (isModified && !isWelcomeDoc) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [t('btnSave'), t('btnDontSave'), t('btnCancel')],
      defaultId: 0,
      message: t('unsavedTitle'),
    });
    if (result.response === 0) await saveFile();
    if (result.response === 2) return;
  }

  let targetPath = filePath;
  if (!targetPath) {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled) return;
    targetPath = result.filePaths[0];
  }

  try {
    const content = fs.readFileSync(targetPath, 'utf-8');
    currentFilePath = targetPath;
    setLastFile(targetPath);
    isModified = false;
    isWelcomeDoc = false;
    addRecentFile(targetPath);
    mainWindow.webContents.send('file-opened', { content, path: targetPath });
    updateTitle();
  } catch (e) {
    dialog.showErrorBox('打开失败', e.message);
  }
}

async function saveFile() {
  if (!currentFilePath) return saveFileAs();

  try {
    const content = await mainWindow.webContents.executeJavaScript('window.__getMarkdown()');
    fs.writeFileSync(currentFilePath, content, 'utf-8');
    isModified = false;
    updateTitle();
    mainWindow.webContents.send('file-saved');
  } catch (e) {
    dialog.showErrorBox(t('saveFailed'), e.message);
  }
}

async function saveFileAs() {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    defaultPath: currentFilePath || '未命名.md',
  });
  if (result.canceled) return;

  currentFilePath = result.filePath;
  setLastFile(currentFilePath);
  await saveFile();
}

async function openFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled) return;

  const folderPath = result.filePaths[0];
  currentFolderPath = folderPath;
  const config = loadConfig();
  config.lastFolder = folderPath;
  saveConfig(config);
  addRecentFolder(folderPath);
  const tree = readFolderTree(folderPath);
  mainWindow.webContents.send('folder-opened', { path: folderPath, tree });
}

function readFolderTree(dirPath, depth = 0) {
  if (depth > 3) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(entry => {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return { name: entry.name, path: fullPath, isDir: true, children: readFolderTree(fullPath, depth + 1) };
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (['.md', '.markdown', '.txt'].includes(ext)) {
          return { name: entry.name, path: fullPath, isDir: false };
        }
        return null;
      })
      .filter(Boolean);
  } catch { return []; }
}

// ===== IPC Handlers =====
ipcMain.on('content-modified', () => {
  if (isWelcomeDoc) return; // Don't mark welcome doc as modified
  if (!isModified) {
    isModified = true;
    updateTitle();
  }
});

ipcMain.handle('read-file', async (_, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return null;
  }
});

ipcMain.handle('open-file-from-path', async (_, filePath) => {
  await openFile(filePath);
});

ipcMain.handle('create-file-in-folder', async () => {
  const defaultDir = currentFolderPath || app.getPath('documents');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t('newMarkdown'),
    defaultPath: path.join(defaultDir, '未命名.md'),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return { canceled: true };
  const filePath = result.filePath;
  try {
    fs.writeFileSync(filePath, '', 'utf-8');
    // Auto-set folder to file's directory and refresh tree
    const fileDir = path.dirname(filePath);
    if (!currentFolderPath) {
      currentFolderPath = fileDir;
    }
    const tree = readFolderTree(currentFolderPath);
    mainWindow.webContents.send('folder-opened', { path: currentFolderPath, tree });
    // Open the new file
    await openFile(filePath);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('delete-file', async (_, filePath) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [t('btnDelete'), t('btnCancel')],
    defaultId: 1,
    message: `${t('confirmDelete')} ${path.basename(filePath)}？`,
    detail: t('deleteIrreversible'),
  });
  if (result.response !== 0) return { canceled: true };
  try {
    fs.unlinkSync(filePath);
    if (currentFolderPath) {
      const tree = readFolderTree(currentFolderPath);
      mainWindow.webContents.send('folder-opened', { path: currentFolderPath, tree });
    }
    if (currentFilePath === filePath) {
      setLastFile(null);
      await newFile();
    }
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('rename-file', async (_, oldPath, newName) => {
  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, newName);
  try {
    if (fs.existsSync(newPath)) return { error: '文件名已存在' };
    fs.renameSync(oldPath, newPath);
    if (currentFilePath === oldPath) {
      currentFilePath = newPath;
      setLastFile(newPath);
      updateTitle();
    }
    if (currentFolderPath) {
      const tree = readFolderTree(currentFolderPath);
      mainWindow.webContents.send('folder-opened', { path: currentFolderPath, tree });
    }
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

// ===== AI IPC Handlers =====
let _activeAIStream = null;

ipcMain.handle('get-ai-config', () => {
  const config = loadConfig();
  return config.ai || { provider: 'openai', apiKey: '', model: '', baseUrl: '' };
});

ipcMain.handle('set-ai-config', (_, aiConfig) => {
  const config = loadConfig();
  config.ai = aiConfig;
  saveConfig(config);
  return { success: true };
});

ipcMain.handle('ai-chat', async (_, opts) => {
  try {
    const config = loadConfig();
    const ai = config.ai || {};
    const result = await callAI({
      provider: opts.provider || ai.provider || 'openai',
      apiKey: opts.apiKey || ai.apiKey,
      model: opts.model || ai.model,
      baseUrl: opts.baseUrl || ai.baseUrl,
      messages: opts.messages,
      stream: false,
    });
    return { result };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('ai-stream-start', async (_, opts) => {
  try {
    const config = loadConfig();
    const ai = config.ai || {};
    const provider = opts.provider || ai.provider || 'openai';
    const apiKey = opts.apiKey || ai.apiKey || '';
    const model = opts.model || ai.model || '';
    const baseUrl = opts.baseUrl || ai.baseUrl || '';
    console.log('[AI Stream] provider:', provider, 'apiKey:', apiKey ? apiKey.slice(0, 8) + '...' : '(empty)', 'model:', model, 'baseUrl:', baseUrl || '(default)');
    _activeAIStream = 'running';

    const result = await callAI({
      provider,
      apiKey,
      model,
      baseUrl,
      messages: opts.messages,
      stream: true,
      onChunk: (text) => {
        if (_activeAIStream === 'stopped') return;
        mainWindow?.webContents.send('ai-stream-chunk', text);
      },
    });

    _activeAIStream = null;
    mainWindow?.webContents.send('ai-stream-done', result);
    return { success: true };
  } catch (e) {
    _activeAIStream = null;
    mainWindow?.webContents.send('ai-stream-error', e.message);
    return { error: e.message };
  }
});

ipcMain.on('ai-stream-stop', () => {
  _activeAIStream = 'stopped';
});

// ===== Menu =====
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: t('about') },
        { type: 'separator' },
        { role: 'hide', label: t('hide') },
        { role: 'hideOthers', label: t('hideOthers') },
        { role: 'unhide', label: t('showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('quit') },
      ],
    }] : []),
    {
      label: t('file'),
      submenu: [
        { label: t('newFile'), accelerator: 'CmdOrCtrl+N', click: newFile },
        { label: t('open'), accelerator: 'CmdOrCtrl+O', click: () => openFile() },
        { label: t('openFolder'), accelerator: 'CmdOrCtrl+Shift+O', click: openFolder },
        {
          label: t('recentOpen'),
          submenu: (() => {
            const config = loadConfig();
            const items = [];
            const recentFiles = (config.recentFiles || []).filter(f => fs.existsSync(f));
            if (recentFiles.length > 0) {
              items.push({ label: t('files'), enabled: false });
              recentFiles.forEach(f => items.push({
                label: `  ${path.basename(f)}`,
                sublabel: f,
                click: () => openFile(f),
              }));
            }
            const recentFolders = (config.recentFolders || []).filter(f => fs.existsSync(f));
            if (recentFolders.length > 0) {
              if (items.length > 0) items.push({ type: 'separator' });
              items.push({ label: t('folders'), enabled: false });
              recentFolders.forEach(f => items.push({
                label: `  📁 ${path.basename(f)}`,
                sublabel: f,
                click: () => {
                  currentFolderPath = f;
                  const cfg = loadConfig();
                  cfg.lastFolder = f;
                  saveConfig(cfg);
                  const tree = readFolderTree(f);
                  mainWindow.webContents.send('folder-opened', { path: f, tree });
                },
              }));
            }
            if (items.length === 0) return [{ label: t('noRecent'), enabled: false }];
            items.push({ type: 'separator' });
            items.push({
              label: t('clearRecent'), click: () => {
                const cfg = loadConfig(); cfg.recentFiles = []; cfg.recentFolders = []; saveConfig(cfg); buildMenu();
              }
            });
            return items;
          })(),
        },
        { type: 'separator' },
        { label: t('save'), accelerator: 'CmdOrCtrl+S', click: saveFile },
        { label: t('saveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: saveFileAs },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [{ role: 'quit', label: t('quit') }]),
      ],
    },
    {
      label: t('edit'),
      submenu: [
        { role: 'undo', label: t('undo') },
        { role: 'redo', label: t('redo') },
        { type: 'separator' },
        { role: 'cut', label: t('cut') },
        { role: 'copy', label: t('copy') },
        { role: 'paste', label: t('paste') },
        { role: 'selectAll', label: t('selectAll') },
        { type: 'separator' },
        { label: getLang() === 'zh' ? '查找与替换' : 'Find & Replace', accelerator: 'CmdOrCtrl+F', click: () => sendCmd('find') },
      ],
    },
    {
      label: t('paragraph'),
      submenu: [
        { label: `${t('heading')} 1`, accelerator: 'CmdOrCtrl+1', click: () => sendCmd('heading', { level: 1 }) },
        { label: `${t('heading')} 2`, accelerator: 'CmdOrCtrl+2', click: () => sendCmd('heading', { level: 2 }) },
        { label: `${t('heading')} 3`, accelerator: 'CmdOrCtrl+3', click: () => sendCmd('heading', { level: 3 }) },
        { label: `${t('heading')} 4`, accelerator: 'CmdOrCtrl+4', click: () => sendCmd('heading', { level: 4 }) },
        { type: 'separator' },
        { label: t('increaseHeading'), accelerator: 'CmdOrCtrl+=', click: () => sendCmd('heading-increase') },
        { label: t('decreaseHeading'), accelerator: 'CmdOrCtrl+-', click: () => sendCmd('heading-decrease') },
        { type: 'separator' },
        { label: t('bulletList'), click: () => sendCmd('bulletList') },
        { label: t('orderedList'), click: () => sendCmd('orderedList') },
        { label: t('taskList'), click: () => sendCmd('taskList') },
        { type: 'separator' },
        { label: t('blockquote'), click: () => sendCmd('blockquote') },
        { label: t('codeBlock'), click: () => sendCmd('codeBlock') },
        { label: t('horizontalRule'), click: () => sendCmd('horizontalRule') },
        { label: t('table'), click: () => sendCmd('table') },
      ],
    },
    {
      label: getLang() === 'zh' ? '格式' : 'Format',
      submenu: [
        { label: t('bold'), accelerator: 'CmdOrCtrl+B', click: () => sendCmd('bold') },
        { label: t('italic'), accelerator: 'CmdOrCtrl+I', click: () => sendCmd('italic') },
        { label: t('strikethrough'), accelerator: 'CmdOrCtrl+Shift+X', click: () => sendCmd('strike') },
        { label: t('inlineCode'), accelerator: 'CmdOrCtrl+E', click: () => sendCmd('code') },
        { type: 'separator' },
        { label: t('link'), accelerator: 'CmdOrCtrl+K', click: () => sendCmd('link') },
      ],
    },
    {
      label: t('view'),
      submenu: [
        { label: t('toggleSidebar'), accelerator: 'CmdOrCtrl+\\', click: () => sendCmd('toggle-sidebar') },
        { label: t('toggleOutline'), accelerator: 'CmdOrCtrl+Shift+1', click: () => sendCmd('toggle-outline') },
        { type: 'separator' },
        { label: t('toggleSource'), accelerator: 'CmdOrCtrl+/', click: () => sendCmd('toggle-source') },
        { type: 'separator' },
        { label: t('toggleTheme'), click: () => sendCmd('toggle-theme') },
        { type: 'separator' },
        { label: t('toggleFullscreen'), accelerator: 'Ctrl+Cmd+F', click: () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); } },
        { label: t('toggleDevTools'), accelerator: 'Alt+CmdOrCtrl+I', click: () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); } },
      ],
    },
    {
      label: t('language'),
      submenu: [
        {
          label: t('chinese'),
          type: 'radio',
          checked: getLang() === 'zh',
          click: () => switchLanguage('zh'),
        },
        {
          label: t('english'),
          type: 'radio',
          checked: getLang() === 'en',
          click: () => switchLanguage('en'),
        },
      ],
    },
    {
      label: t('help'),
      submenu: [
        {
          label: t('website'),
          click: () => shell.openExternal('https://github.com/irwinai/Mink'),
        },
        {
          label: t('changelog'),
          click: () => shell.openExternal('https://github.com/irwinai/Mink/releases'),
        },
        {
          label: t('reportBug'),
          click: () => shell.openExternal('https://github.com/irwinai/Mink/issues'),
        },
        { type: 'separator' },
        {
          label: t('openSource'),
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: t('openSource'),
              message: 'Mink Editor — Open Source Libraries',
              detail: [
                '• Electron — Desktop app framework',
                '• TipTap / ProseMirror — WYSIWYG editor',
                '• Vite — Build tool',
                '• Turndown — HTML to Markdown',
                '• Marked — Markdown to HTML',
                '• lowlight / highlight.js — Code highlighting',
                '',
                'GitHub: https://github.com/irwinai/Mink',
              ].join('\n'),
            });
          },
        },
        {
          label: t('license'),
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: t('license'),
              message: 'MIT License',
              detail: 'Copyright (c) 2024 irwinai\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction.',
            });
          },
        },
        { type: 'separator' },
        {
          label: t('aiSettings') || 'AI Settings…',
          click: () => sendCmd('ai-settings'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function switchLanguage(lang) {
  setLang(lang);
  const config = loadConfig();
  config.lang = lang;
  saveConfig(config);
  buildMenu();
  updateTitle();
  // Notify renderer to update UI strings
  mainWindow.webContents.send('language-changed', lang);
}

function sendCmd(command, payload = {}) {
  mainWindow.webContents.send('menu-command', { command, ...payload });
}

// ===== App Lifecycle =====
app.whenReady().then(() => {
  // Restore language preference
  const config = loadConfig();
  if (config.lang) setLang(config.lang);

  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    try {
      const iconFile = resolveIcon();
      if (iconFile) {
        const icon = nativeImage.createFromPath(iconFile);
        if (!icon.isEmpty()) app.dock.setIcon(icon);
      }
    } catch { }
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Handle file open from OS (drag & drop or Open With)
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    openFile(filePath);
  }
});
