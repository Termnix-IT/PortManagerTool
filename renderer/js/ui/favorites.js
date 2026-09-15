import { escapeHtml, isValidPort, toNumber } from '../lib/format.js';
import { findEntryForPort, isPortOccupied } from '../lib/ports.js';
import { refreshState, state } from '../state.js';
import { showPortInDashboard } from './dashboard.js';
import { byId, showEmptyRow, showToast } from './dom.js';
import { pushEvent } from './events.js';
import { renderMetrics } from './metrics.js';

const COLUMN_COUNT = 6;

export async function loadFavorites() {
  try {
    await refreshState();
    renderFavorites();
    renderMetrics();
  } catch (err) {
    showEmptyRow(byId('favorites-table-body'), COLUMN_COUNT, `エラー: ${err.message}`);
  }
}

function renderFavorites() {
  const tbody = byId('favorites-table-body');
  if (state.favorites.length === 0) {
    showEmptyRow(tbody, COLUMN_COUNT, 'お気に入りが登録されていません');
    return;
  }

  tbody.innerHTML = state.favorites.map((f) => {
    const protocol = f.protocol || 'TCP';
    const occupied = isPortOccupied(state.ports, f.port, protocol);
    return `
      <tr data-id="${escapeHtml(f.id)}" data-port="${toNumber(f.port)}" data-protocol="${escapeHtml(protocol)}" data-label="${escapeHtml(f.label)}">
        <td><strong>${escapeHtml(f.label)}</strong></td>
        <td><button class="port-link" data-action="show">${escapeHtml(f.port)}</button></td>
        <td>${escapeHtml(protocol)}</td>
        <td>${escapeHtml(f.description || '')}</td>
        <td><span class="state-pill ${occupied ? 'active' : 'muted'}">${occupied ? '使用中' : '空き'}</span></td>
        <td>
          <div class="row-actions">
            <button class="action-btn" data-action="monitor">監視</button>
            <button class="action-btn delete" data-action="remove">削除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function addFavoriteFromForm() {
  const port = parseInt(byId('fav-port').value, 10);
  if (!isValidPort(port)) {
    alert('有効なポート番号（1-65535）を入力してください');
    return;
  }

  await window.portManager.addFavorite({
    port,
    label: byId('fav-label').value.trim() || `ポート ${port}`,
    description: byId('fav-desc').value.trim(),
    protocol: byId('fav-protocol').value,
  });
  byId('fav-port').value = '';
  byId('fav-label').value = '';
  byId('fav-desc').value = '';
  pushEvent('ok', `ポート ${port} をお気に入りに追加しました`);
  showToast(`ポート ${port} をお気に入りに追加しました`);
  await loadFavorites();
}

async function addMonitorFromFavorite({ port, protocol, label }) {
  const existing = findEntryForPort(state.monitors, port, protocol);
  await window.portManager.addMonitor({ port, label, protocol });
  pushEvent('ok', `ポート ${port} の監視を${existing ? '有効化' : '開始'}しました`);
  showToast(`ポート ${port} の監視を${existing ? '有効化' : '追加'}しました`);
  await loadFavorites();
}

async function removeFavorite(id) {
  await window.portManager.removeFavorite(id);
  pushEvent('warn', 'お気に入りを削除しました');
  await loadFavorites();
}

export function initFavorites() {
  byId('btn-add-fav').addEventListener('click', addFavoriteFromForm);

  byId('favorites-table-body').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    const row = event.target.closest('tr[data-id]');
    if (!button || !row) return;

    const port = toNumber(row.dataset.port);
    if (button.dataset.action === 'show') showPortInDashboard(port);
    if (button.dataset.action === 'monitor') {
      await addMonitorFromFavorite({ port, protocol: row.dataset.protocol, label: row.dataset.label });
    }
    if (button.dataset.action === 'remove') await removeFavorite(row.dataset.id);
  });
}
