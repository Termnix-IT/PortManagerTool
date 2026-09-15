const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExcludedPortRanges, mergeRanges, createExcludedPortsProvider } = require('../src/excluded-ports');

// 日本語環境の netsh 出力（見出しはロケール依存、範囲行は数値のみ）
const JA_OUTPUT = `
プロトコル tcp ポート除外範囲

開始ポート    終了ポート
----------    --------
      5357        5357
     50000       50059     *
     55676       55775

* - 管理されている除外ポート。
`;

const EN_OUTPUT = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      5357        5357
     49709       49808

* - Administered port exclusions.
`;

test('parseExcludedPortRanges: ロケールに依存せず範囲行だけを読む', () => {
  assert.deepEqual(parseExcludedPortRanges(JA_OUTPUT), [
    { start: 5357, end: 5357, managed: false },
    { start: 50000, end: 50059, managed: true },
    { start: 55676, end: 55775, managed: false },
  ]);
  assert.deepEqual(parseExcludedPortRanges(EN_OUTPUT).map((r) => r.start), [5357, 49709]);
});

test('parseExcludedPortRanges: 空出力・不正な範囲は無視する', () => {
  assert.deepEqual(parseExcludedPortRanges(''), []);
  assert.deepEqual(parseExcludedPortRanges('  70000  70001\n  900  100\n'), []);
});

test('mergeRanges: IPv4/IPv6 の重複をまとめ、開始ポート順に並べる', () => {
  const merged = mergeRanges([
    [{ start: 55676, end: 55775, managed: false }, { start: 5357, end: 5357, managed: false }],
    [{ start: 5357, end: 5357, managed: true }],
  ]);
  assert.deepEqual(merged, [
    { start: 5357, end: 5357, managed: true },
    { start: 55676, end: 55775, managed: false },
  ]);
});

test('getExcludedPortRanges: 一定時間キャッシュし、期限切れで再取得する', async () => {
  let calls = 0;
  let clock = 0;
  const provider = createExcludedPortsProvider({
    run: async () => { calls += 1; return JA_OUTPUT; },
    now: () => clock,
    ttlMs: 1000,
  });

  await provider.getExcludedPortRanges();
  await provider.getExcludedPortRanges();
  assert.equal(calls, 2, 'ipv4 と ipv6 の2回だけ');

  clock = 1500;
  const ranges = await provider.getExcludedPortRanges();
  assert.equal(calls, 4);
  assert.equal(ranges.length, 3);
});

test('getExcludedPortRanges: 取得失敗はキャッシュせず例外を投げる', async () => {
  let fail = true;
  const provider = createExcludedPortsProvider({
    run: async () => { if (fail) throw new Error('netsh failed'); return JA_OUTPUT; },
  });
  await assert.rejects(() => provider.getExcludedPortRanges(), /netsh failed/);
  fail = false;
  assert.equal((await provider.getExcludedPortRanges()).length, 3);
});
