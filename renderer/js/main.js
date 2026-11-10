// renderer のエントリーポイント。各モジュールの初期化と、画面をまたぐイベントの配線だけを行う
// bridge.js は window.portManager を定義するため、必ず最初に import する
import './bridge.js';
import { errorMessage } from './lib/format.js';
import { initDashboard, loadDashboard, showDashboardView } from './ui/dashboard.js';
import { initDiagnostics, loadDiagnostics } from './ui/diagnostics.js';
import { showToast } from './ui/dom.js';
import { initEvents, pushEvent } from './ui/events.js';
import { initFavorites, loadFavorites } from './ui/favorites.js';
import { initHistory, loadHistory } from './ui/history.js';
import { initMonitors, loadMonitors } from './ui/monitors.js';
import { getActiveView, initNavigation } from './ui/navigation.js';
import { initSettings, loadSettings } from './ui/settings.js';
import { initSidebar } from './ui/sidebar.js';

// Rust 側の検証エラー等でinvokeがrejectされた場合に、握りつぶさず利用者に見せる
window.addEventListener('unhandledrejection', (event) => {
  const message = errorMessage(event.reason);
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
  diagnostics: loadDiagnostics,
  history: loadHistory,
  settings: loadSettings,
});
initDashboard();
initFavorites();
initMonitors();
initDiagnostics();
initHistory();
initSettings();

loadDashboard();
loadSettings();
