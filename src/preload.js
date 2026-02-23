// Preload — contextBridge 安全 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // File events from main process
    onFileNew: (callback) => ipcRenderer.on('file-new', callback),
    onFileOpened: (callback) => ipcRenderer.on('file-opened', (_, data) => callback(data)),
    onFileSaved: (callback) => ipcRenderer.on('file-saved', callback),
    onFolderOpened: (callback) => ipcRenderer.on('folder-opened', (_, data) => callback(data)),
    onTitleChanged: (callback) => ipcRenderer.on('title-changed', (_, data) => callback(data)),

    // Menu commands
    onMenuCommand: (callback) => ipcRenderer.on('menu-command', (_, data) => callback(data)),

    // Language change
    onLanguageChanged: (callback) => ipcRenderer.on('language-changed', (_, lang) => callback(lang)),

    // Content change notification
    contentModified: () => ipcRenderer.send('content-modified'),

    // File operations
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    openFileFromPath: (filePath) => ipcRenderer.invoke('open-file-from-path', filePath),
    createFileInFolder: () => ipcRenderer.invoke('create-file-in-folder'),
    deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
    renameFile: (oldPath, newName) => ipcRenderer.invoke('rename-file', oldPath, newName),

    // AI
    aiChat: (opts) => ipcRenderer.invoke('ai-chat', opts),
    aiStreamStart: (opts) => ipcRenderer.invoke('ai-stream-start', opts),
    aiStreamStop: () => ipcRenderer.send('ai-stream-stop'),
    onAIStreamChunk: (callback) => ipcRenderer.on('ai-stream-chunk', (_, text) => callback(text)),
    onAIStreamDone: (callback) => ipcRenderer.on('ai-stream-done', (_, text) => callback(text)),
    onAIStreamError: (callback) => ipcRenderer.on('ai-stream-error', (_, err) => callback(err)),
    getAIConfig: () => ipcRenderer.invoke('get-ai-config'),
    setAIConfig: (config) => ipcRenderer.invoke('set-ai-config', config),
});
