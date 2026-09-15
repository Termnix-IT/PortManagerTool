const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15000;

class PowerShellError extends Error {
  constructor(message, { cause, timedOut = false } = {}) {
    super(message);
    this.name = 'PowerShellError';
    this.cause = cause;
    this.timedOut = timedOut;
  }
}

/**
 * エラー処理を統一するためのラッパー。
 * - 出力をUTF-8に固定（日本語パスを含むコマンドラインの文字化け対策）
 * - 失敗は exit 1 + stderr で返す
 * - `-LocalPort` 指定で該当なしの場合（CmdletizationQuery_NotFound）は失敗ではなく0件として扱う
 */
function wrapScript(body) {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
${body}
} catch {
  if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { exit 0 }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`.trim();
}

/**
 * ConvertTo-Json の出力を常に配列にして返す。空出力は0件。
 */
function parseJsonOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new PowerShellError(`PowerShellの出力を解析できませんでした: ${err.message}`, { cause: err });
  }
  if (parsed === null) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function runPowerShell(body, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', wrapScript(body)],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            reject(new PowerShellError(`PowerShellがタイムアウトしました（${timeout / 1000}秒）`, { cause: err, timedOut: true }));
            return;
          }
          const detail = String(stderr || '').trim() || err.message;
          reject(new PowerShellError(detail, { cause: err }));
          return;
        }
        try {
          resolve(parseJsonOutput(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

module.exports = { runPowerShell, parseJsonOutput, wrapScript, PowerShellError };
