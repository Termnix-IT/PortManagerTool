import { escapeHtml } from '../lib/format.js';
import {
  categoryName,
  findEntryForPort,
  formatRemote,
  getPortKey,
  stateClass,
  stateLabel,
} from '../lib/ports.js';
import { state } from '../state.js';
import { byId } from './dom.js';

function renderCommandBlock(port) {
  if (!port.Category) return '';
  if (!port.CommandLine) {
    return '<div class="command-block empty">コマンドラインを取得できませんでした（サービスや管理者権限のプロセスの可能性があります）</div>';
  }
  return `<div class="command-block">${escapeHtml(port.CommandLine)}</div>`;
}

export function renderDetail() {
  const detailState = byId('detail-state');
  const portDetail = byId('port-detail');
  const selected = state.filteredPorts.find((p) => getPortKey(p) === state.selectedPortKey);

  if (!selected) {
    detailState.className = 'state-pill muted';
    detailState.textContent = '未選択';
    portDetail.innerHTML = '<p class="empty-message">一覧からポートを選択してください</p>';
    return;
  }

  // 詳細パネルでは Established 以外を「使用中」の緑で示す
  detailState.className = `state-pill ${stateClass(selected) === 'active' ? 'active' : 'busy'}`;
  detailState.textContent = stateLabel(selected);

  const monitor = findEntryForPort(state.monitors, selected.LocalPort, selected.Protocol);
  const favorite = findEntryForPort(state.favorites, selected.LocalPort, selected.Protocol);

  portDetail.innerHTML = `
    <div class="detail-port">
      <strong>${escapeHtml(selected.LocalPort)}</strong>
      <span class="protocol-badge">${escapeHtml(selected.Protocol)}</span>
    </div>
    <div class="detail-list">
      <div class="detail-row"><span>プロセス</span><strong>${escapeHtml(selected.ProcessName || '<unknown>')}</strong></div>
      ${selected.Category ? `<div class="detail-row"><span>分類</span><strong>${escapeHtml(categoryName(selected.Category))} / ${escapeHtml(selected.CategoryLabel)}</strong></div>` : ''}
      <div class="detail-row"><span>PID</span><code>${escapeHtml(selected.PID || '-')}</code></div>
      <div class="detail-row"><span>状態</span><strong>${escapeHtml(stateLabel(selected))}</strong></div>
      <div class="detail-row"><span>ローカル</span><code>${escapeHtml(selected.LocalAddress || '-')}</code></div>
      <div class="detail-row"><span>リモート</span><code>${escapeHtml(formatRemote(selected))}</code></div>
      <div class="detail-row"><span>監視</span><strong>${monitor?.enabled ? '有効' : '無効'}</strong></div>
      <div class="detail-row"><span>予約</span><strong>${favorite ? '登録済み' : '未登録'}</strong></div>
    </div>
    ${renderCommandBlock(selected)}
  `;
}
