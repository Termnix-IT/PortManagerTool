const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createUpdater, describeError } = require('../src/updater');

function fakeAutoUpdater({ onCheck } = {}) {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.installs = [];
  updater.checkForUpdates = async () => {
    updater.checks += 1;
    if (onCheck) await onCheck(updater);
  };
  updater.quitAndInstall = (...args) => updater.installs.push(args);
  return updater;
}

const NOW = () => new Date('2026-09-16T00:00:00Z');

test('開発環境・ポータブル版・app-update.yml の無い展開版は unsupported で、確認もイベント登録もしない', async () => {
  for (const options of [{ isPackaged: false, isPortable: false, hasUpdateConfig: false }, { isPackaged: true, isPortable: true, hasUpdateConfig: false }, { isPackaged: true, isPortable: false, hasUpdateConfig: false }]) {
    const autoUpdater = fakeAutoUpdater();
    const updater = createUpdater({ autoUpdater, currentVersion: '1.0.0', ...options });
    assert.equal(updater.getStatus().state, 'unsupported');
    assert.ok(updater.getStatus().message);
    await updater.check();
    assert.equal(autoUpdater.checks, 0);
    assert.equal(autoUpdater.listenerCount('error'), 0);
  }
});

test('インストール版は自動ダウンロードと終了時インストールを有効にする', () => {
  const autoUpdater = fakeAutoUpdater();
  createUpdater({ autoUpdater, currentVersion: '1.0.0', isPackaged: true, isPortable: false, hasUpdateConfig: true });
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
});

test('イベントに応じて状態を更新し、変化を通知する', async () => {
  const autoUpdater = fakeAutoUpdater({
    onCheck: (u) => {
      u.emit('checking-for-update');
      u.emit('update-available', { version: '1.1.0' });
      u.emit('download-progress', { percent: 42.4 });
      u.emit('update-downloaded', { version: '1.1.0' });
    },
  });
  const updater = createUpdater({ autoUpdater, currentVersion: '1.0.0', isPackaged: true, isPortable: false, hasUpdateConfig: true, now: NOW });
  const states = [];
  updater.onStatus((status) => states.push(status.state));

  await updater.check();

  assert.deepEqual(states, ['checking', 'available', 'downloading', 'downloaded']);
  assert.deepEqual(updater.getStatus(), { currentVersion: '1.0.0', state: 'downloaded', latestVersion: '1.1.0' });
});

test('ダウンロード中の進捗はバージョンを保持する', () => {
  const autoUpdater = fakeAutoUpdater();
  const updater = createUpdater({ autoUpdater, currentVersion: '1.0.0', isPackaged: true, isPortable: false, hasUpdateConfig: true });
  autoUpdater.emit('update-available', { version: '1.2.0' });
  autoUpdater.emit('download-progress', { percent: 10.6 });
  assert.deepEqual(updater.getStatus(), { currentVersion: '1.0.0', state: 'downloading', latestVersion: '1.2.0', percent: 11 });
});

test('最新なら not-available と確認日時', async () => {
  const autoUpdater = fakeAutoUpdater({ onCheck: (u) => u.emit('update-not-available', { version: '1.0.0' }) });
  const updater = createUpdater({ autoUpdater, currentVersion: '1.0.0', isPackaged: true, isPortable: false, hasUpdateConfig: true, now: NOW });
  const status = await updater.check();
  assert.equal(status.state, 'not-available');
  assert.equal(status.checkedAt, '2026-09-16T00:00:00.000Z');
});

test('確認・ダウンロード中・ダウンロード済みのときは重ねて確認しない', async () => {
  const autoUpdater = fakeAutoUpdater();
  const updater = createUpdater({ autoUpdater, currentVersion: '1.0.0', isPackaged: true, isPortable: false, hasUpdateConfig: true });
  for (const event of [['checking-for-update'], ['download-progress', { percent: 1 }], ['update-downloaded', { version: '1.1.0' }]]) {
    autoUpdater.emit(...event);
    await updater.check();
  }
  assert.equal(autoUpdater.checks, 0);
});

test('checkForUpdates の例外は error 状態にする（error イベントが来ない場合）', async () => {
  const autoUpdater = fakeAutoUpdater({ onCheck: () => { throw new Error('getaddrinfo ENOTFOUND github.com'); } });
  const updater = createUpdater({ autoUpdater, currentVersion: '1.0.0', isPackaged: true, isPortable: false, hasUpdateConfig: true, now: NOW });
  const status = await updater.check();
  assert.equal(status.state, 'error');
  assert.match(status.message, /接続できませんでした/);

  // エラー後は再確認できる
  await updater.check();
  assert.equal(autoUpdater.checks, 2);
});

test('install: ダウンロード済みのときだけ quitAndInstall を呼ぶ', () => {
  const autoUpdater = fakeAutoUpdater();
  const updater = createUpdater({ autoUpdater, currentVersion: '1.0.0', isPackaged: true, isPortable: false, hasUpdateConfig: true });

  assert.equal(updater.install().installed, false);
  assert.equal(autoUpdater.installs.length, 0);

  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  assert.equal(updater.install().installed, true);
  assert.deepEqual(autoUpdater.installs, [[false, true]]);
});

test('describeError: 原因ごとに利用者向けの文言にする', () => {
  assert.match(describeError(new Error('net::ERR_INTERNET_DISCONNECTED')), /ネットワーク/);
  assert.match(describeError(new Error('HttpError: 404 \n "method: GET url: .../latest.yml"')), /リリースが見つかりません/);
  assert.equal(describeError(new Error('something odd\nstack')), 'アップデートの確認に失敗しました: something odd');
});
