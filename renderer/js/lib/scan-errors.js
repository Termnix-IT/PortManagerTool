// ports:scan の errors の解釈（DOMに依存しない）

const SOURCE_LABELS = {
  TCP: 'TCP',
  UDP: 'UDP',
  CommandLine: 'コマンドライン',
};

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

// TCP/UDPの両方が取れなかった場合は「0件」ではなく失敗として扱う
export function isScanUnusable(errors) {
  const sources = new Set(errors.map((e) => e.source));
  return sources.has('TCP') && sources.has('UDP');
}

/**
 * @returns {{ key: string, sources: string, detail: string }}
 *   key: 同じエラーが続いているかの判定用
 */
export function summarizeScanErrors(errors) {
  return {
    key: errors.map((e) => `${e.source}:${e.message}`).join('|'),
    sources: errors.map((e) => sourceLabel(e.source)).join(' / '),
    detail: errors.map((e) => `${sourceLabel(e.source)}: ${e.message}`).join('\n'),
  };
}
