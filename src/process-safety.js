// プロセス停止前の安全判定（純粋関数のみ。システムコマンドは実行しない）

// 停止するとOSが不安定になる・ログオフ/ブルースクリーンに直結するもの
const BLOCKED_PROCESSES = new Set([
  'system',
  'idle',
  'registry',
  'secure system',
  'memory compression',
  'smss',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'lsaiso',
  'fontdrvhost',
  'msmpeng',
]);

// 停止は可能だが、デスクトップや他機能に影響が出るもの
const DANGEROUS_PROCESSES = new Set([
  'svchost',
  'explorer',
  'dwm',
  'spoolsv',
  'sihost',
  'taskhostw',
  'ctfmon',
  'searchhost',
  'startmenuexperiencehost',
  'runtimebroker',
]);

const RISK_ORDER = { normal: 0, caution: 1, danger: 2, blocked: 3 };

function normalizeProcessName(name) {
  return String(name || '').trim().toLowerCase().replace(/\.exe$/, '');
}

function buildChildrenIndex(processes) {
  const index = new Map();
  for (const proc of processes) {
    const parent = Number(proc.ParentProcessId);
    if (!index.has(parent)) index.set(parent, []);
    index.get(parent).push(proc);
  }
  return index;
}

/**
 * 子孫プロセスを列挙する（taskkill /T の対象に相当）。
 * PIDの再利用で親子関係がループしていても停止するよう、訪問済みを記録する。
 */
function collectDescendants(processes, rootPid) {
  const index = buildChildrenIndex(processes);
  const result = [];
  const visited = new Set([Number(rootPid)]);
  const queue = [Number(rootPid)];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of index.get(current) || []) {
      const childPid = Number(child.ProcessId);
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      result.push(child);
      queue.push(childPid);
    }
  }
  return result;
}

function collectAncestorPids(processes, pid) {
  const byPid = new Map(processes.map((p) => [Number(p.ProcessId), p]));
  const result = [];
  const visited = new Set([Number(pid)]);
  let current = byPid.get(Number(pid));
  while (current) {
    const parentPid = Number(current.ParentProcessId);
    if (!parentPid || visited.has(parentPid)) break;
    visited.add(parentPid);
    const parent = byPid.get(parentPid);
    if (!parent) break;
    result.push(parentPid);
    current = parent;
  }
  return result;
}

function sameUser(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

/**
 * @param {object} input
 * @param {number} input.pid
 * @param {{ Name: string, SessionId: number } | null} input.target  Win32_Processの対象行
 * @param {string | null} input.owner  "DOMAIN\\user"。取得できなければ null
 * @param {string} input.currentUser  "DOMAIN\\user"
 * @param {object[]} input.processes  全プロセス（ProcessId, ParentProcessId, Name）
 * @param {number} input.selfPid  このアプリのmainプロセスPID
 * @param {boolean} [input.includeTree]  子プロセスも停止対象にするか
 * @returns {{ level: 'normal'|'caution'|'danger'|'blocked', reasons: string[], descendants: object[], childProcesses: object[] }}
 */
function assessStopRisk({ pid, target, owner, currentUser, processes, selfPid, includeTree = false }) {
  let level = 'normal';
  const findings = [];
  const raise = (next, reason) => {
    if (RISK_ORDER[next] > RISK_ORDER[level]) level = next;
    findings.push({ level: next, reason });
  };

  const descendants = collectDescendants(processes, pid);

  if (pid === 0 || pid === 4) {
    raise('blocked', 'Windowsのシステムプロセスです');
  }

  const name = normalizeProcessName(target && target.Name);
  if (BLOCKED_PROCESSES.has(name)) {
    raise('blocked', `${target.Name} はOSの重要なプロセスです。停止するとWindowsが不安定になります`);
  } else if (DANGEROUS_PROCESSES.has(name)) {
    raise('danger', `${target.Name} はWindowsの機能を担うプロセスです。停止すると他の機能に影響する可能性があります`);
  }

  const selfTree = new Set([Number(selfPid), ...collectDescendants(processes, selfPid).map((p) => Number(p.ProcessId))]);
  if (selfTree.has(Number(pid))) {
    raise('blocked', 'このアプリ自身のプロセスです');
  } else if (includeTree && descendants.some((p) => selfTree.has(Number(p.ProcessId)))) {
    raise('blocked', '子プロセスにこのアプリ自身が含まれています');
  } else if (collectAncestorPids(processes, selfPid).includes(Number(pid))) {
    raise('danger', 'このアプリの親プロセスです。停止するとアプリも終了する可能性があります');
  }

  if (target && Number(target.SessionId) === 0) {
    raise('danger', 'Windowsサービスとして動作しています。サービスの管理画面から停止することを推奨します');
  }

  if (!owner) {
    raise('caution', '実行ユーザーを取得できませんでした（管理者権限のプロセスの可能性があります）');
  } else if (currentUser && !sameUser(owner, currentUser)) {
    raise('danger', `別のユーザー（${owner}）のプロセスです`);
  }

  const childProcesses = meaningfulChildren(descendants);
  if (childProcesses.length > 0 && !includeTree) {
    raise('caution', `子プロセスが${childProcesses.length}件あります。親だけを停止すると子プロセスがポートを使い続けることがあります`);
  }

  // 重大な理由から順に表示する（sortは安定なので同じ重大度内は検出順）
  const reasons = findings
    .sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level])
    .map((finding) => finding.reason);

  return { level, reasons, descendants, childProcesses };
}

// コンソールアプリには必ず conhost が付くため、利用者に見せる子プロセスからは除く
function meaningfulChildren(descendants) {
  return descendants.filter((p) => normalizeProcessName(p.Name) !== 'conhost');
}

/**
 * 画面で表示していたプロセスと、停止直前に取得したプロセスが同じかを確認する。
 * 表示から停止までの間にプロセスが終了し、PIDが別のプロセスに再利用されている場合に誤停止を防ぐ。
 */
function verifyExpectedProcess({ expected, target, tcpPorts, udpPorts }) {
  if (!target) {
    return { ok: false, reason: 'プロセスは既に終了しています' };
  }
  if (expected.processName && normalizeProcessName(expected.processName) !== normalizeProcessName(target.Name)) {
    return {
      ok: false,
      reason: `PIDが別のプロセス（${target.Name}）に変わっています`,
    };
  }
  if (expected.port) {
    const ports = expected.protocol === 'UDP' ? udpPorts : tcpPorts;
    if (!ports.map(Number).includes(Number(expected.port))) {
      return {
        ok: false,
        reason: `このプロセスはポート ${expected.port}/${expected.protocol || 'TCP'} を使用していません`,
      };
    }
  }
  return { ok: true, reason: '' };
}

module.exports = {
  normalizeProcessName,
  collectDescendants,
  collectAncestorPids,
  assessStopRisk,
  verifyExpectedProcess,
};
