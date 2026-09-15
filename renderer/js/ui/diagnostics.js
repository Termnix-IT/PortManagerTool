import { checkPortAvailability, diagnoseConflicts } from '../lib/diagnostics.js';
import { escapeHtml, isValidPort } from '../lib/format.js';
import { refreshState, state } from '../state.js';
import { showPortInDashboard } from './dashboard.js';
import { byId } from './dom.js';

const STATUS_TEXT = {
  free: { label: '使用できます', className: 'active' },
  'in-use': { label: '使用中です', className: 'busy' },
  reserved: { label: '予約されていて使用できません', className: 'busy' },
};

function renderConflicts() {
  const list = byId('conflict-list');
  const conflicts = diagnoseConflicts(state.ports);
  const count = byId('conflict-count');
  count.textContent = `${conflicts.length} 件`;
  count.className = `state-pill ${conflicts.length > 0 ? 'busy' : 'muted'}`;

  if (conflicts.length === 0) {
    list.innerHTML = '<p class="empty-message">競合は見つかりませんでした</p>';
    return;
  }

  list.innerHTML = conflicts.map((conflict) => `
    <article class="diag-item">
      <div class="diag-item-head">
        <button class="port-link" data-action="show" data-port="${conflict.port}">${conflict.port}</button>
        <strong>${escapeHtml(conflict.title)}</strong>
      </div>
      <ul class="diag-processes">
        ${conflict.processes.map((p) => `
          <li><span class="process-name">${escapeHtml(p.processName)}</span> <span class="pid-text">PID ${escapeHtml(p.pid)}</span> <code>${escapeHtml(p.addresses.join(', '))}</code></li>
        `).join('')}
      </ul>
      <p class="diag-hint">${escapeHtml(conflict.hint)}</p>
    </article>
  `).join('');
}

function renderExcludedRanges() {
  const list = byId('excluded-range-list');
  const rangesUnavailable = state.scanErrors.some((e) => e.source === 'ExcludedRanges');
  if (rangesUnavailable) {
    list.innerHTML = '<p class="empty-message">予約ポート範囲を取得できませんでした</p>';
    return;
  }
  if (state.excludedRanges.length === 0) {
    list.innerHTML = '<p class="empty-message">予約されているポート範囲はありません</p>';
    return;
  }
  list.innerHTML = `
    <table class="data-table range-table">
      <thead><tr><th>開始</th><th>終了</th><th>件数</th><th>種類</th></tr></thead>
      <tbody>
        ${state.excludedRanges.map((range) => `
          <tr>
            <td>${range.start}</td>
            <td>${range.end}</td>
            <td>${range.end - range.start + 1}</td>
            <td>${range.managed ? '管理者が設定' : '自動（Hyper-V 等）'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderCheckResult() {
  const result = byId('port-check-result');
  const port = parseInt(byId('check-port').value, 10);
  if (!isValidPort(port)) {
    result.hidden = true;
    return;
  }

  const protocol = byId('check-protocol').value;
  const check = checkPortAvailability({ port, protocol, ports: state.ports, excludedRanges: state.excludedRanges });
  const status = STATUS_TEXT[check.status];
  result.hidden = false;
  result.innerHTML = `
    <div class="check-result-head">
      <strong>${port}/${escapeHtml(protocol)}</strong>
      <span class="state-pill ${status.className}">${status.label}</span>
      ${check.processes.length > 0 ? `<button class="action-btn" data-action="show" data-port="${port}">一覧で表示</button>` : ''}
    </div>
    ${check.reasons.length > 0 ? `<ul class="check-reasons">${check.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
  `;
}

export async function loadDiagnostics() {
  try {
    await refreshState();
    renderConflicts();
    renderExcludedRanges();
    renderCheckResult();
  } catch (err) {
    byId('conflict-list').innerHTML = `<p class="empty-message">エラー: ${escapeHtml(err.message)}</p>`;
  }
}

export function initDiagnostics() {
  byId('port-check-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const port = parseInt(byId('check-port').value, 10);
    if (!isValidPort(port)) {
      alert('有効なポート番号（1-65535）を入力してください');
      return;
    }
    // 判定には最新の状態を使う
    await loadDiagnostics();
  });
  byId('check-protocol').addEventListener('change', renderCheckResult);

  byId('view-diagnostics').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="show"]');
    if (button) showPortInDashboard(Number(button.dataset.port));
  });
}
