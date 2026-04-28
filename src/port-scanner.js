const { execFile } = require('child_process');

const TCP_COMMAND = `
Get-NetTCPConnection |
Where-Object { $_.State -eq 'Listen' -or $_.State -eq 'Established' } |
ForEach-Object {
  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;
  [PSCustomObject]@{
    Protocol='TCP';
    LocalAddress=$_.LocalAddress;
    LocalPort=$_.LocalPort;
    RemoteAddress=$_.RemoteAddress;
    RemotePort=$_.RemotePort;
    State=$_.State;
    PID=$_.OwningProcess;
    ProcessName=if($proc){$proc.ProcessName}else{'<unknown>'}
  }
} | ConvertTo-Json -Compress
`.trim();

const UDP_COMMAND = `
Get-NetUDPEndpoint |
ForEach-Object {
  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;
  [PSCustomObject]@{
    Protocol='UDP';
    LocalAddress=$_.LocalAddress;
    LocalPort=$_.LocalPort;
    RemoteAddress='*';
    RemotePort=0;
    State='--';
    PID=$_.OwningProcess;
    ProcessName=if($proc){$proc.ProcessName}else{'<unknown>'}
  }
} | ConvertTo-Json -Compress
`.trim();

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', command], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve([]);
          return;
        }
        const parsed = JSON.parse(trimmed);
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (parseErr) {
        reject(new Error(`Failed to parse PowerShell output: ${parseErr.message}`));
      }
    });
  });
}

async function scanPorts() {
  const [tcp, udp] = await Promise.all([
    runPowerShell(TCP_COMMAND).catch(() => []),
    runPowerShell(UDP_COMMAND).catch(() => []),
  ]);
  return [...tcp, ...udp];
}

function normalizeTargets(targets) {
  return targets
    .map((target) => {
      const port = Number(typeof target === 'object' ? target.port : target);
      const protocol = String(typeof target === 'object' ? target.protocol || 'TCP' : 'TCP').toUpperCase();
      return { port, protocol };
    })
    .filter((target) => Number.isInteger(target.port) && target.port >= 1 && target.port <= 65535);
}

function targetKey(protocol, port) {
  return `${protocol}:${Number(port)}`;
}

function uniquePorts(targets, protocol) {
  return [...new Set(targets.filter((target) => target.protocol === protocol).map((target) => target.port))];
}

async function checkTcpPorts(ports) {
  if (ports.length === 0) return [];
  const portList = ports.join(',');
  const command = `
Get-NetTCPConnection -LocalPort ${portList} -ErrorAction SilentlyContinue |
Where-Object { $_.State -eq 'Listen' } |
ForEach-Object {
  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;
  [PSCustomObject]@{
    Protocol='TCP';
    LocalPort=$_.LocalPort;
    PID=$_.OwningProcess;
    ProcessName=if($proc){$proc.ProcessName}else{'<unknown>'}
  }
} | ConvertTo-Json -Compress
  `.trim();
  return runPowerShell(command).catch(() => []);
}

async function checkUdpPorts(ports) {
  if (ports.length === 0) return [];
  const portList = ports.join(',');
  const command = `
Get-NetUDPEndpoint -LocalPort ${portList} -ErrorAction SilentlyContinue |
ForEach-Object {
  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;
  [PSCustomObject]@{
    Protocol='UDP';
    LocalPort=$_.LocalPort;
    PID=$_.OwningProcess;
    ProcessName=if($proc){$proc.ProcessName}else{'<unknown>'}
  }
} | ConvertTo-Json -Compress
  `.trim();
  return runPowerShell(command).catch(() => []);
}

/**
 * Check if specific ports are occupied (used by monitor)
 * Accepts numbers for TCP checks or { port, protocol } targets.
 * Returns a Map of "PROTOCOL:port" -> { occupied, processName, pid }.
 */
async function checkPorts(targets) {
  const normalizedTargets = normalizeTargets(targets);
  if (normalizedTargets.length === 0) return new Map();

  const portMap = new Map();
  for (const target of normalizedTargets) {
    portMap.set(targetKey(target.protocol, target.port), { occupied: false, processName: '', pid: 0 });
  }

  const [tcpResults, udpResults] = await Promise.all([
    checkTcpPorts(uniquePorts(normalizedTargets, 'TCP')),
    checkUdpPorts(uniquePorts(normalizedTargets, 'UDP')),
  ]);

  for (const r of [...tcpResults, ...udpResults]) {
    const key = targetKey(r.Protocol, r.LocalPort);
    portMap.set(key, {
      occupied: true,
      processName: r.ProcessName,
      pid: r.PID,
    });
    if (r.Protocol === 'TCP') {
      portMap.set(r.LocalPort, portMap.get(key));
    }
  }

  return portMap;
}

module.exports = { scanPorts, checkPorts };
