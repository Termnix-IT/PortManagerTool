const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectDescendants,
  collectAncestorPids,
  assessStopRisk,
  verifyExpectedProcess,
} = require('../src/process-safety');

const USER = 'PC\\dev';
const SELF_PID = 500;

// explorer(100) → terminal(200) → npm(300) → node(301) + conhost(302)
// electron(アプリ)は terminal(200) → 500 → 501
const PROCESSES = [
  { ProcessId: 4, ParentProcessId: 0, Name: 'System' },
  { ProcessId: 100, ParentProcessId: 1, Name: 'explorer.exe' },
  { ProcessId: 200, ParentProcessId: 100, Name: 'WindowsTerminal.exe' },
  { ProcessId: 300, ParentProcessId: 200, Name: 'node.exe' },
  { ProcessId: 301, ParentProcessId: 300, Name: 'node.exe' },
  { ProcessId: 302, ParentProcessId: 300, Name: 'conhost.exe' },
  { ProcessId: 500, ParentProcessId: 200, Name: 'electron.exe' },
  { ProcessId: 501, ParentProcessId: 500, Name: 'electron.exe' },
  { ProcessId: 700, ParentProcessId: 1, Name: 'postgres.exe' },
];

function assess(pid, overrides = {}) {
  const target = PROCESSES.find((p) => p.ProcessId === pid) || null;
  return assessStopRisk({
    pid,
    target: target && { ...target, SessionId: 1 },
    owner: USER,
    currentUser: USER,
    processes: PROCESSES,
    selfPid: SELF_PID,
    ...overrides,
  });
}

test('collectDescendants: 孫まで列挙する', () => {
  assert.deepEqual(collectDescendants(PROCESSES, 200).map((p) => p.ProcessId).sort(), [300, 301, 302, 500, 501]);
});

test('collectDescendants: 親子関係がループしていても停止する', () => {
  const looped = [
    { ProcessId: 1, ParentProcessId: 2, Name: 'a' },
    { ProcessId: 2, ParentProcessId: 1, Name: 'b' },
  ];
  assert.deepEqual(collectDescendants(looped, 1).map((p) => p.ProcessId), [2]);
});

test('collectAncestorPids: 親を順にたどる', () => {
  assert.deepEqual(collectAncestorPids(PROCESSES, 501), [500, 200, 100]);
});

test('assessStopRisk: 自分のユーザーの開発プロセスは normal', () => {
  const risk = assess(301);
  assert.equal(risk.level, 'normal');
  assert.deepEqual(risk.reasons, []);
});

test('assessStopRisk: 子プロセスがあれば caution（conhost は数えない）', () => {
  const risk = assess(300);
  assert.equal(risk.level, 'caution');
  assert.deepEqual(risk.childProcesses.map((p) => p.ProcessId), [301]);
  assert.equal(risk.descendants.length, 2);
});

test('assessStopRisk: 子プロセスごと停止する場合は子プロセスの注意を出さない', () => {
  assert.equal(assess(300, { includeTree: true }).level, 'normal');
});

test('assessStopRisk: PID 4 と OS の重要プロセスは blocked', () => {
  assert.equal(assess(4).level, 'blocked');
  const lsass = assessStopRisk({
    pid: 900,
    target: { Name: 'lsass.exe', SessionId: 0 },
    owner: null,
    currentUser: USER,
    processes: [],
    selfPid: SELF_PID,
  });
  assert.equal(lsass.level, 'blocked');
});

test('assessStopRisk: このアプリ自身とその子プロセスは blocked', () => {
  assert.equal(assess(500).level, 'blocked');
  assert.equal(assess(501).level, 'blocked');
});

test('assessStopRisk: 子プロセスにアプリ自身を含むツリー停止は blocked', () => {
  const risk = assess(200, { includeTree: true });
  assert.equal(risk.level, 'blocked');
  assert.match(risk.reasons.join(), /子プロセスにこのアプリ自身/);
});

test('assessStopRisk: 理由は重大なものから並ぶ', () => {
  const risk = assess(500, { owner: null });
  assert.equal(risk.level, 'blocked');
  assert.match(risk.reasons[0], /このアプリ自身/);
  assert.match(risk.reasons[risk.reasons.length - 1], /子プロセス|実行ユーザー/);
});

test('assessStopRisk: アプリの親プロセスは danger', () => {
  const risk = assess(200);
  assert.equal(risk.level, 'danger');
  assert.match(risk.reasons.join(), /親プロセス/);
});

test('assessStopRisk: explorer 等の Windows 機能プロセスは danger', () => {
  assert.equal(assess(100).level, 'danger');
});

test('assessStopRisk: サービス（Session 0）と別ユーザーは danger', () => {
  assert.equal(assess(700, { target: { ProcessId: 700, Name: 'postgres.exe', SessionId: 0 } }).level, 'danger');
  assert.equal(assess(301, { owner: 'PC\\other' }).level, 'danger');
});

test('assessStopRisk: ユーザー比較は大文字小文字を区別しない', () => {
  assert.equal(assess(301, { owner: 'pc\\DEV' }).level, 'normal');
});

test('assessStopRisk: 実行ユーザーが取れなければ caution', () => {
  assert.equal(assess(301, { owner: null }).level, 'caution');
});

test('verifyExpectedProcess: 同じプロセスがポートを使っていれば ok', () => {
  const result = verifyExpectedProcess({
    expected: { processName: 'node', port: 5173, protocol: 'TCP' },
    target: { Name: 'node.exe' },
    tcpPorts: [5173],
    udpPorts: [],
  });
  assert.equal(result.ok, true);
});

test('verifyExpectedProcess: プロセス終了・PID再利用・ポート解放を検出する', () => {
  const expected = { processName: 'node', port: 5173, protocol: 'TCP' };
  assert.match(verifyExpectedProcess({ expected, target: null, tcpPorts: [], udpPorts: [] }).reason, /終了/);
  assert.match(verifyExpectedProcess({ expected, target: { Name: 'chrome.exe' }, tcpPorts: [5173], udpPorts: [] }).reason, /別のプロセス/);
  assert.match(verifyExpectedProcess({ expected, target: { Name: 'node.exe' }, tcpPorts: [3000], udpPorts: [5173] }).reason, /使用していません/);
});

test('verifyExpectedProcess: UDP は UDP のポート一覧で確認する', () => {
  const result = verifyExpectedProcess({
    expected: { processName: 'node', port: 9229, protocol: 'UDP' },
    target: { Name: 'node.exe' },
    tcpPorts: [],
    udpPorts: [9229],
  });
  assert.equal(result.ok, true);
});
