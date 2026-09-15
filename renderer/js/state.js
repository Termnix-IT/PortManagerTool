import { calculateMetrics, CATEGORY_FILTERS } from './lib/ports.js';
import { isScanUnusable } from './lib/scan-errors.js';

const METRIC_HISTORY_LIMIT = 16;

// 画面間で共有する状態。更新は各モジュールから直接行う（フレームワーク不使用のため単純なオブジェクト）
export const state = {
  ports: [],
  excludedRanges: [],
  favorites: [],
  monitors: [],
  settings: {},
  scanErrors: [],

  // ポート一覧の表示状態
  filteredPorts: [],
  sortKey: 'LocalPort',
  sortAsc: true,
  selectedPortKey: '',
  categoryFilter: loadCategoryFilter(),

  metricHistory: [],
};

function loadCategoryFilter() {
  try {
    const saved = localStorage.getItem('portCategoryFilter');
    return CATEGORY_FILTERS.includes(saved) ? saved : 'ALL';
  } catch {
    return 'ALL';
  }
}

export function saveCategoryFilter(category) {
  state.categoryFilter = category;
  try {
    localStorage.setItem('portCategoryFilter', category);
  } catch {
    // 保存できなくても表示は切り替える
  }
}

/**
 * Mainから最新の状態を取得する。スキャンが完全に失敗した場合は例外を投げる。
 */
export async function refreshState() {
  const [scanResult, favorites, monitors, settings] = await Promise.all([
    window.portManager.scanPorts(),
    window.portManager.getFavorites(),
    window.portManager.getMonitors(),
    window.portManager.getSettings(),
  ]);

  const scanErrors = Array.isArray(scanResult?.errors) ? scanResult.errors : [];
  if (isScanUnusable(scanErrors)) {
    throw new Error(`ポートのスキャンに失敗しました（${scanErrors[0].message}）`);
  }

  state.ports = Array.isArray(scanResult?.ports) ? scanResult.ports : [];
  state.excludedRanges = Array.isArray(scanResult?.excludedRanges) ? scanResult.excludedRanges : [];
  state.scanErrors = scanErrors;
  state.favorites = Array.isArray(favorites) ? favorites : [];
  state.monitors = Array.isArray(monitors) ? monitors : [];
  state.settings = settings || {};

  state.metricHistory = [
    ...state.metricHistory,
    { ...calculateMetrics(state), at: Date.now() },
  ].slice(-METRIC_HISTORY_LIMIT);
}
