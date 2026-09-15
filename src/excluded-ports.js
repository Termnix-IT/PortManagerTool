const { execFile } = require('child_process');

// Hyper-V / WSL / Docker 等が予約しているTCPポート範囲。
// この範囲のポートは使用中のプロセスが無くても bind できない（EACCES 等）。
// netsh の見出しはロケール依存だが、範囲の行は「数値 数値 [*]」のため数値行だけを読む。

const CACHE_TTL_MS = 60 * 1000;
const FAMILIES = ['ipv4', 'ipv6'];

/**
 * @returns {{ start: number, end: number, managed: boolean }[]}
 */
function parseExcludedPortRanges(output) {
  const ranges = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d{1,5})\s+(\d{1,5})\s*(\*)?\s*$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start < 1 || end > 65535 || start > end) continue;
    ranges.push({ start, end, managed: Boolean(match[3]) });
  }
  return ranges;
}

// IPv4/IPv6 の結果は多くの場合同じなので、同一範囲をまとめる
function mergeRanges(lists) {
  const byKey = new Map();
  for (const range of lists.flat()) {
    const key = `${range.start}-${range.end}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? { ...existing, managed: existing.managed || range.managed } : range);
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start);
}

function runNetsh(family) {
  return new Promise((resolve, reject) => {
    execFile(
      'netsh',
      ['interface', family, 'show', 'excludedportrange', 'protocol=tcp'],
      { windowsHide: true, timeout: 10000, encoding: 'latin1' },
      (err, stdout) => {
        if (err) {
          reject(new Error(`予約ポート範囲を取得できませんでした（${family}）: ${err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function createExcludedPortsProvider({ run = runNetsh, now = Date.now, ttlMs = CACHE_TTL_MS } = {}) {
  let cache = null;

  async function getExcludedPortRanges() {
    if (cache && now() - cache.at < ttlMs) return cache.ranges;
    const outputs = await Promise.all(FAMILIES.map((family) => run(family)));
    const ranges = mergeRanges(outputs.map(parseExcludedPortRanges));
    cache = { at: now(), ranges };
    return ranges;
  }

  return { getExcludedPortRanges };
}

module.exports = { parseExcludedPortRanges, mergeRanges, createExcludedPortsProvider };
