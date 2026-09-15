const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistoryStorage } = require('../src/history-storage');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'port-history-test-'));
}

const NOW = new Date('2026-09-16T00:00:00Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

test('appendEvents / loadEvents: JSONL に追記し、順序どおり読み戻す', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storage = createHistoryStorage({ dir: path.join(dir, 'nested'), now: () => NOW });

  assert.deepEqual(storage.loadEvents(), [], 'ファイルが無ければ空');
  storage.appendEvents([{ id: '1', at: daysAgo(1) }]);
  storage.appendEvents([{ id: '2', at: daysAgo(0) }, { id: '3', at: daysAgo(0) }]);

  assert.deepEqual(storage.loadEvents().map((e) => e.id), ['1', '2', '3']);
  assert.equal(fs.readFileSync(storage.eventsPath, 'utf8').trim().split('\n').length, 3);
});

test('loadEvents: 保持期間・件数を超えた分と壊れた行を捨て、ファイルを書き直す', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storage = createHistoryStorage({ dir, now: () => NOW, maxEvents: 2, retentionDays: 30 });

  fs.writeFileSync(storage.eventsPath, [
    JSON.stringify({ id: 'old', at: daysAgo(31) }),
    '{"id":"broken"',
    JSON.stringify({ id: 'a', at: daysAgo(3) }),
    JSON.stringify({ id: 'b', at: daysAgo(2) }),
    JSON.stringify({ id: 'c', at: daysAgo(1) }),
  ].join('\n'));

  assert.deepEqual(storage.loadEvents().map((e) => e.id), ['b', 'c']);
  assert.deepEqual(
    fs.readFileSync(storage.eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).id),
    ['b', 'c'],
  );
});

test('saveSnapshot / loadSnapshot: 保存した待受一覧を読み戻し、無い・壊れている場合は null', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storage = createHistoryStorage({ dir, now: () => NOW });

  assert.equal(storage.loadSnapshot(), null);
  storage.saveSnapshot([{ port: 5173, pid: 100 }]);
  assert.deepEqual(storage.loadSnapshot(), [{ port: 5173, pid: 100 }]);

  fs.writeFileSync(path.join(dir, 'port-history-snapshot.json'), '{broken');
  assert.equal(storage.loadSnapshot(), null);
});

test('clearEvents: 履歴を空にする', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storage = createHistoryStorage({ dir, now: () => NOW });

  storage.appendEvents([{ id: '1', at: daysAgo(0) }]);
  storage.clearEvents();
  assert.deepEqual(storage.loadEvents(), []);
});
