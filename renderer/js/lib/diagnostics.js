// ポート競合の診断（DOMに依存しない）

const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::']);

function addressFamily(address) {
  return String(address).includes(':') ? 'IPv6' : 'IPv4';
}

function isWildcard(address) {
  return WILDCARD_ADDRESSES.has(address);
}

function groupByProcess(rows) {
  const byPid = new Map();
  for (const row of rows) {
    const pid = Number(row.PID);
    if (!byPid.has(pid)) {
      byPid.set(pid, { pid, processName: row.ProcessName || '<unknown>', category: row.Category || '', addresses: [] });
    }
    const entry = byPid.get(pid);
    if (!entry.addresses.includes(row.LocalAddress)) entry.addresses.push(row.LocalAddress);
  }
  return [...byPid.values()];
}

/**
 * 同じポートを待ち受けている複数プロセスの関係を分類する。
 * - split-stack: IPv4 と IPv6 で別のプロセス。"localhost" の解決先（::1 / 127.0.0.1）で接続先が変わる
 * - shadowed: 同じアドレスファミリーでワイルドカードと特定アドレスが混在。特定アドレス側が優先される
 * - multiple: 上記以外（同じアドレスを共有している等）
 */
function classifyConflict(processes) {
  const families = processes.map((p) => new Set(p.addresses.map(addressFamily)));
  const disjointFamilies = families.every((set, i) => families.every((other, j) => i === j || [...set].every((f) => !other.has(f))));
  if (disjointFamilies) return 'split-stack';

  const hasWildcard = processes.some((p) => p.addresses.some(isWildcard));
  const hasSpecific = processes.some((p) => p.addresses.some((a) => !isWildcard(a)));
  if (hasWildcard && hasSpecific) return 'shadowed';
  return 'multiple';
}

const CONFLICT_TEXT = {
  'split-stack': {
    title: 'IPv4 と IPv6 で別のプロセスが待ち受けています',
    hint: '"localhost" が ::1 と 127.0.0.1 のどちらに解決されるかで接続先が変わります（Node.js 17 以降は ::1 が優先されやすい）。',
  },
  shadowed: {
    title: 'ワイルドカードと特定アドレスで別のプロセスが待ち受けています',
    hint: '特定のアドレス（127.0.0.1 等）で待ち受けているプロセスに接続が優先され、もう一方には届かないことがあります。',
  },
  multiple: {
    title: '複数のプロセスが同じポートで待ち受けています',
    hint: 'どちらのプロセスが応答するかは保証されません。不要なプロセスを停止してください。',
  },
};

/**
 * TCP の待受で、同じポートを別々のプロセスが使っているものを返す。
 * 同じプロセスが IPv4/IPv6 の両方で待ち受けるのは通常の動作のため競合としない。
 * UDP はマルチキャスト等で複数プロセスの共有が一般的なため対象外。
 */
export function diagnoseConflicts(ports) {
  const byPort = new Map();
  for (const row of ports) {
    if (row.Protocol !== 'TCP' || row.State !== 'Listen') continue;
    const port = Number(row.LocalPort);
    if (!byPort.has(port)) byPort.set(port, []);
    byPort.get(port).push(row);
  }

  const conflicts = [];
  for (const [port, rows] of byPort) {
    const processes = groupByProcess(rows);
    if (processes.length < 2) continue;
    const kind = classifyConflict(processes);
    conflicts.push({ protocol: 'TCP', port, kind, processes, ...CONFLICT_TEXT[kind] });
  }
  return conflicts.sort((a, b) => a.port - b.port);
}

export function findExcludedRange(port, ranges) {
  return ranges.find((range) => port >= range.start && port <= range.end) || null;
}

/**
 * 指定ポートが使えるかを判定する。
 * @returns {{ status: 'free'|'in-use'|'reserved', processes: object[], range: object|null, reasons: string[] }}
 */
export function checkPortAvailability({ port, protocol = 'TCP', ports, excludedRanges }) {
  const reasons = [];
  const active = ports.filter((row) => Number(row.LocalPort) === port
    && row.Protocol === protocol
    && (protocol === 'UDP' || row.State === 'Listen'));
  const processes = groupByProcess(active);
  // 予約範囲は netsh の TCP の結果のみ取得している
  const range = protocol === 'TCP' ? findExcludedRange(port, excludedRanges) : null;

  if (processes.length > 0) {
    reasons.push(`${processes.map((p) => `${p.processName}（PID ${p.pid}）`).join('、')} が使用中です`);
  }
  if (range) {
    const span = range.start === range.end ? `${range.start}` : `${range.start}〜${range.end}`;
    reasons.push(`Windows の予約ポート範囲（${span}）に含まれるため、使用中のプロセスが無くても使えません。Hyper-V / WSL / Docker が予約していることが多く、再起動で範囲が変わる場合があります`);
  }
  if (port < 1024 && processes.length === 0 && !range) {
    reasons.push('1024 未満のポートは他のアプリやサービスが起動時に使うことがあります');
  }

  let status = 'free';
  if (range) status = 'reserved';
  if (processes.length > 0) status = 'in-use';
  return { status, processes, range, reasons };
}
