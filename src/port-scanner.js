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

/**
 * Check if specific ports are occupied (used by monitor)
 * Returns a Map of port -> { occupied, processName, pid }
 */
async function checkPorts(ports) {
  if (ports.length === 0) return new Map();

  const portList = ports.join(',');
  const command = `
Get-NetTCPConnection -LocalPort ${portList} -ErrorAction SilentlyContinue |
Where-Object { $_.State -eq 'Listen' } |
ForEach-Object {
  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;
  [PSCustomObject]@{
    LocalPort=$_.LocalPort;
    PID=$_.OwningProcess;
    ProcessName=if($proc){$proc.ProcessName}else{'<unknown>'}
  }
} | ConvertTo-Json -Compress
  `.trim();

  const results = await runPowerShell(command).catch(() => []);
  const portMap = new Map();

  for (const port of ports) {
    portMap.set(port, { occupied: false, processName: '', pid: 0 });
  }
  for (const r of results) {
    portMap.set(r.LocalPort, {
      occupied: true,
      processName: r.ProcessName,
      pid: r.PID,
    });
  }
  return portMap;
}

module.exports = { scanPorts, checkPorts };
