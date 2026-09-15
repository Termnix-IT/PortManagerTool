import { escapeHtml, getProcessInitial, toNumber } from '../lib/format.js';
import {
  canStopPort,
  categoryName,
  countCategories,
  emptyMessageForCategory,
  filterPorts,
  findEntryForPort,
  getPortKey,
  sortPorts,
  stateClass,
  stateLabel,
} from '../lib/ports.js';
import { saveCategoryFilter, state } from '../state.js';
import { byId, showEmptyRow, showToast } from './dom.js';
import { pushEvent } from './events.js';
import { renderDetail } from './port-detail.js';

const COLUMN_COUNT = 7;

let reload = async () => {};

function renderCategoryBadge(port) {
  if (!port.Category) return '';
  const category = port.Category === 'db' ? 'db' : 'dev';
  return `<span class="category-badge ${category}" title="${escapeHtml(categoryName(port.Category))}">${escapeHtml(port.CategoryLabel)}</span>`;
}

// ボタンの data 属性に、Main側の再検証や登録で使うポート情報を持たせる
function portDataAttributes(port) {
  return `data-port="${toNumber(port.LocalPort)}" data-protocol="${escapeHtml(port.Protocol)}" data-process-name="${escapeHtml(port.ProcessName || '')}"`;
}

function renderRow(port) {
  const key = getPortKey(port);
  const favorite = findEntryForPort(state.favorites, port.LocalPort, port.Protocol);
  const monitor = findEntryForPort(state.monitors, port.LocalPort, port.Protocol);
  const subLine = port.CommandLine
    ? `<span class="process-sub command" title="${escapeHtml(port.CommandLine)}">${escapeHtml(port.CommandLine)}</span>`
    : `<span class="process-sub" title="${escapeHtml(port.LocalAddress || '')}">${escapeHtml(port.Protocol)} ${escapeHtml(port.LocalAddress || '')}</span>`;
  const stopAction = canStopPort(port)
    ? `<button class="action-btn kill" data-action="kill" data-pid="${toNumber(port.PID)}" ${portDataAttributes(port)}>停止</button>`
    : '<span class="action-placeholder">停止不可</span>';

  return `
    <tr class="${key === state.selectedPortKey ? 'selected' : ''}" data-port-key="${escapeHtml(key)}">
      <td>
        <button class="star-btn ${favorite ? 'active' : ''}" title="お気に入り" data-action="favorite" ${portDataAttributes(port)}>${favorite ? '★' : '☆'}</button>
      </td>
      <td><button class="port-link" data-action="select">${escapeHtml(port.LocalPort)}</button></td>
      <td>
        <div class="process-cell">
          <span class="process-badge">${escapeHtml(getProcessInitial(port.ProcessName))}</span>
          <span>
            <span class="process-name-line">
              <span class="process-name" title="${escapeHtml(port.ProcessName || '<unknown>')}">${escapeHtml(port.ProcessName || '<unknown>')}</span>
              ${renderCategoryBadge(port)}
            </span>
            ${subLine}
          </span>
        </div>
      </td>
      <td><span class="state-pill ${stateClass(port)}">${escapeHtml(stateLabel(port))}</span></td>
      <td class="pid-text">${escapeHtml(port.PID || '-')}</td>
      <td><button class="toggle ${monitor?.enabled ? 'on' : ''}" title="監視切替" data-action="monitor" ${portDataAttributes(port)}></button></td>
      <td>
        <div class="row-actions">
          <button class="action-btn" data-action="select">確認</button>
          ${stopAction}
        </div>
      </td>
    </tr>
  `;
}

function renderCategoryCounts() {
  const counts = countCategories(state.ports);
  byId('category-switch').querySelectorAll('[data-count]').forEach((el) => {
    el.textContent = counts[el.dataset.count];
  });
}

export function renderPorts() {
  const tbody = byId('ports-table-body');
  renderCategoryCounts();

  state.filteredPorts = sortPorts(
    filterPorts(state.ports, {
      category: state.categoryFilter,
      protocol: byId('filter-protocol').value,
      state: byId('filter-state').value,
      text: byId('filter-text').value,
    }),
    state.sortKey,
    state.sortAsc,
  );

  byId('port-count').textContent = state.filteredPorts.length;

  if (state.filteredPorts.length === 0) {
    state.selectedPortKey = '';
    showEmptyRow(tbody, COLUMN_COUNT, emptyMessageForCategory(state.categoryFilter));
    renderDetail();
    return;
  }

  if (!state.filteredPorts.some((p) => getPortKey(p) === state.selectedPortKey)) {
    state.selectedPortKey = getPortKey(state.filteredPorts[0]);
  }

  tbody.innerHTML = state.filteredPorts.map(renderRow).join('');
  renderDetail();
}

export function showPortsMessage(message) {
  showEmptyRow(byId('ports-table-body'), COLUMN_COUNT, message);
}

function setCategoryFilter(category) {
  saveCategoryFilter(category);
  byId('category-switch').querySelectorAll('.segment').forEach((btn) => {
    const active = btn.dataset.category === category;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  renderPorts();
}

function selectPort(key) {
  state.selectedPortKey = key;
  byId('ports-table-body').querySelectorAll('tr[data-port-key]').forEach((row) => {
    row.classList.toggle('selected', row.dataset.portKey === key);
  });
  renderDetail();
}

async function addFavoriteFromRow({ port, protocol, processName }) {
  if (findEntryForPort(state.favorites, port, protocol)) {
    showToast(`ポート ${port} は登録済みです`);
    return;
  }
  await window.portManager.addFavorite({ port, protocol, label: processName || `ポート ${port}` });
  pushEvent('ok', `ポート ${port} をお気に入りに追加しました`);
  showToast(`ポート ${port} をお気に入りに追加しました`);
  await reload();
}

async function toggleMonitorFromRow({ port, protocol, processName }) {
  const monitor = findEntryForPort(state.monitors, port, protocol);
  if (monitor) {
    await window.portManager.updateMonitor(monitor.id, { enabled: !monitor.enabled });
    pushEvent('ok', `ポート ${port} の監視を${monitor.enabled ? '停止' : '開始'}しました`);
  } else {
    await window.portManager.addMonitor({ port, protocol, label: processName || `ポート ${port}` });
    pushEvent('ok', `ポート ${port} の監視を開始しました`);
  }
  await reload();
}

async function killFromRow(button) {
  const pid = toNumber(button.dataset.pid);
  if (!pid) {
    alert('PIDが取得できないため停止できません');
    return;
  }

  // Main側で停止直前の再検証（数秒かかる）を行うため、その間は操作できないようにする
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = '確認中…';
  let result;
  try {
    result = await window.portManager.killProcess({
      pid,
      port: toNumber(button.dataset.port) || null,
      protocol: button.dataset.protocol || 'TCP',
      processName: button.dataset.processName || '',
    });
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  const name = result.processName || button.dataset.processName || `PID ${pid}`;
  if (result.success) {
    const method = result.method === 'graceful' ? '通常停止' : '強制停止';
    pushEvent('warn', `${name}（PID ${pid}）を${method}しました${result.tree ? '（子プロセスを含む）' : ''}`);
    await reload({ showScanning: true });
    return;
  }
  if (result.gracefulFailed) {
    pushEvent('warn', `${name}（PID ${pid}）は通常停止では終了しませんでした`);
    return;
  }
  if (result.cancelled) return;
  if (result.stale) {
    // 理由はMain側のダイアログで伝え済み。表示が古いので一覧を更新する
    pushEvent('warn', `停止を中止しました: ${result.error}`);
    await reload({ showScanning: true });
    return;
  }
  if (result.blocked) {
    pushEvent('warn', `${name}（PID ${pid}）は停止できないプロセスです`);
    return;
  }
  alert(`プロセスの停止に失敗しました: ${result.error}`);
}

function rowTarget(button) {
  return {
    port: toNumber(button.dataset.port),
    protocol: button.dataset.protocol || 'TCP',
    processName: button.dataset.processName || '',
  };
}

/**
 * @param {{ reload: (options?: { showScanning?: boolean }) => Promise<void> }} deps
 *   登録・監視・停止の後に呼ぶ再読み込み処理（dashboard.js を import しないため注入する）
 */
export function initPortsTable(deps) {
  reload = deps.reload;

  byId('category-switch').addEventListener('click', (event) => {
    const segment = event.target.closest('.segment');
    if (segment) setCategoryFilter(segment.dataset.category);
  });

  byId('filter-text').addEventListener('input', renderPorts);
  byId('filter-protocol').addEventListener('change', renderPorts);
  byId('filter-state').addEventListener('change', renderPorts);

  document.querySelectorAll('#ports-panel th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.sortAsc = state.sortKey === key ? !state.sortAsc : true;
      state.sortKey = key;
      renderPorts();
    });
  });

  byId('ports-table-body').addEventListener('click', async (event) => {
    const row = event.target.closest('tr[data-port-key]');
    if (!row) return;

    const button = event.target.closest('[data-action]');
    const action = button ? button.dataset.action : 'select';
    if (action === 'select') selectPort(row.dataset.portKey);
    if (action === 'favorite') await addFavoriteFromRow(rowTarget(button));
    if (action === 'monitor') await toggleMonitorFromRow(rowTarget(button));
    if (action === 'kill') await killFromRow(button);
  });

  setCategoryFilter(state.categoryFilter);
}
