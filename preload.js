const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portManager', {
  // Port scanning
  scanPorts: () => ipcRenderer.invoke('ports:scan'),

  // Kill process: { pid, port, protocol, processName }（port等は停止直前の再検証に使う）
  killProcess: (request) => ipcRenderer.invoke('ports:kill', request),

  // Favorites
  getFavorites: () => ipcRenderer.invoke('favorites:list'),
  addFavorite: (data) => ipcRenderer.invoke('favorites:add', data),
  removeFavorite: (id) => ipcRenderer.invoke('favorites:remove', id),

  // Monitors
  getMonitors: () => ipcRenderer.invoke('monitors:list'),
  addMonitor: (data) => ipcRenderer.invoke('monitors:add', data),
  updateMonitor: (id, data) => ipcRenderer.invoke('monitors:update', id, data),
  removeMonitor: (id) => ipcRenderer.invoke('monitors:remove', id),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (data) => ipcRenderer.invoke('settings:update', data),

  // History: ポートの使用開始/解放とアプリからの停止の記録
  getHistory: (options) => ipcRenderer.invoke('history:list', options),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  // Monitor events (main -> renderer)
  onStatusChanged: (callback) => {
    ipcRenderer.on('monitor:status-changed', (_event, data) => callback(data));
  },

  // History events (main -> renderer)
  onHistoryEvent: (callback) => {
    ipcRenderer.on('history:event', (_event, data) => callback(data));
  },
});
