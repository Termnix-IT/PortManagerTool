// window.portManager: Rust 側のコマンド（src-tauri/src/commands.rs）を呼ぶ API。
// main.js が最初に import するため、他のモジュールより先に評価される。
// window.__TAURI__ は tauri.conf.json の withGlobalTauri で注入される
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function on(eventName, callback) {
  listen(eventName, (event) => callback(event.payload));
}

window.portManager = Object.freeze({
  // App: { name, version }
  getAppInfo: () => invoke('app_info'),
  openReleasesPage: () => invoke('app_open_releases'),

  // Updates: { state, currentVersion, latestVersion?, percent?, message?, checkedAt? }
  getUpdateStatus: () => invoke('updates_get_status'),
  checkForUpdates: () => invoke('updates_check'),
  installUpdate: () => invoke('updates_install'),
  onUpdateStatus: (callback) => on('updates:status', callback),

  // Port scanning: { ports, excludedRanges, errors }
  scanPorts: () => invoke('ports_scan'),

  // Kill process: { pid, port, protocol, processName }（port等は停止直前の再検証に使う）
  killProcess: (request) => invoke('ports_kill', { request }),

  // Favorites
  getFavorites: () => invoke('favorites_list'),
  addFavorite: (data) => invoke('favorites_add', { data }),
  removeFavorite: (id) => invoke('favorites_remove', { id }),

  // Monitors
  getMonitors: () => invoke('monitors_list'),
  addMonitor: (data) => invoke('monitors_add', { data }),
  updateMonitor: (id, data) => invoke('monitors_update', { id, data }),
  removeMonitor: (id) => invoke('monitors_remove', { id }),

  // Settings
  getSettings: () => invoke('settings_get'),
  updateSettings: (data) => invoke('settings_update', { data }),

  // History: ポートの使用開始/解放とアプリからの停止の記録
  getHistory: (options) => invoke('history_list', { options }),
  clearHistory: () => invoke('history_clear'),

  // Monitor events (Rust -> renderer)
  onStatusChanged: (callback) => on('monitor:status-changed', callback),

  // History events (Rust -> renderer)
  onHistoryEvent: (callback) => on('history:event', callback),
});
