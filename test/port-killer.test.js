const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessKiller, decodeOutput, buildInspectScript } = require('../src/port-killer');

test('stopProcess: 通常停止は /F なし、強制停止は /F、ツリーは /T を付ける', async () => {
  const calls = [];
  const killer = createProcessKiller({ taskkill: async (args) => { calls.push(args); return { exitCode: 0, message: '' }; } });

  await killer.stopProcess(123, { force: false, tree: false });
  await killer.stopProcess(123, { force: true, tree: false });
  await killer.stopProcess(123, { force: true, tree: true });

  assert.deepEqual(calls, [
    ['/PID', '123'],
    ['/PID', '123', '/F'],
    ['/PID', '123', '/T', '/F'],
  ]);
});

test('waitForExit: 終了を検出したら true', async () => {
  const states = [true, true, false];
  const killer = createProcessKiller({ isAlive: () => states.shift(), wait: async () => {} });
  assert.equal(await killer.waitForExit(1, { timeoutMs: 1000, intervalMs: 100 }), true);
});

test('waitForExit: タイムアウトまで生きていれば false', async () => {
  let checks = 0;
  const killer = createProcessKiller({ isAlive: () => { checks += 1; return true; }, wait: async () => {} });
  assert.equal(await killer.waitForExit(1, { timeoutMs: 500, intervalMs: 100 }), false);
  assert.equal(checks, 6);
});

test('inspectProcess: PowerShell の出力を正規化する（単一要素や null を配列に）', async () => {
  const killer = createProcessKiller({
    run: async () => [{
      Processes: { ProcessId: 1, ParentProcessId: 0, Name: 'a.exe' },
      Target: null,
      Owner: null,
      TcpPorts: 5173,
      UdpPorts: null,
    }],
  });
  const info = await killer.inspectProcess(1);
  assert.deepEqual(info.processes, [{ ProcessId: 1, ParentProcessId: 0, Name: 'a.exe' }]);
  assert.equal(info.target, null);
  assert.deepEqual(info.tcpPorts, [5173]);
  assert.deepEqual(info.udpPorts, []);
});

test('buildInspectScript: PID をスクリプトに埋め込み、該当なしのみ空として扱う', () => {
  const script = buildInspectScript(4321);
  assert.match(script, /\$targetPid = 4321/);
  assert.match(script, /CmdletizationQuery_NotFound\*/);
  assert.match(script, /else \{ throw \}/);
});

test('decodeOutput: UTF-8 と Shift_JIS（日本語環境の taskkill）を読める', () => {
  assert.equal(decodeOutput(Buffer.from('成功: 終了しました\r\n', 'utf8')), '成功: 終了しました');
  // "エラー" の Shift_JIS
  assert.equal(decodeOutput(Buffer.from([0x83, 0x47, 0x83, 0x89, 0x81, 0x5b])), 'エラー');
  assert.equal(decodeOutput(Buffer.alloc(0)), '');
});
