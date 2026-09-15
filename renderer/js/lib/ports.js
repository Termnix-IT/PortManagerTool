// ポート一覧の絞り込み・並べ替え・表示判定（DOMに依存しない）

export const CATEGORY_FILTERS = ['ALL', 'dev', 'db'];

export function getPortKey(port) {
  return `${port.Protocol}:${port.LocalAddress}:${port.LocalPort}:${port.PID}:${port.State}`;
}

export function isActivePort(port) {
  return port.State === 'Listen' || port.Protocol === 'UDP';
}

// TCPのEstablishedはクライアント側の接続のため、誤停止を防ぐ目的で停止対象にしない
export function canStopPort(port) {
  return isActivePort(port);
}

export function stateLabel(port) {
  if (port.Protocol === 'UDP') return '使用中';
  if (port.State === 'Listen') return '使用中';
  if (port.State === 'Established') return '接続済み';
  if (port.State === '--') return '使用中';
  return port.State || '不明';
}

export function stateClass(port) {
  if (isActivePort(port)) return 'active';
  if (port.State === 'Established') return 'busy';
  return 'muted';
}

export function formatRemote(port) {
  if (!port.RemoteAddress || port.RemoteAddress === '*') return '-';
  return `${port.RemoteAddress}:${port.RemotePort || ''}`;
}

export function categoryName(category) {
  return category === 'db' ? 'DBプロセス' : '開発プロセス';
}

export function emptyMessageForCategory(category) {
  if (category === 'dev') return '開発プロセスのポートは見つかりませんでした';
  if (category === 'db') return 'DBプロセスのポートは見つかりませんでした';
  return '該当するポートがありません';
}

/**
 * @param {object[]} ports
 * @param {{ category: string, protocol: string, state: string, text: string }} filters
 */
export function filterPorts(ports, { category = 'ALL', protocol = 'ALL', state = 'ALL', text = '' } = {}) {
  const query = text.trim().toLowerCase();
  return ports.filter((p) => {
    if (category !== 'ALL' && p.Category !== category) return false;
    if (protocol !== 'ALL' && p.Protocol !== protocol) return false;
    if (state !== 'ALL' && p.State !== state) return false;
    if (query) {
      const haystack = [
        p.LocalPort, p.Protocol, p.ProcessName, p.PID, p.LocalAddress, p.RemoteAddress, p.CategoryLabel, p.CommandLine,
      ].map((value) => value ?? '').join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function sortPorts(ports, key, ascending) {
  const direction = ascending ? 1 : -1;
  return [...ports].sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return -direction;
    if (va > vb) return direction;
    return 0;
  });
}

export function countCategories(ports) {
  return {
    ALL: ports.length,
    dev: ports.filter((p) => p.Category === 'dev').length,
    db: ports.filter((p) => p.Category === 'db').length,
  };
}

// favorites / monitors の登録は port + protocol で一意
export function findEntryForPort(entries, port, protocol) {
  return entries.find((entry) => Number(entry.port) === Number(port) && (entry.protocol || 'TCP') === (protocol || 'TCP'));
}

export function isPortOccupied(ports, port, protocol) {
  return ports.some((p) => Number(p.LocalPort) === Number(port) && p.Protocol === (protocol || 'TCP') && isActivePort(p));
}

export function calculateMetrics({ ports, monitors, favorites }) {
  const portCounts = new Map();
  for (const p of ports) {
    const key = `${p.Protocol}:${p.LocalPort}`;
    portCounts.set(key, (portCounts.get(key) || 0) + 1);
  }
  return {
    active: ports.filter(isActivePort).length,
    monitoring: monitors.filter((m) => m.enabled).length,
    conflicts: [...portCounts.values()].filter((count) => count > 1).length,
    favorites: favorites.length,
  };
}
