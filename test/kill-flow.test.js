const test = require('node:test');
const assert = require('node:assert/strict');
const { createKillFlow, BUTTON } = require('../src/kill-flow');

const USER = 'PC\\dev';
const PROCESSES = [
  { ProcessId: 300, ParentProcessId: 200, Name: 'node.exe' },
  { ProcessId: 301, ParentProcessId: 300, Name: 'node.exe' },
  { ProcessId: 900, ParentProcessId: 1, Name: 'electron.exe' },
];

function inspection(overrides = {}) {
  return {
    processes: PROCESSES,
    target: { ProcessId: 301, Name: 'node.exe', CommandLine: 'node vite', SessionId: 1 },
    owner: USER,
    tcpPorts: [5173],
    udpPorts: [],
    ...overrides,
  };
}

/**
 * @param {object} options
 * @param {Array<{ response: number, checkboxChecked?: boolean }>} options.dialogResponses  表示順の応答
 * @param {Array<{ exitCode: number, message?: string }>} [options.stopResults]
 * @param {boolean[]} [options.exitResults]  waitForExit の結果（呼び出し順）
 */
function setup({ info = inspection(), dialogResponses = [], stopResults = [], exitResults = [] } = {}) {
  const dialogs = [];
  const stops = [];
  const killer = {
    inspectProcess: async () => (info instanceof Error ? Promise.reject(info) : info),
    stopProcess: async (pid, options) => {
      stops.push({ pid, ...options });
      return stopResults.shift() || { exitCode: 0, message: '' };
    },
    waitForExit: async () => (exitResults.length > 0 ? exitResults.shift() : true),
  };
  const showMessageBox = async (options) => {
    dialogs.push(options);
    const next = dialogResponses.shift();
    if (!next) throw new Error(`unexpected dialog: ${options.message}`);
    return { checkboxChecked: false, ...next };
  };
  const flow = createKillFlow({ killer, showMessageBox, selfPid: 900, currentUser: USER });
  return { flow, dialogs, stops };
}

const request = { pid: 301, port: 5173, protocol: 'TCP', processName: 'node' };

test('run: キャンセルなら停止しない', async () => {
  const { flow, stops } = setup({ dialogResponses: [{ response: BUTTON.cancel }] });
  const result = await flow.run(request);
  assert.deepEqual(result, { success: false, cancelled: true });
  assert.equal(stops.length, 0);
});

test('run: 通常停止で終了すれば graceful として成功', async () => {
  const { flow, stops, dialogs } = setup({ dialogResponses: [{ response: BUTTON.graceful }] });
  const result = await flow.run(request);
  assert.equal(result.success, true);
  assert.equal(result.method, 'graceful');
  assert.deepEqual(stops, [{ pid: 301, force: false, tree: false }]);
  assert.match(dialogs[0].detail, /node vite/, 'コマンドラインを確認ダイアログに表示する');
});

test('run: 通常停止が拒否されたら強制停止を提案し、承諾で強制停止する', async () => {
  const { flow, stops, dialogs } = setup({
    dialogResponses: [{ response: BUTTON.graceful }, { response: 1 }],
    stopResults: [{ exitCode: 1, message: 'この処理は、/F オプションのみで強制終了できます。' }, { exitCode: 0 }],
  });
  const result = await flow.run(request);
  assert.equal(result.method, 'force');
  assert.deepEqual(stops.map((s) => s.force), [false, true]);
  assert.match(dialogs[1].detail, /\/F オプションのみ/);
});

test('run: 通常停止が成功扱いでも終了しなければ強制停止を提案する', async () => {
  const { flow } = setup({
    dialogResponses: [{ response: BUTTON.graceful }, { response: 0 }],
    exitResults: [false],
  });
  const result = await flow.run(request);
  assert.equal(result.success, false);
  assert.equal(result.gracefulFailed, true);
  assert.equal(result.cancelled, true);
});

test('run: 強制停止しても終了しなければ失敗を返す', async () => {
  const { flow } = setup({
    dialogResponses: [{ response: BUTTON.force }],
    stopResults: [{ exitCode: 1, message: 'アクセスが拒否されました。' }],
    exitResults: [false],
  });
  const result = await flow.run(request);
  assert.equal(result.success, false);
  assert.equal(result.error, 'アクセスが拒否されました。');
});

test('run: 子プロセスがあればチェックボックスを出し、チェック時は /T で停止する', async () => {
  const info = inspection({ target: { ProcessId: 300, Name: 'node.exe', SessionId: 1 } });
  const { flow, stops, dialogs } = setup({
    info,
    dialogResponses: [{ response: BUTTON.force, checkboxChecked: true }],
  });
  const result = await flow.run({ ...request, pid: 300 });
  assert.match(dialogs[0].checkboxLabel, /子プロセス（1件）/);
  assert.equal(dialogs[0].checkboxChecked, true);
  assert.deepEqual(stops, [{ pid: 300, force: true, tree: true }]);
  assert.equal(result.tree, true);
});

test('run: 表示時点から別プロセスに変わっていれば停止せず stale を返す', async () => {
  const { flow, stops, dialogs } = setup({
    info: inspection({ target: { ProcessId: 301, Name: 'chrome.exe', SessionId: 1 } }),
    dialogResponses: [{ response: 0 }],
  });
  const result = await flow.run(request);
  assert.equal(result.stale, true);
  assert.equal(dialogs[0].type, 'error');
  assert.equal(stops.length, 0);
});

test('run: 停止禁止のプロセスは確認ダイアログを出さず blocked を返す', async () => {
  const { flow, stops, dialogs } = setup({
    info: inspection({ target: { ProcessId: 900, Name: 'electron.exe', SessionId: 1 }, tcpPorts: [5173] }),
    dialogResponses: [{ response: 0 }],
  });
  const result = await flow.run({ ...request, pid: 900, processName: 'electron' });
  assert.equal(result.blocked, true);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].type, 'error');
  assert.equal(stops.length, 0);
});

test('run: danger は既定ボタンがキャンセルで、追加の確認でキャンセルできる', async () => {
  const { flow, stops, dialogs } = setup({
    info: inspection({ owner: 'PC\\other' }),
    dialogResponses: [{ response: BUTTON.force }, { response: 0 }],
  });
  const result = await flow.run(request);
  assert.equal(dialogs[0].defaultId, BUTTON.cancel);
  assert.equal(dialogs[0].type, 'warning');
  assert.equal(dialogs[1].message, '本当に停止しますか？');
  assert.equal(result.cancelled, true);
  assert.equal(stops.length, 0);
});

test('run: 情報取得に失敗したら停止しない', async () => {
  const { flow, stops } = setup({ info: new Error('PowerShell timeout') });
  const result = await flow.run(request);
  assert.equal(result.success, false);
  assert.match(result.error, /PowerShell timeout/);
  assert.equal(stops.length, 0);
});
