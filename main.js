const { app, BrowserWindow, ipcMain, Notification, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// package.json の build.appId と一致させる（Windows のトースト通知はこのIDでアプリを識別する）
const APP_ID = 'com.termnix-it.port-manager-tool';
// package.json の build.publish と一致させる
const RELEASES_URL = 'https://github.com/Termnix-IT/PortManagerTool/releases';

// 保存先を開発時（npm start）と配布版で同じ %APPDATA%\port-manager-tool に固定する。
// 配布版は productName からアプリ名が決まるため、固定しないとお気に入り・監視・履歴が引き継がれない。
// --user-data-dir 指定時（動作確認用）はそちらを優先する。electron-store は require 時に保存先を決めるため、
// この処理は src/store の require より前に置くこと。
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'port-manager-tool'));
}

// 2つ目の起動は既存のウィンドウを前面に出して終了する（履歴ファイルへの同時書き込みを防ぐ）
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}
const portScanner = require('./src/port-scanner');
const { createProcessKiller } = require('./src/port-killer');
const { createKillFlow } = require('./src/kill-flow');
const store = require('./src/store');
const { createMonitor } = require('./src/monitor');
const { createHistoryStorage } = require('./src/history-storage');
const { createPortHistory } = require('./src/port-history');
const { createUpdater } = require('./src/updater');
const validation = require('./src/validation');
const { autoUpdater } = require('electron-updater');

let mainWindow;

const monitor = createMonitor({ store, checkPorts: portScanner.checkPorts });
const portHistory = createPortHistory({
  scanTcpListeners: portScanner.scanTcpListeners,
  getCommandLines: portScanner.getCommandLines,
  storage: createHistoryStorage({ dir: path.join(app.getPath('userData'), 'history') }),
});
const updater = createUpdater({
  autoUpdater,
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  // electron-builder のポータブル版ランチャーが設定する
  isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
  hasUpdateConfig: fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')),
});
const killFlow = createKillFlow({
  killer: createProcessKiller(),
  showMessageBox: (options) => dialog.showMessageBox(mainWindow, options),
  selfPid: process.pid,
  // Win32_Process.GetOwner の "DOMAIN\user" 形式に合わせる
  currentUser: `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`,
});

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
      // preload は contextBridge と ipcRenderer のみを使うため sandbox で動作する
      sandbox: true,
    },
    backgroundColor: '#181818',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // アプリ内のページ以外へ遷移させない・新しいウィンドウを開かせない
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// --- IPC Handlers ---
// rendererからの引数はすべて src/validation.js で検証してから使う。
// 検証エラーは例外としてrendererへ返る（invokeがrejectされる）。

// App info
ipcMain.handle('app:info', () => ({ name: app.getName(), version: app.getVersion() }));
// 開くURLはrendererから受け取らず固定する
ipcMain.handle('app:open-releases', () => shell.openExternal(RELEASES_URL));

// Updates
ipcMain.handle('updates:get-status', () => updater.getStatus());
ipcMain.handle('updates:check', () => updater.check());
ipcMain.handle('updates:install', () => updater.install());

// Port scanning
ipcMain.handle('ports:scan', async () => {
  return portScanner.scanPorts();
});

// Kill process
// 確認ダイアログ・危険度判定・停止直前の再検証は src/kill-flow.js が担当する
ipcMain.handle('ports:kill', async (_event, rawRequest) => {
  let request;
  try {
    request = validation.validateKillRequest(rawRequest);
  } catch (err) {
    return { success: false, error: err.message };
  }
  const result = await killFlow.run(request);
  if (result.success) {
    portHistory.recordKill({ ...result, port: request.port, protocol: request.protocol });
  }
  return result;
});

// History
ipcMain.handle('history:list', (_event, options) => portHistory.list(validation.validateHistoryListOptions(options)));
ipcMain.handle('history:clear', async () => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['キャンセル', '削除する'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '履歴の削除',
    message: 'ポートの使用履歴をすべて削除しますか？',
    detail: 'この操作は元に戻せません。',
  });
  if (response !== 1) return { cleared: false };
  portHistory.clear();
  return { cleared: true };
});

// Favorites
ipcMain.handle('favorites:list', () => store.getFavorites());
ipcMain.handle('favorites:add', (_event, data) => store.addFavorite(validation.validateFavoriteInput(data)));
ipcMain.handle('favorites:remove', (_event, id) => store.removeFavorite(validation.validateId(id)));

// Monitors
ipcMain.handle('monitors:list', () => store.getMonitors());
ipcMain.handle('monitors:add', (_event, data) => store.addMonitor(validation.validateMonitorInput(data)));
ipcMain.handle('monitors:update', (_event, id, data) => (
  store.updateMonitor(validation.validateId(id), validation.validateMonitorUpdate(data))
));
ipcMain.handle('monitors:remove', (_event, id) => store.removeMonitor(validation.validateId(id)));

// Settings
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:update', (_event, data) => {
  const update = validation.validateSettingsUpdate(data);
  const prevInterval = store.getSettings().monitorIntervalMs;
  const settings = store.updateSettings(update);
  if (settings.monitorIntervalMs !== prevInterval) {
    monitor.restart();
  }
  return settings;
});

// --- Monitor callbacks ---
monitor.onError((err) => {
  console.error('[monitor] ポート確認に失敗しました。状態は更新せず次回に再試行します:', err.message);
});

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

// --- Updater callbacks ---
updater.onStatus((status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:status', status);
  }
  if (status.state === 'downloaded') {
    const notification = new Notification({
      title: 'アップデートの準備ができました',
      body: `バージョン ${status.latestVersion} は、アプリの終了時または設定画面の「再起動して更新」でインストールされます`,
    });
    notification.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notification.show();
  }
});

// --- History callbacks ---
portHistory.on('event', (event) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:event', event);
  }
});

portHistory.on('error', (err) => {
  console.error('[history] 待受一覧の取得に失敗しました。履歴は記録せず次回に再試行します:', err.message);
});

// --- App lifecycle ---
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  app.setAppUserModelId(APP_ID);
  createWindow();
  monitor.start();
  portHistory.start();
  updater.start();
});

app.on('window-all-closed', () => {
  monitor.stop();
  portHistory.stop();
  updater.stop();
  app.quit();
});
