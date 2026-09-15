const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validation');

test('validatePid: 正の整数（数値文字列含む）を受け付ける', () => {
  assert.equal(v.validatePid(1234), 1234);
  assert.equal(v.validatePid('5678'), 5678);
});

test('validatePid: 0・負数・小数・非数値・コマンド混入を拒否する', () => {
  for (const bad of [0, -1, 1.5, NaN, '', 'abc', '12; Stop-Computer', null, undefined, {}, [1]]) {
    assert.throws(() => v.validatePid(bad), v.ValidationError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('validateKillRequest: 再検証用の情報を正規化し、PID単体の旧形式も受け付ける', () => {
  assert.deepEqual(
    v.validateKillRequest({ pid: '301', port: 5173, protocol: 'udp', processName: 'node' }),
    { pid: 301, port: 5173, protocol: 'UDP', processName: 'node' },
  );
  assert.deepEqual(v.validateKillRequest(301), { pid: 301, port: null, protocol: 'TCP', processName: '' });
  assert.throws(() => v.validateKillRequest({ pid: 301, port: 0 }), v.ValidationError);
  assert.throws(() => v.validateKillRequest({ pid: '1 & calc' }), v.ValidationError);
});

test('validatePort: 1〜65535の範囲のみ許可する', () => {
  assert.equal(v.validatePort(1), 1);
  assert.equal(v.validatePort('65535'), 65535);
  for (const bad of [0, 65536, -80, 80.5, '80,443', 'http']) {
    assert.throws(() => v.validatePort(bad), v.ValidationError);
  }
});

test('validateProtocol: 未指定はTCP、小文字は正規化、それ以外は拒否', () => {
  assert.equal(v.validateProtocol(undefined), 'TCP');
  assert.equal(v.validateProtocol('udp'), 'UDP');
  assert.throws(() => v.validateProtocol('ICMP'), v.ValidationError);
});

test('validateId: store が生成する形式を受け付け、不正な文字や長さを拒否する', () => {
  assert.equal(v.validateId('fav_1713246000000'), 'fav_1713246000000');
  assert.throws(() => v.validateId(''), v.ValidationError);
  assert.throws(() => v.validateId('mon_1; rm'), v.ValidationError);
  assert.throws(() => v.validateId('a'.repeat(65)), v.ValidationError);
  assert.throws(() => v.validateId(123), v.ValidationError);
});

test('validateFavoriteInput: 正規化した値だけを返す', () => {
  const result = v.validateFavoriteInput({ port: '3000', protocol: 'tcp', label: '  Next.js  ', description: undefined, extra: 'x' });
  assert.deepEqual(result, { port: 3000, protocol: 'TCP', label: 'Next.js', description: '' });
});

test('validateFavoriteInput: ラベルの長さ超過・型不正・オブジェクト以外を拒否する', () => {
  assert.throws(() => v.validateFavoriteInput({ port: 3000, label: 'a'.repeat(v.LIMITS.labelMaxLength + 1) }), v.ValidationError);
  assert.throws(() => v.validateFavoriteInput({ port: 3000, label: 42 }), v.ValidationError);
  assert.throws(() => v.validateFavoriteInput(null), v.ValidationError);
  assert.throws(() => v.validateFavoriteInput([3000]), v.ValidationError);
});

test('validateMonitorInput: 通知フラグは未指定ならtrue', () => {
  const result = v.validateMonitorInput({ port: 5173 });
  assert.deepEqual(result, { port: 5173, protocol: 'TCP', label: '', notifyOnOccupied: true, notifyOnFreed: true });
  assert.throws(() => v.validateMonitorInput({ port: 5173, notifyOnFreed: 'yes' }), v.ValidationError);
});

test('validateMonitorUpdate: 許可された項目のみ更新でき、内部状態は書き換えられない', () => {
  assert.deepEqual(v.validateMonitorUpdate({ enabled: false }), { enabled: false });
  assert.throws(() => v.validateMonitorUpdate({ lastKnownState: 'occupied' }), v.ValidationError);
  assert.throws(() => v.validateMonitorUpdate({ port: 1 }), v.ValidationError);
  assert.throws(() => v.validateMonitorUpdate({ enabled: undefined }), v.ValidationError);
});

test('validateSettingsUpdate: 監視間隔は1〜60秒', () => {
  assert.deepEqual(v.validateSettingsUpdate({ monitorIntervalMs: 1000 }), { monitorIntervalMs: 1000 });
  assert.deepEqual(v.validateSettingsUpdate({ monitorIntervalMs: 60000 }), { monitorIntervalMs: 60000 });
  assert.throws(() => v.validateSettingsUpdate({ monitorIntervalMs: 999 }), v.ValidationError);
  assert.throws(() => v.validateSettingsUpdate({ monitorIntervalMs: 60001 }), v.ValidationError);
  assert.throws(() => v.validateSettingsUpdate({ unknown: true }), v.ValidationError);
});
