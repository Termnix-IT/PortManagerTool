import { buildSeriesPath } from '../lib/chart.js';
import { calculateMetrics } from '../lib/ports.js';
import { summarizeScanErrors } from '../lib/scan-errors.js';
import { state } from '../state.js';
import { byId } from './dom.js';
import { pushEvent } from './events.js';

const CHART_WIDTH = 320;
const CHART_HEIGHT = 140;
const CHART_SERIES = [
  { key: 'active', color: '#2563eb' },
  { key: 'monitoring', color: '#08b8c9' },
  { key: 'conflicts', color: '#f23567' },
];

let lastScanErrorKey = '';

export function renderMetrics() {
  const metrics = calculateMetrics(state);
  byId('metric-active').textContent = metrics.active;
  byId('metric-monitoring').textContent = metrics.monitoring;
  byId('metric-conflicts').textContent = metrics.conflicts;
  byId('metric-favorites').textContent = metrics.favorites;
  byId('metric-active-note').textContent = `${state.ports.length} 件を検出`;
  byId('metric-monitoring-note').textContent = `${state.monitors.length} 件の設定`;
  byId('metric-conflicts-note').textContent = metrics.conflicts > 0 ? '確認が必要' : '競合なし';
  byId('metric-favorites-note').textContent = 'お気に入り登録';
}

export function renderMetricChart() {
  const chart = byId('metric-chart');
  if (!chart) return;
  const maxValue = Math.max(1, ...state.metricHistory.flatMap((m) => CHART_SERIES.map((s) => m[s.key])));
  const paths = CHART_SERIES.map(({ key, color }) => {
    const d = buildSeriesPath(state.metricHistory.map((m) => m[key]), { maxValue, width: CHART_WIDTH, height: CHART_HEIGHT });
    return `<path d="${d}" stroke="${color}"></path>`;
  });
  chart.innerHTML = `
    <line class="grid-line" x1="0" y1="36" x2="320" y2="36"></line>
    <line class="grid-line" x1="0" y1="75" x2="320" y2="75"></line>
    <line class="grid-line" x1="0" y1="114" x2="320" y2="114"></line>
    ${paths.join('')}
  `;
}

export function renderScanWarning() {
  const warning = byId('scan-warning');
  const errors = state.scanErrors;

  if (errors.length === 0) {
    warning.hidden = true;
    warning.textContent = '';
    warning.title = '';
    lastScanErrorKey = '';
    return;
  }

  const summary = summarizeScanErrors(errors);
  warning.hidden = false;
  warning.textContent = `一部取得失敗: ${summary.sources}`;
  warning.title = summary.detail;

  // 画面遷移のたびに再スキャンするため、同じエラーが続く間はイベントを重ねない
  if (summary.key !== lastScanErrorKey) {
    pushEvent('warn', `スキャンの一部に失敗しました（${summary.sources}）`);
    lastScanErrorKey = summary.key;
  }
}
