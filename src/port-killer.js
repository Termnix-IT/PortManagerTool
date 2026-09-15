const { execFile } = require('child_process');
const { runPowerShell } = require('./powershell');

// 停止直前の再検証と危険度判定に必要な情報を1回のPowerShell実行でまとめて取得する
function buildInspectScript(pid) {
  return `
function Get-OrEmpty([scriptblock]$Block) {
  try { @(& $Block) } catch {
    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { @() } else { throw }
  }
}
$targetPid = ${pid}
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
  [PSCustomObject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; Name=$_.Name }
})
$target = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid"
$owner = $null
if ($target) {
  $ownerResult = Invoke-CimMethod -InputObject $target -MethodName GetOwner
  if ($ownerResult.ReturnValue -eq 0 -and $ownerResult.User) { $owner = "$($ownerResult.Domain)\\$($ownerResult.User)" }
}
$tcpPorts = @(Get-OrEmpty { Get-NetTCPConnection -OwningProcess $targetPid -State Listen } | ForEach-Object { [int]$_.LocalPort })
$udpPorts = @(Get-OrEmpty { Get-NetUDPEndpoint -OwningProcess $targetPid } | ForEach-Object { [int]$_.LocalPort })
[PSCustomObject]@{
  Processes = $processes
  Target = if ($target) { [PSCustomObject]@{
    ProcessId = $target.ProcessId
    Name = $target.Name
    CommandLine = $target.CommandLine
    ExecutablePath = $target.ExecutablePath
    SessionId = $target.SessionId
  } } else { $null }
  Owner = $owner
  TcpPorts = $tcpPorts
  UdpPorts = $udpPorts
} | ConvertTo-Json -Compress -Depth 4
`.trim();
}

// taskkill の出力はコンソールのコードページ（日本語環境ではShift_JIS）で出る
function decodeOutput(buffer) {
  if (!buffer || buffer.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).trim();
  } catch {
    return new TextDecoder('shift_jis').decode(buffer).trim();
  }
}

function execTaskkill(args) {
  return new Promise((resolve) => {
    execFile('taskkill', args, { encoding: 'buffer', windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        message: decodeOutput(err ? stderr : stdout) || (err ? err.message : ''),
      });
    });
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM は「存在するが権限がない」
    return err.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toNumberArray(value) {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(Number).filter(Number.isInteger);
}

function createProcessKiller({ run = runPowerShell, taskkill = execTaskkill, isAlive = isProcessAlive, wait = sleep } = {}) {
  async function inspectProcess(pid) {
    const [info] = await run(buildInspectScript(pid));
    if (!info) throw new Error('プロセス情報を取得できませんでした');
    return {
      processes: Array.isArray(info.Processes) ? info.Processes : info.Processes ? [info.Processes] : [],
      target: info.Target || null,
      owner: info.Owner || null,
      tcpPorts: toNumberArray(info.TcpPorts),
      udpPorts: toNumberArray(info.UdpPorts),
    };
  }

  /**
   * @param {number} pid
   * @param {{ force: boolean, tree: boolean }} options
   * @returns {Promise<{ exitCode: number, message: string }>}
   */
  function stopProcess(pid, { force, tree }) {
    const args = ['/PID', String(pid)];
    if (tree) args.push('/T');
    if (force) args.push('/F');
    return taskkill(args);
  }

  async function waitForExit(pid, { timeoutMs = 5000, intervalMs = 250 } = {}) {
    const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    for (let i = 0; i < attempts; i += 1) {
      if (!isAlive(pid)) return true;
      await wait(intervalMs);
    }
    return !isAlive(pid);
  }

  return { inspectProcess, stopProcess, waitForExit };
}

module.exports = { createProcessKiller, decodeOutput, buildInspectScript };
