const test = require('node:test');
const assert = require('node:assert/strict');

let u;
test.before(async () => {
  u = await import('../../renderer/js/lib/updates.js');
});

const fmt = (date) => date.toISOString();

test('describeUpdateStatus: 操作できる状態を返す', () => {
  const cases = [
    [{ state: 'idle' }, { canCheck: true, canInstall: false, label: '未確認' }],
    [{ state: 'checking' }, { canCheck: false, canInstall: false }],
    [{ state: 'available', latestVersion: '1.1.0' }, { canCheck: false, label: 'v1.1.0 があります' }],
    [{ state: 'downloading', latestVersion: '1.1.0', percent: 42 }, { canCheck: false, label: 'ダウンロード中 42%' }],
    [{ state: 'downloaded', latestVersion: '1.1.0' }, { canCheck: false, canInstall: true }],
    [{ state: 'not-available' }, { canCheck: true, label: '最新です' }],
    [{ state: 'error', message: 'x' }, { canCheck: true, pillClass: 'busy' }],
    [{ state: 'unsupported', message: 'ポータブル版は…' }, { canCheck: false, canInstall: false, message: 'ポータブル版は…' }],
  ];
  for (const [status, expected] of cases) {
    const view = u.describeUpdateStatus(status, fmt);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(view[key], value, `${status.state}.${key}`);
    }
  }
});

test('describeUpdateStatus: 確認日時を添える', () => {
  const view = u.describeUpdateStatus({ state: 'error', message: '接続できません', checkedAt: '2026-09-16T00:00:00.000Z' }, fmt);
  assert.equal(view.message, '接続できません（2026-09-16T00:00:00.000Z に確認）');
});
