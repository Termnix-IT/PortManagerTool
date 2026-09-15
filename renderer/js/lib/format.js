// 表示用の文字列処理（DOMに依存しない）

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// テンプレート文字列でHTMLを組み立てるため、本文・属性のどちらに埋め込んでも安全な形にする
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function formatTime(date) {
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function getProcessInitial(name) {
  const source = String(name || '?').replace(/[<>]/g, '').trim();
  return (source[0] || '?').toUpperCase();
}

// ipcRenderer.invoke の reject は "Error invoking remote method 'x': ValidationError: 本文" の形になる
export function cleanIpcErrorMessage(raw) {
  return String(raw ?? '').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}
