const test = require('node:test');
const assert = require('node:assert/strict');

let h;
test.before(async () => {
  h = await import('../../renderer/js/lib/history.js');
});

const fmt = (date) => date.toISOString();

const started = { type: 'started', detection: 'poll', port: 5173, pid: 100, processName: 'node', category: 'dev', categoryLabel: 'Vite', commandLine: 'node C:\\work\\shop\\vite.js', processStartedAt: '2026-09-16T01:00:00.000Z' };
const startup = { ...started, detection: 'startup' };
const stoppedWhileClosed = { ...started, type: 'stopped', detection: 'startup' };
const killed = { type: 'killed', detection: 'app', port: 5173, pid: 100, processName: 'node.exe', method: 'graceful', tree: true };
const other = { type: 'started', detection: 'poll', port: 7070, pid: 5, processName: 'AnyDesk', category: '', categoryLabel: '', commandLine: '' };

test('historyTypeLabel: 起動時の検出は「検出」と明示する', () => {
  assert.equal(h.historyTypeLabel(started), '使用開始');
  assert.equal(h.historyTypeLabel(startup), '使用中を検出');
  assert.equal(h.historyTypeLabel(stoppedWhileClosed), '解放を検出');
  assert.equal(h.historyTypeLabel(killed), 'アプリで停止');
});

test('describeHistoryEvent: 起動時検出は時刻が不明な旨とプロセス開始時刻を示す', () => {
  assert.equal(h.describeHistoryEvent(started, fmt), 'プロセス開始: 2026-09-16T01:00:00.000Z');
  assert.match(h.describeHistoryEvent(startup, fmt), /^アプリ起動時に使用中だったため.*不明です \/ プロセス開始/);
  assert.match(h.describeHistoryEvent({ ...stoppedWhileClosed, processStartedAt: null }, fmt), /^アプリを閉じている間に解放されました$/);
  assert.equal(h.describeHistoryEvent(killed, fmt), '通常停止（子プロセスを含む）');
  assert.equal(h.describeHistoryEvent({ ...killed, method: 'force', tree: false }, fmt), '強制停止');
});

test('filterHistory: 種別・カテゴリ・テキスト（コマンドラインのプロジェクト名を含む）で絞り込む', () => {
  const events = [started, killed, other];
  assert.deepEqual(h.filterHistory(events, { type: 'killed' }), [killed]);
  assert.deepEqual(h.filterHistory(events, { category: 'dev' }), [started]);
  assert.deepEqual(h.filterHistory(events, { text: 'shop' }), [started]);
  assert.deepEqual(h.filterHistory(events, { text: 'anydesk' }), [other]);
  assert.equal(h.filterHistory(events, {}).length, 3);
});

test('isNotableHistoryEvent: 起動中に検出した開発/DBプロセスの出入りのみ', () => {
  assert.equal(h.isNotableHistoryEvent(started), true);
  assert.equal(h.isNotableHistoryEvent(startup), false);
  assert.equal(h.isNotableHistoryEvent(other), false);
  assert.equal(h.isNotableHistoryEvent(killed), false);
});

test('summarizeHistoryEvent', () => {
  assert.equal(h.summarizeHistoryEvent(started), 'ポート 5173 を node（Vite） が使い始めました');
  assert.equal(h.summarizeHistoryEvent({ ...started, type: 'stopped', categoryLabel: '' }), 'ポート 5173 を node が解放しました');
});
