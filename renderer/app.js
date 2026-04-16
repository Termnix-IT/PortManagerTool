// --- State ---
let allPorts = [];
let sortKey = 'LocalPort';
let sortAsc = true;

// --- DOM refs ---
const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const portsTableBody = document.getElementById('ports-table-body');
const portCount = document.getElementById('port-count');
const filterText = document.getElementById('filter-text');
const filterProtocol = document.getElementById('filter-protocol');
const filterState = document.getElementById('filter-state');
const btnRefresh = document.getElementById('btn-refresh');

// --- Tab switching ---
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.remove('active'));
    tabContents.forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

    // Refresh data on tab switch
    if (btn.dataset.tab === 'active-ports') loadPorts();
    if (btn.dataset.tab === 'favorites') loadFavorites();
    if (btn.dataset.tab === 'monitor') loadMonitors();
  });
});

// =====================
// Active Ports Tab
// =====================

async function loadPorts() {
  portsTableBody.innerHTML = '<tr><td colspan="7" class="text-center text-slate-500 py-8">スキャン中...</td></tr>';
  try {
    allPorts = await window.portManager.scanPorts();
    renderPorts();
  } catch (err) {
    portsTableBody.innerHTML = `<tr><td colspan="7" class="text-center text-red-400 py-8">エラー: ${err.message}</td></tr>`;
  }
}

function renderPorts() {
  const text = filterText.value.toLowerCase();
  const proto = filterProtocol.value;
  const state = filterState.value;

  let filtered = allPorts.filter((p) => {
    if (proto !== 'ALL' && p.Protocol !== proto) return false;
    if (state !== 'ALL' && p.State !== state) return false;
    if (text) {
      const haystack = `${p.LocalPort} ${p.ProcessName} ${p.PID} ${p.LocalAddress}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    let va = a[sortKey];
    let vb = b[sortKey];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });

  portCount.textContent = filtered.length;

  if (filtered.length === 0) {
    portsTableBody.innerHTML = '<tr><td colspan="7" class="text-center text-slate-500 py-8">該当するポートがありません</td></tr>';
    return;
  }

  portsTableBody.innerHTML = filtered
    .map(
      (p) => `
    <tr>
      <td class="py-1.5 px-2 font-mono text-blue-400">${p.LocalPort}</td>
      <td class="py-1.5 px-2 text-slate-400">${p.Protocol}</td>
      <td class="py-1.5 px-2 font-mono text-slate-400">${p.PID}</td>
      <td class="py-1.5 px-2">${escapeHtml(p.ProcessName)}</td>
      <td class="py-1.5 px-2"><span class="status-dot ${p.State === 'Listen' ? 'free' : 'occupied'}"></span>${p.State}</td>
      <td class="py-1.5 px-2 text-slate-400 font-mono text-xs">${p.LocalAddress}</td>
      <td class="py-1.5 px-2 text-right whitespace-nowrap">
        <button class="action-btn kill" onclick="killPort(${p.PID})">停止</button>
        <button class="action-btn star" onclick="quickFav(${p.LocalPort}, '${escapeAttr(p.ProcessName)}')">&#9733;</button>
      </td>
    </tr>`
    )
    .join('');
}

// Sort by column header
document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortAsc = !sortAsc;
    } else {
      sortKey = key;
      sortAsc = true;
    }
    renderPorts();
  });
});

// Filters
filterText.addEventListener('input', renderPorts);
filterProtocol.addEventListener('change', renderPorts);
filterState.addEventListener('change', renderPorts);
btnRefresh.addEventListener('click', loadPorts);

// Kill process
async function killPort(pid) {
  const result = await window.portManager.killProcess(pid);
  if (result.cancelled) return;
  if (result.success) {
    loadPorts();
  } else {
    alert('プロセスの停止に失敗しました: ' + result.error);
  }
}

// Quick add favorite from Active Ports
async function quickFav(port, processName) {
  await window.portManager.addFavorite({
    port,
    label: processName || `ポート ${port}`,
    protocol: 'TCP',
  });
  showToast(`ポート ${port} をお気に入りに追加しました`);
}

// =====================
// Favorites Tab
// =====================

async function loadFavorites() {
  const tbody = document.getElementById('favorites-table-body');
  const favorites = await window.portManager.getFavorites();

  if (favorites.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-slate-500 py-8">お気に入りが登録されていません</td></tr>';
    return;
  }

  // Check current port status for all favorites
  let portStatus = {};
  try {
    const ports = await window.portManager.scanPorts();
    for (const p of ports) {
      if (p.State === 'Listen') {
        portStatus[p.LocalPort] = true;
      }
    }
  } catch (_) { /* ignore */ }

  tbody.innerHTML = favorites
    .map(
      (f) => {
        const occupied = portStatus[f.port] || false;
        return `
    <tr>
      <td class="py-1.5 px-2 font-semibold">${escapeHtml(f.label)}</td>
      <td class="py-1.5 px-2 font-mono text-blue-400">${f.port}</td>
      <td class="py-1.5 px-2 text-slate-400">${f.protocol}</td>
      <td class="py-1.5 px-2 text-slate-400 text-xs">${escapeHtml(f.description)}</td>
      <td class="py-1.5 px-2">
        <span class="status-dot ${occupied ? 'occupied' : 'free'}"></span>${occupied ? '使用中' : '空き'}
      </td>
      <td class="py-1.5 px-2 text-right whitespace-nowrap">
        <button class="action-btn monitor" onclick="addMonitorFromFav(${f.port}, '${escapeAttr(f.label)}')">&#128065;</button>
        <button class="action-btn delete" onclick="removeFav('${f.id}')">&#10005;</button>
      </td>
    </tr>`;
      }
    )
    .join('');
}

document.getElementById('btn-add-fav').addEventListener('click', async () => {
  const port = parseInt(document.getElementById('fav-port').value);
  const label = document.getElementById('fav-label').value.trim();
  const desc = document.getElementById('fav-desc').value.trim();
  const protocol = document.getElementById('fav-protocol').value;

  if (!port || port < 1 || port > 65535) {
    alert('有効なポート番号（1-65535）を入力してください');
    return;
  }

  await window.portManager.addFavorite({ port, label: label || `ポート ${port}`, description: desc, protocol });
  document.getElementById('fav-port').value = '';
  document.getElementById('fav-label').value = '';
  document.getElementById('fav-desc').value = '';
  loadFavorites();
});

async function removeFav(id) {
  await window.portManager.removeFavorite(id);
  loadFavorites();
}

async function addMonitorFromFav(port, label) {
  await window.portManager.addMonitor({ port, label });
  showToast(`ポート ${port} を監視に追加しました`);
}

// =====================
// Monitor Tab
// =====================

async function loadMonitors() {
  const tbody = document.getElementById('monitor-table-body');
  const monitors = await window.portManager.getMonitors();
  const settings = await window.portManager.getSettings();

  document.getElementById('mon-interval').value = Math.round(settings.monitorIntervalMs / 1000);

  if (monitors.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-slate-500 py-8">監視設定がありません</td></tr>';
    return;
  }

  tbody.innerHTML = monitors
    .map(
      (m) => {
        const notifyParts = [];
        if (m.notifyOnOccupied) notifyParts.push('使用時');
        if (m.notifyOnFreed) notifyParts.push('解放時');
        return `
    <tr>
      <td class="py-1.5 px-2 font-semibold">${escapeHtml(m.label)}</td>
      <td class="py-1.5 px-2 font-mono text-blue-400">${m.port}</td>
      <td class="py-1.5 px-2">
        <span class="status-dot ${m.lastKnownState === 'occupied' ? 'occupied' : 'free'}"></span>${m.lastKnownState === 'occupied' ? '使用中' : '空き'}
      </td>
      <td class="py-1.5 px-2 text-slate-400 text-xs">${notifyParts.join('+') || 'なし'}</td>
      <td class="py-1.5 px-2">
        <button class="toggle ${m.enabled ? 'on' : ''}" onclick="toggleMonitor('${m.id}', ${!m.enabled})"></button>
      </td>
      <td class="py-1.5 px-2 text-right">
        <button class="action-btn delete" onclick="removeMonitor('${m.id}')">&#10005;</button>
      </td>
    </tr>`;
      }
    )
    .join('');
}

document.getElementById('btn-add-mon').addEventListener('click', async () => {
  const port = parseInt(document.getElementById('mon-port').value);
  const label = document.getElementById('mon-label').value.trim();
  const notifyOnOccupied = document.getElementById('mon-notify-occupied').checked;
  const notifyOnFreed = document.getElementById('mon-notify-freed').checked;

  if (!port || port < 1 || port > 65535) {
    alert('有効なポート番号（1-65535）を入力してください');
    return;
  }

  await window.portManager.addMonitor({ port, label: label || `ポート ${port}`, notifyOnOccupied, notifyOnFreed });
  document.getElementById('mon-port').value = '';
  document.getElementById('mon-label').value = '';
  loadMonitors();
});

document.getElementById('btn-apply-interval').addEventListener('click', async () => {
  const sec = parseInt(document.getElementById('mon-interval').value);
  if (!sec || sec < 1) return;
  await window.portManager.updateSettings({ monitorIntervalMs: sec * 1000 });
  showToast(`監視間隔を ${sec} 秒に変更しました`);
});

async function toggleMonitor(id, enabled) {
  await window.portManager.updateMonitor(id, { enabled });
  loadMonitors();
}

async function removeMonitor(id) {
  await window.portManager.removeMonitor(id);
  loadMonitors();
}

// Listen for status change events from main process
window.portManager.onStatusChanged((data) => {
  // Refresh monitor tab if it's visible
  const monTab = document.getElementById('tab-monitor');
  if (monTab.classList.contains('active')) {
    loadMonitors();
  }
});

// =====================
// Utilities
// =====================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-4 right-4 bg-slate-700 text-white text-sm px-4 py-2 rounded shadow-lg z-50 transition-opacity';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// --- Initial load ---
loadPorts();
