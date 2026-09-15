import { escapeHtml, isValidPort, toNumber } from '../lib/format.js';
import { refreshState, state } from '../state.js';
import { showPortInDashboard } from './dashboard.js';
import { byId, showEmptyRow } from './dom.js';
import { pushEvent } from './events.js';

const COLUMN_COUNT = 6;

export async function loadMonitors() {
  try {
    await refreshState();
    renderMonitors();
  } catch (err) {
    showEmptyRow(byId('monitor-table-body'), COLUMN_COUNT, `エラー: ${err.message}`);
  }
}

function renderMonitors() {
  const tbody = byId('monitor-table-body');
  if (state.monitors.length === 0) {
    showEmptyRow(tbody, COLUMN_COUNT, '監視設定がありません');
    return;
  }

  tbody.innerHTML = state.monitors.map((m) => {
    const notify = [m.notifyOnOccupied && '使用開始', m.notifyOnFreed && '解放'].filter(Boolean).join(' / ') || 'なし';
    const occupied = m.lastKnownState === 'occupied';
    return `
      <tr data-id="${escapeHtml(m.id)}" data-port="${toNumber(m.port)}" data-enabled="${m.enabled ? 'true' : 'false'}">
        <td><strong>${escapeHtml(m.label)}</strong></td>
        <td><button class="port-link" data-action="show">${escapeHtml(m.port)}</button></td>
        <td><span class="state-pill ${occupied ? 'active' : 'muted'}">${occupied ? '使用中' : '空き'}</span></td>
        <td>${escapeHtml(notify)}</td>
        <td><button class="toggle ${m.enabled ? 'on' : ''}" data-action="toggle" title="有効/無効"></button></td>
        <td>
          <div class="row-actions">
            <button class="action-btn delete" data-action="remove">削除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function addMonitorFromForm() {
  const port = parseInt(byId('mon-port').value, 10);
  if (!isValidPort(port)) {
    alert('有効なポート番号（1-65535）を入力してください');
    return;
  }

  await window.portManager.addMonitor({
    port,
    label: byId('mon-label').value.trim() || `ポート ${port}`,
    notifyOnOccupied: byId('mon-notify-occupied').checked,
    notifyOnFreed: byId('mon-notify-freed').checked,
  });
  byId('mon-port').value = '';
  byId('mon-label').value = '';
  pushEvent('ok', `ポート ${port} の監視を開始しました`);
  await loadMonitors();
}

async function setMonitorEnabled(id, enabled) {
  await window.portManager.updateMonitor(id, { enabled });
  pushEvent('ok', `監視を${enabled ? '有効' : '無効'}にしました`);
  await loadMonitors();
}

async function removeMonitor(id) {
  await window.portManager.removeMonitor(id);
  pushEvent('warn', '監視設定を削除しました');
  await loadMonitors();
}

export function initMonitors() {
  byId('btn-add-mon').addEventListener('click', addMonitorFromForm);

  byId('monitor-table-body').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    const row = event.target.closest('tr[data-id]');
    if (!button || !row) return;

    if (button.dataset.action === 'show') showPortInDashboard(toNumber(row.dataset.port));
    if (button.dataset.action === 'toggle') await setMonitorEnabled(row.dataset.id, row.dataset.enabled !== 'true');
    if (button.dataset.action === 'remove') await removeMonitor(row.dataset.id);
  });
}
