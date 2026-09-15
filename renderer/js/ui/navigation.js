import { byId } from './dom.js';

// 「ポート一覧」は独立ビューではなく、ダッシュボード内の一覧へフォーカスする
const VIEW_ALIASES = { ports: 'dashboard' };

let viewHistory = ['dashboard'];
let viewHistoryIndex = 0;
let activeView = 'dashboard';
let viewLoaders = {};

export function getActiveView() {
  return activeView;
}

/**
 * @param {Record<string, (viewName: string) => void>} loaders
 *   ビュー名 → 表示時に呼ぶ処理。各ビューのモジュールを navigation から import しないよう、main.js から渡す。
 */
export function initNavigation(loaders) {
  viewLoaders = loaders;

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  byId('btn-history-back').addEventListener('click', () => {
    if (viewHistoryIndex <= 0) return;
    viewHistoryIndex -= 1;
    setView(viewHistory[viewHistoryIndex], { skipHistory: true });
  });

  byId('btn-history-forward').addEventListener('click', () => {
    if (viewHistoryIndex >= viewHistory.length - 1) return;
    viewHistoryIndex += 1;
    setView(viewHistory[viewHistoryIndex], { skipHistory: true });
  });

  updateHistoryButtons();
}

export function setView(viewName, { skipHistory = false } = {}) {
  const targetView = VIEW_ALIASES[viewName] || viewName;
  activeView = targetView;

  document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === viewName));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${targetView}`));

  if (!skipHistory && viewName !== viewHistory[viewHistoryIndex]) {
    viewHistory = [...viewHistory.slice(0, viewHistoryIndex + 1), viewName];
    viewHistoryIndex = viewHistory.length - 1;
  }
  updateHistoryButtons();

  const loader = viewLoaders[targetView];
  if (loader) loader(viewName);
}

function updateHistoryButtons() {
  byId('btn-history-back').disabled = viewHistoryIndex <= 0;
  byId('btn-history-forward').disabled = viewHistoryIndex >= viewHistory.length - 1;
}
