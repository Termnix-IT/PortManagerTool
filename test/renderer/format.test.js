const test = require('node:test');
const assert = require('node:assert/strict');

let format;
let chart;
let scanErrors;
test.before(async () => {
  format = await import('../../renderer/js/lib/format.js');
  chart = await import('../../renderer/js/lib/chart.js');
  scanErrors = await import('../../renderer/js/lib/scan-errors.js');
});

test('escapeHtml: 本文と属性のどちらに埋め込んでも安全にする', () => {
  assert.equal(format.escapeHtml(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(format.escapeHtml(null), '');
  assert.equal(format.escapeHtml(undefined), '');
  assert.equal(format.escapeHtml(0), '0');
  assert.equal(format.escapeHtml(5173), '5173');
});

test('toNumber / isValidPort', () => {
  assert.equal(format.toNumber('42'), 42);
  assert.equal(format.toNumber('abc'), 0);
  assert.equal(format.isValidPort(65535), true);
  assert.equal(format.isValidPort(0), false);
  assert.equal(format.isValidPort(NaN), false);
});

test('getProcessInitial', () => {
  assert.equal(format.getProcessInitial('node'), 'N');
  assert.equal(format.getProcessInitial('<unknown>'), 'U');
  assert.equal(format.getProcessInitial(''), '?');
});

test('cleanIpcErrorMessage: invoke の reject から本文だけを取り出す', () => {
  assert.equal(
    format.cleanIpcErrorMessage("Error invoking remote method 'favorites:add': ValidationError: ポート番号は1〜65535の整数で指定してください"),
    'ポート番号は1〜65535の整数で指定してください',
  );
  assert.equal(format.cleanIpcErrorMessage("Error invoking remote method 'x': Error: boom"), 'boom');
  assert.equal(format.cleanIpcErrorMessage('plain'), 'plain');
});

test('buildSeriesPath: 点が1つでも線を描き、最大値で高さを正規化する', () => {
  assert.equal(chart.buildSeriesPath([5], { maxValue: 10, width: 108, height: 108 }), 'M 4.00,104.00 L 104.00,54.00');
  assert.equal(chart.buildSeriesPath([], { maxValue: 0, width: 108, height: 108 }), 'M 4.00,104.00 L 104.00,104.00');
  const d = chart.buildSeriesPath([0, 10, 5], { maxValue: 10, width: 108, height: 108 });
  assert.equal(d, 'M 4.00,104.00 L 54.00,4.00 L 104.00,54.00');
});

test('scan-errors: TCP/UDP両方の失敗のみ利用不可、要約はラベル付き', () => {
  assert.equal(scanErrors.isScanUnusable([{ source: 'TCP' }, { source: 'UDP' }]), true);
  assert.equal(scanErrors.isScanUnusable([{ source: 'TCP' }, { source: 'CommandLine' }]), false);
  const summary = scanErrors.summarizeScanErrors([{ source: 'UDP', message: 'x' }, { source: 'CommandLine', message: 'y' }]);
  assert.equal(summary.sources, 'UDP / コマンドライン');
  assert.equal(summary.detail, 'UDP: x\nコマンドライン: y');
  assert.equal(summary.key, 'UDP:x|CommandLine:y');
});
