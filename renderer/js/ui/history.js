import { escapeHtml, formatDateTime } from '../lib/format.js';
import {
  describeHistoryEvent,
  filterHistory,
  historyTypeClass,
  historyTypeLabel,
  isNotableHistoryEvent,
  summarizeHistoryEvent,
} from '../lib/history.js';
import { categoryName } from '../lib/ports.js';
import { byId, showEmptyRow, showToast } from './dom.js';
import { pushEvent } from './events.js';
import { getActiveView } from './navigation.js';

const COLUMN_COUNT = 6;
const HISTORY_LIMIT = 1000;

let events = [];

function renderCategoryBadge(event) {
  if (!event.category) return '';
  const category = event.category === 'db' ? 'db' : 'dev';
  return `<span class="category-badge ${category}" title="${escapeHtml(categoryName(event.category))}">${escapeHtml(event.categoryLabel)}</span>`;
}

function renderRow(event) {
  const detail = describeHistoryEvent(event, formatDateTime);
  const commandLine = event.commandLine
    ? `<span class="process-sub command" title="${escapeHtml(event.commandLine)}">${escapeHtml(event.commandLine)}</span>`
    : '';
  return `
    <tr>
      <td class="history-time">${escapeHtml(formatDateTime(new Date(event.at)))}</td>
      <td><span class="state-pill ${historyTypeClass(event)}">${escapeHtml(historyTypeLabel(event))}</span></td>
      <td class="history-port">${event.port ? `${escapeHtml(event.port)}<span class="history-protocol">/${escapeHtml(event.protocol)}</span>` : '-'}</td>
      <td>
        <span class="process-name-line">
          <span class="process-name">${escapeHtml(event.processName || '<unknown>')}</span>
          ${renderCategoryBadge(event)}
        </span>
        ${commandLine}
      </td>
      <td class="pid-text">${escapeHtml(event.pid || '-')}</td>
      <td class="history-detail">${escapeHtml(detail)}</td>
    </tr>
  `;
}

function renderHistory() {
  const tbody = byId('history-table-body');
  const filtered = filterHistory(events, {
    type: byId('history-type').value,
    category: byId('history-category').value,
    text: byId('history-text').value,
  });
  byId('history-count').textContent = filtered.length;

  if (filtered.length === 0) {
    showEmptyRow(tbody, COLUMN_COUNT, events.length === 0
      ? '履歴はまだありません。アプリの起動中に10秒ごとにTCPの待受を確認して記録します'
      : '条件に一致する履歴はありません');
    return;
  }
  tbody.innerHTML = filtered.map(renderRow).join('');
}

export async function loadHistory() {
  try {
    events = await window.portManager.getHistory({ limit: HISTORY_LIMIT });
    renderHistory();
  } catch (err) {
    showEmptyRow(byId('history-table-body'), COLUMN_COUNT, `エラー: ${err.message}`);
  }
}

async function clearHistory() {
  const result = await window.portManager.clearHistory();
  if (!result.cleared) return;
  events = [];
  renderHistory();
  showToast('履歴を削除しました');
}

export function initHistory() {
  byId('history-type').addEventListener('change', renderHistory);
  byId('history-category').addEventListener('change', renderHistory);
  byId('history-text').addEventListener('input', renderHistory);
  byId('btn-clear-history').addEventListener('click', clearHistory);

  window.portManager.onHistoryEvent((event) => {
    events = [event, ...events].slice(0, HISTORY_LIMIT);
    if (getActiveView() === 'history') renderHistory();
    if (isNotableHistoryEvent(event)) {
      pushEvent(event.type === 'started' ? 'ok' : 'warn', summarizeHistoryEvent(event));
    }
  });
}
