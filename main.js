const { app, BrowserWindow, ipcMain, Notification, dialog } = require('electron');
const path = require('path');
const portScanner = require('./src/port-scanner');
const portKiller = require('./src/port-killer');
const store = require('./src/store');
const monitor = require('./src/monitor');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#181818',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// --- IPC Handlers ---

// Port scanning
ipcMain.handle('ports:scan', async () => {
  return portScanner.scanPorts();
});

// Kill process
ipcMain.handle('ports:kill', async (_event, pid) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['キャンセル', '停止する'],
    defaultId: 0,
    cancelId: 0,
    title: '確認',
    message: `PID ${pid} のプロセスを停止しますか？`,
  });
  if (response === 1) {
    return portKiller.killProcess(pid);
  }
  return { success: false, cancelled: true };
});

// Favorites
ipcMain.handle('favorites:list', () => store.getFavorites());
ipcMain.handle('favorites:add', (_event, data) => store.addFavorite(data));
ipcMain.handle('favorites:remove', (_event, id) => store.removeFavorite(id));

// Monitors
ipcMain.handle('monitors:list', () => store.getMonitors());
ipcMain.handle('monitors:add', (_event, data) => store.addMonitor(data));
ipcMain.handle('monitors:update', (_event, id, data) => store.updateMonitor(id, data));
ipcMain.handle('monitors:remove', (_event, id) => store.removeMonitor(id));

// Settings
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:update', (_event, data) => store.updateSettings(data));

// --- Monitor callbacks ---
monitor.onStatusChanged((data) => {
  // Send to renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('monitor:status-changed', data);
  }

  // Desktop notification
  const stateLabel = data.newState === 'occupied' ? '使用中' : '空き';
  const notification = new Notification({
    title: `Port ${data.port} - ${stateLabel}`,
    body: data.newState === 'occupied'
      ? `${data.label} - Process: ${data.processName} (PID: ${data.pid})`
      : `${data.label} が解放されました`,
  });
  notification.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notification.show();
});

// --- App lifecycle ---
app.whenReady().then(() => {
  createWindow();
  monitor.start();
});

app.on('window-all-closed', () => {
  monitor.stop();
  app.quit();
});
