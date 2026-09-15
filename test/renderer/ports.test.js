const test = require('node:test');
const assert = require('node:assert/strict');

let ports;
test.before(async () => {
  ports = await import('../../renderer/js/lib/ports.js');
});

const rows = [
  { Protocol: 'TCP', LocalAddress: '::', LocalPort: 5173, State: 'Listen', PID: 100, ProcessName: 'node', Category: 'dev', CategoryLabel: 'Vite', CommandLine: 'node C:\\work\\my-app\\vite.js' },
  { Protocol: 'TCP', LocalAddress: '0.0.0.0', LocalPort: 5432, State: 'Listen', PID: 200, ProcessName: 'postgres', Category: 'db', CategoryLabel: 'PostgreSQL', CommandLine: '' },
  { Protocol: 'TCP', LocalAddress: '192.168.0.2', LocalPort: 50123, State: 'Established', PID: 300, ProcessName: 'chrome', RemoteAddress: '1.1.1.1', RemotePort: 443, Category: '' },
  { Protocol: 'UDP', LocalAddress: '0.0.0.0', LocalPort: 53, State: '--', PID: 400, ProcessName: 'svchost', RemoteAddress: '*', Category: '' },
];

test('filterPorts: カテゴリ・プロトコル・状態で絞り込む', () => {
  assert.deepEqual(ports.filterPorts(rows, { category: 'dev' }).map((p) => p.PID), [100]);
  assert.deepEqual(ports.filterPorts(rows, { protocol: 'UDP' }).map((p) => p.PID), [400]);
  assert.deepEqual(ports.filterPorts(rows, { state: 'Established' }).map((p) => p.PID), [300]);
  assert.equal(ports.filterPorts(rows, {}).length, 4);
});

test('filterPorts: テキスト検索はラベルとコマンドライン（プロジェクト名）も対象', () => {
  assert.deepEqual(ports.filterPorts(rows, { text: 'MY-APP' }).map((p) => p.PID), [100]);
  assert.deepEqual(ports.filterPorts(rows, { text: 'postgresql' }).map((p) => p.PID), [200]);
  assert.deepEqual(ports.filterPorts(rows, { text: '  443 ' }).map((p) => p.PID), []);
  assert.deepEqual(ports.filterPorts(rows, { text: '1.1.1.1' }).map((p) => p.PID), [300]);
});

test('sortPorts: 元の配列を変更せず、昇順/降順・文字列は大文字小文字無視で並べる', () => {
  const input = [...rows];
  assert.deepEqual(ports.sortPorts(input, 'LocalPort', true).map((p) => p.LocalPort), [53, 5173, 5432, 50123]);
  assert.deepEqual(ports.sortPorts(input, 'LocalPort', false).map((p) => p.LocalPort), [50123, 5432, 5173, 53]);
  assert.deepEqual(ports.sortPorts([{ ProcessName: 'b' }, { ProcessName: 'A' }], 'ProcessName', true).map((p) => p.ProcessName), ['A', 'b']);
  assert.deepEqual(input, rows);
});

test('canStopPort / stateLabel / stateClass: Established は停止不可で「接続済み」', () => {
  assert.equal(ports.canStopPort(rows[0]), true);
  assert.equal(ports.canStopPort(rows[2]), false);
  assert.equal(ports.canStopPort(rows[3]), true);
  assert.equal(ports.stateLabel(rows[2]), '接続済み');
  assert.equal(ports.stateLabel(rows[3]), '使用中');
  assert.equal(ports.stateClass(rows[0]), 'active');
  assert.equal(ports.stateClass(rows[2]), 'busy');
});

test('formatRemote: 待受/UDP は "-"', () => {
  assert.equal(ports.formatRemote(rows[2]), '1.1.1.1:443');
  assert.equal(ports.formatRemote(rows[3]), '-');
  assert.equal(ports.formatRemote(rows[0]), '-');
});

test('findEntryForPort: port と protocol の組で探す（protocol 未指定は TCP）', () => {
  const entries = [{ id: 'a', port: 53, protocol: 'UDP' }, { id: 'b', port: '3000' }];
  assert.equal(ports.findEntryForPort(entries, 53, 'UDP').id, 'a');
  assert.equal(ports.findEntryForPort(entries, 53, 'TCP'), undefined);
  assert.equal(ports.findEntryForPort(entries, 3000, 'TCP').id, 'b');
});

test('isPortOccupied: プロトコルを区別する（UDP 53 の登録で TCP 53 を使用中としない）', () => {
  assert.equal(ports.isPortOccupied(rows, 53, 'UDP'), true);
  assert.equal(ports.isPortOccupied(rows, 53, 'TCP'), false);
  assert.equal(ports.isPortOccupied(rows, 50123, 'TCP'), false, 'Established は使用中に数えない');
});

test('countCategories / calculateMetrics', () => {
  assert.deepEqual(ports.countCategories(rows), { ALL: 4, dev: 1, db: 1 });
  const metrics = ports.calculateMetrics({
    ports: [...rows, { ...rows[0], LocalAddress: '0.0.0.0' }],
    monitors: [{ enabled: true }, { enabled: false }],
    favorites: [{}],
  });
  assert.deepEqual(metrics, { active: 4, monitoring: 1, conflicts: 0, favorites: 1 }, '同一プロセスの IPv4/IPv6 待受は競合ではない');

  const withConflict = ports.calculateMetrics({
    ports: [...rows, { ...rows[0], LocalAddress: '127.0.0.1', PID: 999, ProcessName: 'python' }],
    monitors: [],
    favorites: [],
  });
  assert.equal(withConflict.conflicts, 1);
});

test('getPortKey: 同じポートでもアドレス・PID・状態が違えば別の行', () => {
  assert.notEqual(ports.getPortKey(rows[0]), ports.getPortKey({ ...rows[0], LocalAddress: '0.0.0.0' }));
});
