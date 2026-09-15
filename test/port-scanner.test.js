const test = require('node:test');
const assert = require('node:assert/strict');
const { createScanner, normalizeTargets } = require('../src/port-scanner');

// 実行されたスクリプトの内容で応答を切り替える偽のPowerShell
function fakeRun(handlers) {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    for (const [pattern, handler] of handlers) {
      if (pattern.test(script)) return handler(script);
    }
    throw new Error(`unexpected script: ${script.slice(0, 60)}`);
  };
  return { run, calls };
}

const noRanges = async () => [];

const TCP_ROWS = [
  { Protocol: 'TCP', LocalAddress: '::', LocalPort: 5173, RemoteAddress: '::', RemotePort: 0, State: 'Listen', PID: 100, ProcessName: 'node' },
  { Protocol: 'TCP', LocalAddress: '0.0.0.0', LocalPort: 135, RemoteAddress: '0.0.0.0', RemotePort: 0, State: 'Listen', PID: 4, ProcessName: 'svchost' },
];
const UDP_ROWS = [
  { Protocol: 'UDP', LocalAddress: '0.0.0.0', LocalPort: 5353, RemoteAddress: '*', RemotePort: 0, State: '--', PID: 200, ProcessName: 'chrome' },
];

test('scanPorts: TCP/UDPを結合し、分類とコマンドラインを付与する', async () => {
  const { run } = fakeRun([
    [/Get-NetTCPConnection \|/, () => TCP_ROWS.map((r) => ({ ...r }))],
    [/Get-NetUDPEndpoint \|/, () => UDP_ROWS.map((r) => ({ ...r }))],
    [/Win32_Process/, (script) => {
      assert.match(script, /ProcessId=100/);
      assert.doesNotMatch(script, /ProcessId=4\b/, '分類されていないPIDは問い合わせない');
      return [{ ProcessId: 100, CommandLine: 'node vite' }];
    }],
  ]);

  const { ports, errors } = await createScanner({ run, getExcludedPortRanges: noRanges }).scanPorts();

  assert.deepEqual(errors, []);
  assert.equal(ports.length, 3);
  const vite = ports.find((p) => p.LocalPort === 5173);
  assert.equal(vite.Category, 'dev');
  assert.equal(vite.CategoryLabel, 'Vite');
  assert.equal(vite.CommandLine, 'node vite');
  assert.equal(ports.find((p) => p.LocalPort === 135).Category, '');
});

test('scanPorts: 片方の取得失敗は errors に記録し、取れた分は返す', async () => {
  const { run } = fakeRun([
    [/Get-NetTCPConnection \|/, () => TCP_ROWS.map((r) => ({ ...r }))],
    [/Get-NetUDPEndpoint \|/, () => { throw new Error('UDP failed'); }],
    [/Win32_Process/, () => []],
  ]);

  const { ports, errors } = await createScanner({ run, getExcludedPortRanges: noRanges }).scanPorts();

  assert.equal(ports.length, 2);
  assert.deepEqual(errors, [{ source: 'UDP', message: 'UDP failed' }]);
});

test('scanPorts: コマンドライン取得の失敗はポート一覧を失わない', async () => {
  const { run } = fakeRun([
    [/Get-NetTCPConnection \|/, () => TCP_ROWS.map((r) => ({ ...r }))],
    [/Get-NetUDPEndpoint \|/, () => []],
    [/Win32_Process/, () => { throw new Error('access denied'); }],
  ]);

  const { ports, errors } = await createScanner({ run, getExcludedPortRanges: noRanges }).scanPorts();

  assert.equal(ports.length, 2);
  assert.equal(ports[0].CommandLine, '');
  assert.deepEqual(errors, [{ source: 'CommandLine', message: 'access denied' }]);
});

test('scanPorts: 予約ポート範囲を返し、取得失敗は errors に記録する', async () => {
  const handlers = [
    [/Get-NetTCPConnection \|/, () => []],
    [/Get-NetUDPEndpoint \|/, () => []],
  ];
  const ranges = [{ start: 55676, end: 55775, managed: false }];

  const ok = await createScanner({ run: fakeRun(handlers).run, getExcludedPortRanges: async () => ranges }).scanPorts();
  assert.deepEqual(ok.excludedRanges, ranges);
  assert.deepEqual(ok.errors, []);

  const failed = await createScanner({
    run: fakeRun(handlers).run,
    getExcludedPortRanges: async () => { throw new Error('netsh failed'); },
  }).scanPorts();
  assert.deepEqual(failed.excludedRanges, []);
  assert.deepEqual(failed.errors, [{ source: 'ExcludedRanges', message: 'netsh failed' }]);
});

test('scanPorts: プロセス名は接続ごとの Get-Process ではなく事前に作った表から引く', async () => {
  const { run, calls } = fakeRun([
    [/Get-NetTCPConnection \|/, () => []],
    [/Get-NetUDPEndpoint \|/, () => []],
  ]);
  await createScanner({ run, getExcludedPortRanges: noRanges }).scanPorts();
  for (const script of calls) {
    assert.doesNotMatch(script, /Get-Process -Id/);
    assert.match(script, /\$procs\[\[int\]\$_\.Id\]/);
  }
});

test('scanTcpListeners: 待受を正規化し、分類とプロセス開始時刻を付与する', async () => {
  const { run } = fakeRun([
    [/Get-NetTCPConnection -State Listen/, () => [
      { LocalAddress: '::1', LocalPort: 5173, PID: 100, ProcessName: 'node', ProcessStartedAt: '2026-09-16T01:00:00.0000000Z' },
      { LocalAddress: '0.0.0.0', LocalPort: 7070, PID: 200, ProcessName: 'AnyDesk', ProcessStartedAt: null },
    ]],
  ]);
  const listeners = await createScanner({ run, getExcludedPortRanges: noRanges }).scanTcpListeners();
  assert.deepEqual(listeners[0], {
    port: 5173, pid: 100, processName: 'node', processStartedAt: '2026-09-16T01:00:00.0000000Z', localAddress: '::1', category: 'dev', categoryLabel: 'Vite',
  });
  assert.equal(listeners[1].category, '');
  assert.equal(listeners[1].processStartedAt, null);
});

test('scanTcpListeners: 取得失敗は例外を投げる（全ポート解放と誤認しない）', async () => {
  const { run } = fakeRun([[/Get-NetTCPConnection/, () => { throw new Error('timeout'); }]]);
  await assert.rejects(() => createScanner({ run, getExcludedPortRanges: noRanges }).scanTcpListeners(), /timeout/);
});

test('checkPorts: 使用中/空きを PROTOCOL:port キーで返す', async () => {
  const { run } = fakeRun([
    [/\$targets = @\(3000,5173\)[\s\S]*Get-NetTCPConnection -State Listen/, () => [{ Protocol: 'TCP', LocalPort: 5173, PID: 100, ProcessName: 'node' }]],
    [/\$targets = @\(5353\)[\s\S]*Get-NetUDPEndpoint/, () => []],
  ]);

  const map = await createScanner({ run, getExcludedPortRanges: noRanges }).checkPorts([3000, { port: 5173 }, { port: 5353, protocol: 'udp' }]);

  assert.deepEqual(map.get('TCP:3000'), { occupied: false, processName: '', pid: 0 });
  assert.deepEqual(map.get('TCP:5173'), { occupied: true, processName: 'node', pid: 100 });
  assert.deepEqual(map.get('UDP:5353'), { occupied: false, processName: '', pid: 0 });
});

test('checkPorts: -LocalPort 指定を使わない（該当なしが混ざると結果全体が失われるため）', async () => {
  const { run, calls } = fakeRun([
    [/Get-NetTCPConnection/, () => []],
  ]);
  await createScanner({ run, getExcludedPortRanges: noRanges }).checkPorts([3000, 59999]);
  assert.doesNotMatch(calls[0], /-LocalPort/);
});

test('checkPorts: 取得失敗は空き扱いにせず例外を投げる', async () => {
  const { run } = fakeRun([
    [/Get-NetTCPConnection/, () => { throw new Error('timeout'); }],
  ]);

  await assert.rejects(() => createScanner({ run, getExcludedPortRanges: noRanges }).checkPorts([3000]), /timeout/);
});

test('checkPorts: 対象が無効値のみならPowerShellを実行しない', async () => {
  const { run, calls } = fakeRun([]);
  const map = await createScanner({ run, getExcludedPortRanges: noRanges }).checkPorts([0, 'abc', { port: 70000 }]);
  assert.equal(map.size, 0);
  assert.equal(calls.length, 0);
});

test('normalizeTargets: スクリプトに埋め込めない値を除外する', () => {
  const result = normalizeTargets([80, '443', '1;Stop-Computer', { port: 53, protocol: 'udp' }, { port: 22, protocol: 'ICMP' }, null]);
  assert.deepEqual(result, [
    { port: 80, protocol: 'TCP' },
    { port: 443, protocol: 'TCP' },
    { port: 53, protocol: 'UDP' },
  ]);
});
