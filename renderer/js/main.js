// renderer のエントリーポイント。各モジュールの初期化と、画面をまたぐイベントの配線だけを行う
import { cleanIpcErrorMessage } from './lib/format.js';
import { initDashboard, loadDashboard, showDashboardView } from './ui/dashboard.js';
import { showToast } from './ui/dom.js';
import { initEvents, pushEvent } from './ui/events.js';
import { initFavorites, loadFavorites } from './ui/favorites.js';
import { initMonitors, loadMonitors } from './ui/monitors.js';
import { getActiveView, initNavigation } from './ui/navigation.js';
import { initSettings, loadSettings } from './ui/settings.js';
import { initSidebar } from './ui/sidebar.js';

// Main側の検証エラー等でinvokeがrejectされた場合に、握りつぶさず利用者に見せる
window.addEventListener('unhandledrejection', (event) => {
  const raw = event.reason?.message ?? String(event.reason);
  const message = cleanIpcErrorMessage(raw);
  pushEvent('warn', message);
  showToast(message);
});

window.portManager.onStatusChanged((data) => {
  const label = data.newState === 'occupied' ? '使用中' : '空き';
  pushEvent(data.newState === 'occupied' ? 'ok' : 'warn', `ポート ${data.port} が${label}になりました`);
  if (getActiveView() === 'dashboard') loadDashboard({ showScanning: false });
  if (getActiveView() === 'monitor') loadMonitors();
});

initSidebar();
initEvents();
initNavigation({
  dashboard: showDashboardView,
  favorites: loadFavorites,
  monitor: loadMonitors,
  settings: loadSettings,
});
initDashboard();
initFavorites();
initMonitors();
initSettings();

loadDashboard();
loadSettings();
