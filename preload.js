const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portManager', {
  // Port scanning
  scanPorts: () => ipcRenderer.invoke('ports:scan'),

  // Kill process
  killProcess: (pid) => ipcRenderer.invoke('ports:kill', pid),

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

  // Monitor events (main -> renderer)
  onStatusChanged: (callback) => {
    ipcRenderer.on('monitor:status-changed', (_event, data) => callback(data));
  },
});
