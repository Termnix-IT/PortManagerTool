const { runPowerShell } = require('./powershell');
const { classify } = require('./port-classifier');
const { createExcludedPortsProvider } = require('./excluded-ports');

// 接続ごとに Get-Process を呼ぶと遅い（実測 2〜3秒）ため、先に PID → プロセス情報の表を作る（約1.2秒）
const PROCESS_TABLE = `
$procs = @{}
Get-Process | ForEach-Object {
  $start = $null
  try { $start = $_.StartTime.ToUniversalTime().ToString('o') } catch {}
  $procs[[int]$_.Id] = @{ Name = $_.ProcessName; Start = $start }
}
function Get-ProcName($id) { $p = $procs[[int]$id]; if ($p) { $p.Name } else { '<unknown>' } }
function Get-ProcStart($id) { $p = $procs[[int]$id]; if ($p) { $p.Start } else { $null } }
`.trim();

const TCP_COMMAND = `
${PROCESS_TABLE}
Get-NetTCPConnection |
Where-Object { $_.State -eq 'Listen' -or $_.State -eq 'Established' } |
ForEach-Object {
  [PSCustomObject]@{
    Protocol='TCP';
    LocalAddress=$_.LocalAddress;
    LocalPort=$_.LocalPort;
    RemoteAddress=$_.RemoteAddress;
    RemotePort=$_.RemotePort;
    State=[string]$_.State;
    PID=$_.OwningProcess;
    ProcessName=Get-ProcName $_.OwningProcess
  }
} | ConvertTo-Json -Compress
`.trim();

const UDP_COMMAND = `
${PROCESS_TABLE}
Get-NetUDPEndpoint |
ForEach-Object {
  [PSCustomObject]@{
    Protocol='UDP';
    LocalAddress=$_.LocalAddress;
    LocalPort=$_.LocalPort;
    RemoteAddress='*';
    RemotePort=0;
    State='--';
    PID=$_.OwningProcess;
    ProcessName=Get-ProcName $_.OwningProcess
  }
} | ConvertTo-Json -Compress
`.trim();

// 履歴用。TCPの待受のみ、プロセス開始時刻付き（PID再利用の区別と「いつから使っているか」の表示に使う）
const TCP_LISTENERS_COMMAND = `
${PROCESS_TABLE}
Get-NetTCPConnection -State Listen |
ForEach-Object {
  [PSCustomObject]@{
    LocalAddress=$_.LocalAddress;
    LocalPort=$_.LocalPort;
    PID=$_.OwningProcess;
    ProcessName=Get-ProcName $_.OwningProcess;
    ProcessStartedAt=Get-ProcStart $_.OwningProcess
  }
} | ConvertTo-Json -Compress
`.trim();

// -LocalPort に複数指定すると、1つでも該当なしがあると全体が失敗扱いになり
// 見つかった分まで失われる。そのため取得後に Where-Object で絞り込む。
function buildTcpCheckCommand(ports) {
  return `
$targets = @(${ports.join(',')})
${PROCESS_TABLE}
Get-NetTCPConnection -State Listen |
Where-Object { $targets -contains $_.LocalPort } |
ForEach-Object {
  [PSCustomObject]@{
    Protocol='TCP';
    LocalPort=$_.LocalPort;
    PID=$_.OwningProcess;
    ProcessName=Get-ProcName $_.OwningProcess
  }
} | ConvertTo-Json -Compress
`.trim();
}

function buildUdpCheckCommand(ports) {
  return `
$targets = @(${ports.join(',')})
${PROCESS_TABLE}
Get-NetUDPEndpoint |
Where-Object { $targets -contains $_.LocalPort } |
ForEach-Object {
  [PSCustomObject]@{
    Protocol='UDP';
    LocalPort=$_.LocalPort;
    PID=$_.OwningProcess;
    ProcessName=Get-ProcName $_.OwningProcess
  }
} | ConvertTo-Json -Compress
`.trim();
}

function buildCommandLineQuery(pids) {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
  return `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;
}

// PowerShellのスクリプトへ埋め込むため、整数として妥当な値だけを通す
function normalizeTargets(targets) {
  return (Array.isArray(targets) ? targets : [])
    .map((target) => {
      const isObject = target !== null && typeof target === 'object';
      const port = Number(isObject ? target.port : target);
      const protocol = String(isObject ? target.protocol || 'TCP' : 'TCP').toUpperCase();
      return { port, protocol };
    })
    .filter((target) => Number.isInteger(target.port) && target.port >= 1 && target.port <= 65535)
    .filter((target) => target.protocol === 'TCP' || target.protocol === 'UDP');
}

function targetKey(protocol, port) {
  return `${protocol}:${Number(port)}`;
}

function uniquePorts(targets, protocol) {
  return [...new Set(targets.filter((target) => target.protocol === protocol).map((target) => target.port))];
}

function toErrorEntry(source, err) {
  return { source, message: err && err.message ? err.message : String(err) };
}

function createScanner({
  run = runPowerShell,
  getExcludedPortRanges = createExcludedPortsProvider().getExcludedPortRanges,
} = {}) {
  async function getCommandLines(pids) {
    const uniquePids = [...new Set(pids.map(Number))].filter((pid) => Number.isInteger(pid) && pid > 0);
    if (uniquePids.length === 0) return new Map();
    const rows = await run(buildCommandLineQuery(uniquePids));
    return new Map(rows.map((row) => [Number(row.ProcessId), row.CommandLine || '']));
  }

  /**
   * 全ポートをスキャンする。
   * TCP/UDP/コマンドライン/予約範囲の取得は個別に失敗しうるため、取得できた分を返し、
   * 失敗した分を errors に入れる（失敗を0件として扱わない）。
   * @returns {Promise<{ ports: object[], excludedRanges: object[], errors: { source: string, message: string }[] }>}
   */
  async function scanPorts() {
    const errors = [];
    const [tcp, udp, excludedRanges] = await Promise.all([
      run(TCP_COMMAND).catch((err) => { errors.push(toErrorEntry('TCP', err)); return []; }),
      run(UDP_COMMAND).catch((err) => { errors.push(toErrorEntry('UDP', err)); return []; }),
      getExcludedPortRanges().catch((err) => { errors.push(toErrorEntry('ExcludedRanges', err)); return []; }),
    ]);
    const ports = [...tcp, ...udp];

    for (const port of ports) {
      const result = classify(port);
      port.Category = result ? result.category : '';
      port.CategoryLabel = result ? result.label : '';
    }

    // コマンドライン取得は重いため、開発/DBに分類されたプロセスだけに絞る
    let commandLines = new Map();
    try {
      commandLines = await getCommandLines(ports.filter((p) => p.Category).map((p) => p.PID));
    } catch (err) {
      errors.push(toErrorEntry('CommandLine', err));
    }
    for (const port of ports) {
      port.CommandLine = commandLines.get(Number(port.PID)) || '';
    }

    return { ports, excludedRanges, errors };
  }

  /**
   * TCPの待受一覧（履歴用）。取得失敗時は例外を投げる（全ポート解放と誤認しないため）。
   * @returns {Promise<{ port: number, pid: number, processName: string, processStartedAt: string|null, localAddress: string, category: string, categoryLabel: string }[]>}
   */
  async function scanTcpListeners() {
    const rows = await run(TCP_LISTENERS_COMMAND);
    return rows.map((row) => {
      const result = classify({ Protocol: 'TCP', State: 'Listen', LocalPort: row.LocalPort, ProcessName: row.ProcessName });
      return {
        port: Number(row.LocalPort),
        pid: Number(row.PID),
        processName: row.ProcessName || '<unknown>',
        processStartedAt: row.ProcessStartedAt || null,
        localAddress: row.LocalAddress || '',
        category: result ? result.category : '',
        categoryLabel: result ? result.label : '',
      };
    });
  }

  /**
   * 指定ポートの使用状況を確認する（監視用）。
   * 取得に失敗した場合は例外を投げる。空き扱いにすると誤った「解放」通知になるため。
   * @returns {Promise<Map<string, { occupied: boolean, processName: string, pid: number }>>}
   */
  async function checkPorts(targets) {
    const normalizedTargets = normalizeTargets(targets);
    const portMap = new Map();
    if (normalizedTargets.length === 0) return portMap;

    for (const target of normalizedTargets) {
      portMap.set(targetKey(target.protocol, target.port), { occupied: false, processName: '', pid: 0 });
    }

    const tcpPorts = uniquePorts(normalizedTargets, 'TCP');
    const udpPorts = uniquePorts(normalizedTargets, 'UDP');
    const [tcpResults, udpResults] = await Promise.all([
      tcpPorts.length > 0 ? run(buildTcpCheckCommand(tcpPorts)) : [],
      udpPorts.length > 0 ? run(buildUdpCheckCommand(udpPorts)) : [],
    ]);

    for (const r of [...tcpResults, ...udpResults]) {
      portMap.set(targetKey(r.Protocol, r.LocalPort), {
        occupied: true,
        processName: r.ProcessName,
        pid: r.PID,
      });
    }

    return portMap;
  }

  return { scanPorts, scanTcpListeners, checkPorts, getCommandLines };
}

const defaultScanner = createScanner();

module.exports = {
  createScanner,
  normalizeTargets,
  scanPorts: defaultScanner.scanPorts,
  scanTcpListeners: defaultScanner.scanTcpListeners,
  checkPorts: defaultScanner.checkPorts,
  getCommandLines: defaultScanner.getCommandLines,
};
