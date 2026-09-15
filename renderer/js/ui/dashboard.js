import { refreshState } from '../state.js';
import { byId } from './dom.js';
import { pushEvent, renderEvents } from './events.js';
import { renderMetricChart, renderMetrics, renderScanWarning } from './metrics.js';
import { setView } from './navigation.js';
import { renderDetail } from './port-detail.js';
import { initPortsTable, renderPorts, showPortsMessage } from './ports-table.js';

function renderDashboard() {
  renderScanWarning();
  renderMetrics();
  renderPorts();
  renderDetail();
  renderEvents();
  renderMetricChart();
}

/**
 * @param {{ showScanning?: boolean }} [options]
 *   showScanning: 一覧を「スキャン中...」にしてから取得する（画面遷移・更新ボタン・停止後）
 */
export async function loadDashboard({ showScanning = true } = {}) {
  if (showScanning) showPortsMessage('スキャン中...');
  try {
    await refreshState();
    renderDashboard();
  } catch (err) {
    showPortsMessage(`エラー: ${err.message}`);
  }
}

function focusPortsPanel() {
  const panel = byId('ports-panel');
  panel.classList.remove('focus-flash');
  requestAnimationFrame(() => panel.classList.add('focus-flash'));
}

// ナビゲーションから呼ばれる。「ポート一覧」ナビはダッシュボード内の一覧を強調する
export function showDashboardView(viewName) {
  loadDashboard();
  if (viewName === 'ports') focusPortsPanel();
}

// お気に入り・監視の画面からポート番号を指定してダッシュボードで表示する
export function showPortInDashboard(port) {
  byId('filter-text').value = String(port);
  setView('dashboard');
}

export function initDashboard() {
  initPortsTable({ reload: (options = {}) => loadDashboard({ showScanning: false, ...options }) });

  // 「競合」の件数から診断画面へ移動する
  const conflictsLink = byId('metric-conflicts-link');
  conflictsLink.addEventListener('click', () => setView('diagnostics'));
  conflictsLink.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setView('diagnostics');
    }
  });

  byId('btn-refresh').addEventListener('click', async () => {
    await loadDashboard();
    pushEvent('ok', 'ポート一覧を更新しました');
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      byId('filter-text').focus();
    }
  });
}
