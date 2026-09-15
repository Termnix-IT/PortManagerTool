const test = require('node:test');
const assert = require('node:assert/strict');

let d;
test.before(async () => {
  d = await import('../../renderer/js/lib/diagnostics.js');
});

const listen = (port, address, pid, name) => ({ Protocol: 'TCP', State: 'Listen', LocalPort: port, LocalAddress: address, PID: pid, ProcessName: name });

test('diagnoseConflicts: 同一プロセスの IPv4/IPv6 待受は競合にしない', () => {
  assert.deepEqual(d.diagnoseConflicts([listen(135, '0.0.0.0', 1, 'svchost'), listen(135, '::', 1, 'svchost')]), []);
});

test('diagnoseConflicts: IPv4 と IPv6 で別プロセスなら split-stack', () => {
  const [conflict] = d.diagnoseConflicts([listen(3000, '::1', 10, 'node'), listen(3000, '127.0.0.1', 20, 'python')]);
  assert.equal(conflict.kind, 'split-stack');
  assert.equal(conflict.port, 3000);
  assert.deepEqual(conflict.processes.map((p) => p.processName), ['node', 'python']);
  assert.match(conflict.hint, /localhost/);
});

test('diagnoseConflicts: ワイルドカードと特定アドレスが混在すれば shadowed', () => {
  const [conflict] = d.diagnoseConflicts([listen(8080, '0.0.0.0', 10, 'java'), listen(8080, '127.0.0.1', 20, 'node')]);
  assert.equal(conflict.kind, 'shadowed');
});

test('diagnoseConflicts: 同じアドレスを共有していれば multiple', () => {
  const [conflict] = d.diagnoseConflicts([listen(5000, '0.0.0.0', 10, 'a'), listen(5000, '0.0.0.0', 20, 'b')]);
  assert.equal(conflict.kind, 'multiple');
});

test('diagnoseConflicts: 一方が両ファミリーで待ち受けていれば split-stack ではない', () => {
  const [conflict] = d.diagnoseConflicts([
    listen(3000, '::', 10, 'node'), listen(3000, '0.0.0.0', 10, 'node'),
    listen(3000, '127.0.0.1', 20, 'python'),
  ]);
  assert.equal(conflict.kind, 'shadowed');
  assert.deepEqual(conflict.processes[0].addresses, ['::', '0.0.0.0']);
});

test('diagnoseConflicts: Established と UDP は対象外、ポート順に並ぶ', () => {
  const result = d.diagnoseConflicts([
    listen(9000, '0.0.0.0', 1, 'a'), listen(9000, '0.0.0.0', 2, 'b'),
    { Protocol: 'UDP', State: '--', LocalPort: 5353, LocalAddress: '0.0.0.0', PID: 3, ProcessName: 'chrome' },
    { Protocol: 'UDP', State: '--', LocalPort: 5353, LocalAddress: '0.0.0.0', PID: 4, ProcessName: 'edge' },
    { Protocol: 'TCP', State: 'Established', LocalPort: 50000, LocalAddress: '0.0.0.0', PID: 5, ProcessName: 'x' },
    { Protocol: 'TCP', State: 'Established', LocalPort: 50000, LocalAddress: '0.0.0.0', PID: 6, ProcessName: 'y' },
    listen(80, '0.0.0.0', 7, 'c'), listen(80, '0.0.0.0', 8, 'd'),
  ]);
  assert.deepEqual(result.map((c) => c.port), [80, 9000]);
});

const RANGES = [{ start: 5357, end: 5357, managed: false }, { start: 55676, end: 55775, managed: false }];

test('findExcludedRange: 範囲の境界を含む', () => {
  assert.equal(d.findExcludedRange(55676, RANGES).end, 55775);
  assert.equal(d.findExcludedRange(55775, RANGES).start, 55676);
  assert.equal(d.findExcludedRange(55776, RANGES), null);
});

test('checkPortAvailability: 空き / 使用中 / 予約範囲', () => {
  const ports = [listen(5173, '::1', 10, 'node'), { Protocol: 'TCP', State: 'Established', LocalPort: 3000, LocalAddress: '::1', PID: 1, ProcessName: 'x' }];

  const free = d.checkPortAvailability({ port: 3000, ports, excludedRanges: RANGES });
  assert.equal(free.status, 'free', 'Established は使用中に数えない');
  assert.deepEqual(free.reasons, []);

  const inUse = d.checkPortAvailability({ port: 5173, ports, excludedRanges: RANGES });
  assert.equal(inUse.status, 'in-use');
  assert.match(inUse.reasons[0], /node（PID 10）/);

  const reserved = d.checkPortAvailability({ port: 55700, ports, excludedRanges: RANGES });
  assert.equal(reserved.status, 'reserved');
  assert.match(reserved.reasons[0], /55676〜55775/);

  const single = d.checkPortAvailability({ port: 5357, ports, excludedRanges: RANGES });
  assert.match(single.reasons[0], /（5357）/);
});

test('checkPortAvailability: UDP は予約範囲を見ず、UDP の使用だけを見る', () => {
  const ports = [{ Protocol: 'UDP', State: '--', LocalPort: 55700, LocalAddress: '0.0.0.0', PID: 3, ProcessName: 'chrome' }];
  const udp = d.checkPortAvailability({ port: 55700, protocol: 'UDP', ports, excludedRanges: RANGES });
  assert.equal(udp.status, 'in-use');
  assert.equal(udp.range, null);
  assert.equal(d.checkPortAvailability({ port: 55700, protocol: 'TCP', ports, excludedRanges: RANGES }).status, 'reserved');
});

test('checkPortAvailability: 1024 未満の空きポートには注意を添える', () => {
  const result = d.checkPortAvailability({ port: 80, ports: [], excludedRanges: [] });
  assert.equal(result.status, 'free');
  assert.match(result.reasons[0], /1024 未満/);
});
