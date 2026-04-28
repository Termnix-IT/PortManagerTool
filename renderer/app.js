// --- State ---
let allPorts = [];
let favorites = [];
let monitors = [];
let settings = {};
let filteredPorts = [];
let sortKey = 'LocalPort';
let sortAsc = true;
let selectedPortKey = '';
let activeView = 'dashboard';
let eventLog = [];
let metricHistory = [];
let isSidebarResizing = false;
let viewHistory = ['dashboard'];
let viewHistoryIndex = 0;

// --- DOM refs ---
const appShell = document.getElementById('app-shell');
const navButtons = document.querySelectorAll('.nav-btn');
const views = document.querySelectorAll('.view');
const portsTableBody = document.getElementById('ports-table-body');
const favoritesTableBody = document.getElementById('favorites-table-body');
const monitorTableBody = document.getElementById('monitor-table-body');
const portCount = document.getElementById('port-count');
const filterText = document.getElementById('filter-text');
const filterProtocol = document.getElementById('filter-protocol');
const filterState = document.getElementById('filter-state');
const btnRefresh = document.getElementById('btn-refresh');
const portDetail = document.getElementById('port-detail');
const detailState = document.getElementById('detail-state');
const eventList = document.getElementById('event-list');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const btnHistoryBack = document.getElementById('btn-history-back');
const btnHistoryForward = document.getElementById('btn-history-forward');
const sidebarResizer = document.getElementById('sidebar-resizer');

// --- Navigation ---
navButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    setView(btn.dataset.view);
  });
});

function setView(viewName, options = {}) {
  const targetView = viewName === 'ports' ? 'dashboard' : viewName;
  activeView = targetView;
  navButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === viewName));
  views.forEach((view) => view.classList.toggle('active', view.id === `view-${targetView}`));

  if (!options.skipHistory && viewName !== viewHistory[viewHistoryIndex]) {
    viewHistory = viewHistory.slice(0, viewHistoryIndex + 1);
    viewHistory.push(viewName);
    viewHistoryIndex = viewHistory.length - 1;
  }
  updateHistoryButtons();

  if (targetView === 'dashboard') {
    loadDashboard();
    if (viewName === 'ports') {
      focusPortsPanel();
    }
  }
  if (targetView === 'favorites') loadFavorites();
  if (targetView === 'monitor') loadMonitors();
  if (targetView === 'settings') loadSettings();
}

function updateHistoryButtons() {
  btnHistoryBack.disabled = viewHistoryIndex <= 0;
  btnHistoryForward.disabled = viewHistoryIndex >= viewHistory.length - 1;
}

function focusPortsPanel() {
  const panel = document.getElementById('ports-panel');
  if (!panel) return;
  panel.classList.remove('focus-flash');
  requestAnimationFrame(() => panel.classList.add('focus-flash'));
}

btnHistoryBack.addEventListener('click', () => {
  if (viewHistoryIndex <= 0) return;
  viewHistoryIndex -= 1;
  setView(viewHistory[viewHistoryIndex], { skipHistory: true });
});

btnHistoryForward.addEventListener('click', () => {
  if (viewHistoryIndex >= viewHistory.length - 1) return;
  viewHistoryIndex += 1;
  setView(viewHistory[viewHistoryIndex], { skipHistory: true });
});

// =====================
// Sidebar
// =====================

function initSidebarLayout() {
  const savedWidth = Number(localStorage.getItem('sidebarWidth'));
  const collapsed = localStorage.getItem('sidebarCollapsed') === 'true';

  if (savedWidth) {
    setSidebarWidth(savedWidth);
  }
  setSidebarCollapsed(collapsed);
}

function setSidebarWidth(width) {
  const nextWidth = Math.min(340, Math.max(172, width));
  appShell.style.setProperty('--sidebar-width', `${nextWidth}px`);
  localStorage.setItem('sidebarWidth', String(nextWidth));
}

function setSidebarCollapsed(collapsed) {
  appShell.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('sidebarCollapsed', String(collapsed));
  btnToggleSidebar.setAttribute('aria-label', collapsed ? 'サイドバーを開く' : 'サイドバーを折りたたむ');
  btnToggleSidebar.setAttribute('title', collapsed ? 'サイドバーを開く' : 'サイドバーを折りたたむ');
}

btnToggleSidebar.addEventListener('click', () => {
  setSidebarCollapsed(!appShell.classList.contains('sidebar-collapsed'));
});

sidebarResizer.addEventListener('mousedown', (event) => {
  if (appShell.classList.contains('sidebar-collapsed')) return;
  isSidebarResizing = true;
  document.body.classList.add('is-resizing-sidebar');
  event.preventDefault();
});

document.addEventListener('mousemove', (event) => {
  if (!isSidebarResizing) return;
  setSidebarWidth(event.clientX);
});

document.addEventListener('mouseup', () => {
  if (!isSidebarResizing) return;
  isSidebarResizing = false;
  document.body.classList.remove('is-resizing-sidebar');
});

// =====================
// Dashboard
// =====================

async function loadDashboard() {
  portsTableBody.innerHTML = '<tr><td colspan="7" class="empty-cell">スキャン中...</td></tr>';
  try {
    await refreshState();
    renderDashboard();
  } catch (err) {
    portsTableBody.innerHTML = `<tr><td colspan="7" class="empty-cell">エラー: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function refreshState() {
  const [portsResult, favoritesResult, monitorsResult, settingsResult] = await Promise.all([
    window.portManager.scanPorts(),
    window.portManager.getFavorites(),
    window.portManager.getMonitors(),
    window.portManager.getSettings(),
  ]);

  allPorts = Array.isArray(portsResult) ? portsResult : [];
  favorites = Array.isArray(favoritesResult) ? favoritesResult : [];
  monitors = Array.isArray(monitorsResult) ? monitorsResult : [];
  settings = settingsResult || {};
  appendMetricSnapshot();
}

function renderDashboard() {
  renderMetrics();
  renderPorts();
  renderDetail();
  renderEvents();
  renderMetricChart();
}

function renderPorts() {
  const text = filterText.value.trim().toLowerCase();
  const proto = filterProtocol.value;
  const state = filterState.value;

  filteredPorts = allPorts.filter((p) => {
    if (proto !== 'ALL' && p.Protocol !== proto) return false;
    if (state !== 'ALL' && p.State !== state) return false;
    if (text) {
      const haystack = `${p.LocalPort} ${p.Protocol} ${p.ProcessName} ${p.PID} ${p.LocalAddress} ${p.RemoteAddress}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });

  filteredPorts.sort((a, b) => {
    let va = a[sortKey];
    let vb = b[sortKey];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });

  portCount.textContent = filteredPorts.length;

  if (filteredPorts.length === 0) {
    selectedPortKey = '';
    portsTableBody.innerHTML = '<tr><td colspan="7" class="empty-cell">該当するポートがありません</td></tr>';
    renderDetail();
    return;
  }

  if (!selectedPortKey || !filteredPorts.some((p) => getPortKey(p) === selectedPortKey)) {
    selectedPortKey = getPortKey(filteredPorts[0]);
  }

  portsTableBody.innerHTML = filteredPorts.map((p) => {
    const key = getPortKey(p);
    const fav = getFavoriteForPort(p.LocalPort, p.Protocol);
    const mon = getMonitorForPort(p.LocalPort, p.Protocol);
    const isSelected = key === selectedPortKey;
    const canStop = canStopPort(p);
    return `
      <tr class="${isSelected ? 'selected' : ''}" data-port-key="${escapeAttr(key)}">
        <td>
          <button class="star-btn ${fav ? 'active' : ''}" title="お気に入り" data-action="favorite" data-port="${toNumber(p.LocalPort)}" data-protocol="${escapeAttr(p.Protocol)}" data-process-name="${escapeAttr(p.ProcessName || '')}">${fav ? '★' : '☆'}</button>
        </td>
        <td><button class="port-link" data-action="select">${escapeHtml(String(p.LocalPort))}</button></td>
        <td>
          <div class="process-cell">
            <span class="process-badge">${escapeHtml(getProcessInitial(p.ProcessName))}</span>
            <span>
              <span class="process-name">${escapeHtml(p.ProcessName || '<unknown>')}</span>
              <span class="process-sub">${escapeHtml(p.Protocol)} ${escapeHtml(p.LocalAddress || '')}</span>
            </span>
          </div>
        </td>
        <td>${renderStatePill(p)}</td>
        <td class="pid-text">${escapeHtml(String(p.PID || '-'))}</td>
        <td><button class="toggle ${mon && mon.enabled ? 'on' : ''}" title="監視切替" data-action="monitor" data-port="${toNumber(p.LocalPort)}" data-protocol="${escapeAttr(p.Protocol)}" data-process-name="${escapeAttr(p.ProcessName || '')}"></button></td>
        <td>
          <div class="row-actions">
            <button class="action-btn" data-action="select">確認</button>
            ${canStop ? `<button class="action-btn kill" data-action="kill" data-pid="${toNumber(p.PID)}">停止</button>` : '<span class="action-placeholder">停止不可</span>'}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderDetail();
}

function renderMetrics() {
  const metrics = calculateMetrics();
  document.getElementById('metric-active').textContent = metrics.active;
  document.getElementById('metric-monitoring').textContent = metrics.monitoring;
  document.getElementById('metric-conflicts').textContent = metrics.conflicts;
  document.getElementById('metric-favorites').textContent = metrics.favorites;
  document.getElementById('metric-active-note').textContent = `${allPorts.length} 件を検出`;
  document.getElementById('metric-monitoring-note').textContent = `${monitors.length} 件の設定`;
  document.getElementById('metric-conflicts-note').textContent = metrics.conflicts > 0 ? '確認が必要' : '競合なし';
  document.getElementById('metric-favorites-note').textContent = 'お気に入り登録';
}

function calculateMetrics() {
  const active = allPorts.filter((p) => p.State === 'Listen' || p.Protocol === 'UDP').length;
  const monitoring = monitors.filter((m) => m.enabled).length;
  const favoritesCount = favorites.length;
  const portCounts = new Map();
  allPorts.forEach((p) => {
    const key = `${p.Protocol}:${p.LocalPort}`;
    portCounts.set(key, (portCounts.get(key) || 0) + 1);
  });
  const conflicts = [...portCounts.values()].filter((count) => count > 1).length;
  return { active, monitoring, conflicts, favorites: favoritesCount };
}

function appendMetricSnapshot() {
  const metrics = calculateMetrics();
  metricHistory.push({ ...metrics, at: Date.now() });
  metricHistory = metricHistory.slice(-16);
}

function renderDetail() {
  const selected = filteredPorts.find((p) => getPortKey(p) === selectedPortKey);
  if (!selected) {
    detailState.className = 'state-pill muted';
    detailState.textContent = '未選択';
    portDetail.innerHTML = '<p class="empty-message">一覧からポートを選択してください</p>';
    return;
  }

  detailState.className = `state-pill ${selected.State === 'Listen' || selected.Protocol === 'UDP' ? 'active' : 'busy'}`;
  detailState.textContent = stateLabel(selected);

  portDetail.innerHTML = `
    <div class="detail-port">
      <strong>${escapeHtml(String(selected.LocalPort))}</strong>
      <span class="protocol-badge">${escapeHtml(selected.Protocol)}</span>
    </div>
    <div class="detail-list">
      <div class="detail-row"><span>プロセス</span><strong>${escapeHtml(selected.ProcessName || '<unknown>')}</strong></div>
      <div class="detail-row"><span>PID</span><code>${escapeHtml(String(selected.PID || '-'))}</code></div>
      <div class="detail-row"><span>状態</span><strong>${escapeHtml(stateLabel(selected))}</strong></div>
      <div class="detail-row"><span>ローカル</span><code>${escapeHtml(selected.LocalAddress || '-')}</code></div>
      <div class="detail-row"><span>リモート</span><code>${escapeHtml(formatRemote(selected))}</code></div>
      <div class="detail-row"><span>監視</span><strong>${getMonitorForPort(selected.LocalPort, selected.Protocol)?.enabled ? '有効' : '無効'}</strong></div>
      <div class="detail-row"><span>予約</span><strong>${getFavoriteForPort(selected.LocalPort, selected.Protocol) ? '登録済み' : '未登録'}</strong></div>
    </div>
  `;
}

function renderMetricChart() {
  const chart = document.getElementById('metric-chart');
  if (!chart) return;
  const active = metricHistory.map((m) => m.active);
  const monitoring = metricHistory.map((m) => m.monitoring);
  const conflicts = metricHistory.map((m) => m.conflicts);
  const maxValue = Math.max(1, ...active, ...monitoring, ...conflicts);
  chart.innerHTML = `
    <line class="grid-line" x1="0" y1="36" x2="320" y2="36"></line>
    <line class="grid-line" x1="0" y1="75" x2="320" y2="75"></line>
    <line class="grid-line" x1="0" y1="114" x2="320" y2="114"></line>
    ${pathForSeries(active, maxValue, '#2563eb', 320, 140)}
    ${pathForSeries(monitoring, maxValue, '#08b8c9', 320, 140)}
    ${pathForSeries(conflicts, maxValue, '#f23567', 320, 140)}
  `;
}

function pathForSeries(values, maxValue, width, heightOrColor, maybeWidth, maybeHeight) {
  let color = width;
  let w = heightOrColor;
  let h = maybeWidth;
  if (typeof maybeHeight === 'number') {
    color = heightOrColor;
    w = maybeWidth;
    h = maybeHeight;
  }

  const safeValues = values.length > 1 ? values : [0, values[0] || 0];
  const inset = 4;
  const step = (w - inset * 2) / Math.max(1, safeValues.length - 1);
  const points = safeValues.map((value, index) => {
    const x = inset + index * step;
    const y = h - (value / maxValue) * (h - inset * 2) - inset;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `<path d="M ${points.join(' L ')}" stroke="${color}"></path>`;
}

// =====================
// Favorites
// =====================

async function loadFavorites() {
  try {
    await refreshState();
    renderFavorites();
    renderMetrics();
  } catch (err) {
    favoritesTableBody.innerHTML = `<tr><td colspan="6" class="empty-cell">エラー: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderFavorites() {
  if (favorites.length === 0) {
    favoritesTableBody.innerHTML = '<tr><td colspan="6" class="empty-cell">お気に入りが登録されていません</td></tr>';
    return;
  }

  favoritesTableBody.innerHTML = favorites.map((f) => {
    const occupied = allPorts.some((p) => Number(p.LocalPort) === Number(f.port) && (p.State === 'Listen' || p.Protocol === 'UDP'));
    return `
      <tr>
        <td><strong>${escapeHtml(f.label)}</strong></td>
        <td><button class="port-link" onclick="showPortFromSecondary(${toNumber(f.port)})">${escapeHtml(String(f.port))}</button></td>
        <td>${escapeHtml(f.protocol || 'TCP')}</td>
        <td>${escapeHtml(f.description || '')}</td>
        <td><span class="state-pill ${occupied ? 'active' : 'muted'}">${occupied ? '使用中' : '空き'}</span></td>
        <td>
          <div class="row-actions">
            <button class="action-btn" onclick="addMonitorFromFav(${toNumber(f.port)}, ${jsString(f.label)}, ${jsString(f.protocol || 'TCP')})">監視</button>
            <button class="action-btn delete" onclick="removeFav(${jsString(f.id)})">削除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

document.getElementById('btn-add-fav').addEventListener('click', async () => {
  const port = parseInt(document.getElementById('fav-port').value, 10);
  const label = document.getElementById('fav-label').value.trim();
  const desc = document.getElementById('fav-desc').value.trim();
  const protocol = document.getElementById('fav-protocol').value;

  if (!isValidPort(port)) {
    alert('有効なポート番号（1-65535）を入力してください');
    return;
  }

  await window.portManager.addFavorite({ port, label: label || `ポート ${port}`, description: desc, protocol });
  document.getElementById('fav-port').value = '';
  document.getElementById('fav-label').value = '';
  document.getElementById('fav-desc').value = '';
  pushEvent('ok', `ポート ${port} をお気に入りに追加しました`);
  showToast(`ポート ${port} をお気に入りに追加しました`);
  loadFavorites();
});

async function removeFav(id) {
  await window.portManager.removeFavorite(id);
  pushEvent('warn', 'お気に入りを削除しました');
  loadFavorites();
}

async function quickFav(port, processName, protocol = 'TCP') {
  if (getFavoriteForPort(port, protocol)) {
    showToast(`ポート ${port} は登録済みです`);
    return;
  }
  await window.portManager.addFavorite({
    port,
    label: processName || `ポート ${port}`,
    protocol,
  });
  pushEvent('ok', `ポート ${port} をお気に入りに追加しました`);
  showToast(`ポート ${port} をお気に入りに追加しました`);
  await refreshState();
  renderDashboard();
}

async function addMonitorFromFav(port, label, protocol = 'TCP') {
  const existing = getMonitorForPort(port, protocol);
  await window.portManager.addMonitor({ port, label, protocol });
  pushEvent('ok', `ポート ${port} の監視を${existing ? '有効化' : '開始'}しました`);
  showToast(`ポート ${port} の監視を${existing ? '有効化' : '追加'}しました`);
  loadFavorites();
}

// =====================
// Monitor
// =====================

async function loadMonitors() {
  try {
    await refreshState();
    renderMonitors();
    loadSettings();
  } catch (err) {
    monitorTableBody.innerHTML = `<tr><td colspan="6" class="empty-cell">エラー: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderMonitors() {
  if (monitors.length === 0) {
    monitorTableBody.innerHTML = '<tr><td colspan="6" class="empty-cell">監視設定がありません</td></tr>';
    return;
  }

  monitorTableBody.innerHTML = monitors.map((m) => {
    const notifyParts = [];
    if (m.notifyOnOccupied) notifyParts.push('使用開始');
    if (m.notifyOnFreed) notifyParts.push('解放');
    return `
      <tr>
        <td><strong>${escapeHtml(m.label)}</strong></td>
        <td><button class="port-link" onclick="showPortFromSecondary(${toNumber(m.port)})">${escapeHtml(String(m.port))}</button></td>
        <td><span class="state-pill ${m.lastKnownState === 'occupied' ? 'active' : 'muted'}">${m.lastKnownState === 'occupied' ? '使用中' : '空き'}</span></td>
        <td>${escapeHtml(notifyParts.join(' / ') || 'なし')}</td>
        <td><button class="toggle ${m.enabled ? 'on' : ''}" onclick="toggleMonitor(${jsString(m.id)}, ${!m.enabled})"></button></td>
        <td>
          <div class="row-actions">
            <button class="action-btn delete" onclick="removeMonitor(${jsString(m.id)})">削除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

document.getElementById('btn-add-mon').addEventListener('click', async () => {
  const port = parseInt(document.getElementById('mon-port').value, 10);
  const label = document.getElementById('mon-label').value.trim();
  const notifyOnOccupied = document.getElementById('mon-notify-occupied').checked;
  const notifyOnFreed = document.getElementById('mon-notify-freed').checked;

  if (!isValidPort(port)) {
    alert('有効なポート番号（1-65535）を入力してください');
    return;
  }

  await window.portManager.addMonitor({ port, label: label || `ポート ${port}`, notifyOnOccupied, notifyOnFreed });
  document.getElementById('mon-port').value = '';
  document.getElementById('mon-label').value = '';
  pushEvent('ok', `ポート ${port} の監視を開始しました`);
  loadMonitors();
});

async function togglePortMonitor(port, protocol, processName) {
  const mon = getMonitorForPort(port, protocol);
  if (mon) {
    await window.portManager.updateMonitor(mon.id, { enabled: !mon.enabled });
    pushEvent('ok', `ポート ${port} の監視を${mon.enabled ? '停止' : '開始'}しました`);
  } else {
    await window.portManager.addMonitor({ port, protocol, label: processName || `ポート ${port}` });
    pushEvent('ok', `ポート ${port} の監視を開始しました`);
  }
  await refreshState();
  renderDashboard();
}

async function toggleMonitor(id, enabled) {
  await window.portManager.updateMonitor(id, { enabled });
  pushEvent('ok', `監視を${enabled ? '有効' : '無効'}にしました`);
  loadMonitors();
}

async function removeMonitor(id) {
  await window.portManager.removeMonitor(id);
  pushEvent('warn', '監視設定を削除しました');
  loadMonitors();
}

// =====================
// Settings
// =====================

async function loadSettings() {
  settings = await window.portManager.getSettings();
  const interval = document.getElementById('mon-interval');
  if (interval && settings.monitorIntervalMs) {
    interval.value = Math.round(settings.monitorIntervalMs / 1000);
  }
}

document.getElementById('btn-apply-interval').addEventListener('click', async () => {
  const sec = parseInt(document.getElementById('mon-interval').value, 10);
  if (!sec || sec < 1) return;
  await window.portManager.updateSettings({ monitorIntervalMs: sec * 1000 });
  pushEvent('ok', `監視間隔を ${sec} 秒に変更しました`);
  showToast(`監視間隔を ${sec} 秒に変更しました`);
  loadSettings();
});

// =====================
// Actions and events
// =====================

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

filterText.addEventListener('input', renderPorts);
filterProtocol.addEventListener('change', renderPorts);
filterState.addEventListener('change', renderPorts);
portsTableBody.addEventListener('click', async (event) => {
  const row = event.target.closest('tr[data-port-key]');
  if (!row) return;

  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) {
    selectPort(row.dataset.portKey);
    return;
  }

  const action = actionButton.dataset.action;
  if (action === 'select') {
    selectPort(row.dataset.portKey);
    return;
  }
  if (action === 'favorite') {
    await quickFav(toNumber(actionButton.dataset.port), actionButton.dataset.processName, actionButton.dataset.protocol);
    return;
  }
  if (action === 'monitor') {
    await togglePortMonitor(toNumber(actionButton.dataset.port), actionButton.dataset.protocol, actionButton.dataset.processName);
    return;
  }
  if (action === 'kill') {
    await killPort(toNumber(actionButton.dataset.pid));
  }
});
btnRefresh.addEventListener('click', async () => {
  await loadDashboard();
  pushEvent('ok', 'ポート一覧を更新しました');
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    filterText.focus();
  }
});

document.getElementById('btn-clear-events').addEventListener('click', () => {
  eventLog = [];
  renderEvents();
});

async function killPort(pid) {
  if (!pid) {
    alert('PIDが取得できないため停止できません');
    return;
  }
  const result = await window.portManager.killProcess(pid);
  if (result.cancelled) return;
  if (result.success) {
    pushEvent('warn', `PID ${pid} のプロセスを停止しました`);
    await loadDashboard();
  } else {
    alert('プロセスの停止に失敗しました: ' + result.error);
  }
}

function selectPort(key) {
  selectedPortKey = key;
  portsTableBody.querySelectorAll('tr[data-port-key]').forEach((row) => {
    row.classList.toggle('selected', row.dataset.portKey === key);
  });
  renderDetail();
}

function showPortFromSecondary(port) {
  setView('dashboard');
  filterText.value = String(port);
  renderPorts();
}

window.portManager.onStatusChanged((data) => {
  const stateLabelText = data.newState === 'occupied' ? '使用中' : '空き';
  pushEvent(data.newState === 'occupied' ? 'ok' : 'warn', `ポート ${data.port} が${stateLabelText}になりました`);
  if (activeView === 'dashboard') loadDashboard();
  if (activeView === 'monitor') loadMonitors();
});

function pushEvent(type, message) {
  eventLog.unshift({
    type,
    message,
    time: new Date(),
  });
  eventLog = eventLog.slice(0, 12);
  renderEvents();
}

function renderEvents() {
  if (eventLog.length === 0) {
    eventList.innerHTML = '<p class="empty-message">イベントはまだありません</p>';
    return;
  }

  eventList.innerHTML = eventLog.map((event) => `
    <div class="event-item">
      <span class="event-type ${escapeAttr(event.type)}">${event.type === 'warn' ? '!' : '✓'}</span>
      <span class="event-message">${escapeHtml(event.message)}</span>
      <span class="event-time">${formatTime(event.time)}</span>
    </div>
  `).join('');
}

// =====================
// Utilities
// =====================

function getPortKey(port) {
  return `${port.Protocol}:${port.LocalAddress}:${port.LocalPort}:${port.PID}:${port.State}`;
}

function getFavoriteForPort(port, protocol) {
  return favorites.find((f) => Number(f.port) === Number(port) && (f.protocol || 'TCP') === (protocol || 'TCP'));
}

function getMonitorForPort(port, protocol) {
  return monitors.find((m) => Number(m.port) === Number(port) && (m.protocol || 'TCP') === (protocol || 'TCP'));
}

function canStopPort(port) {
  return port.Protocol === 'UDP' || port.State === 'Listen';
}

function stateLabel(port) {
  if (port.Protocol === 'UDP') return '使用中';
  if (port.State === 'Listen') return '使用中';
  if (port.State === 'Established') return '接続済み';
  if (port.State === '--') return '使用中';
  return port.State || '不明';
}

function renderStatePill(port) {
  const active = port.State === 'Listen' || port.Protocol === 'UDP';
  const busy = port.State === 'Established';
  const cls = active ? 'active' : busy ? 'busy' : 'muted';
  return `<span class="state-pill ${cls}">${escapeHtml(stateLabel(port))}</span>`;
}

function formatRemote(port) {
  if (!port.RemoteAddress || port.RemoteAddress === '*') return '-';
  return `${port.RemoteAddress}:${port.RemotePort || ''}`;
}

function getProcessInitial(name) {
  const source = (name || '?').replace(/[<>]/g, '').trim();
  return (source[0] || '?').toUpperCase();
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatTime(date) {
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function jsString(str) {
  return JSON.stringify(String(str || '')).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 260);
  }, 2200);
}

// --- Initial load ---
initSidebarLayout();
updateHistoryButtons();
loadDashboard();
loadSettings();
