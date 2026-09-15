// 自動アップデート（electron-updater + GitHub Releases）。
// 状態を1つのオブジェクトで持ち、変化するたびに onStatus で通知する（rendererの設定画面に表示）。

const STARTUP_CHECK_DELAY_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * @typedef {object} UpdateStatus
 * @property {'unsupported'|'idle'|'checking'|'available'|'not-available'|'downloading'|'downloaded'|'error'} state
 * @property {string} currentVersion
 * @property {string} [latestVersion]
 * @property {number} [percent]
 * @property {string} [message]
 * @property {string} [checkedAt]
 */

/**
 * @param {object} deps
 * @param {import('events').EventEmitter & { checkForUpdates: Function, quitAndInstall: Function }} deps.autoUpdater
 * @param {string} deps.currentVersion
 * @param {boolean} deps.isPackaged
 * @param {boolean} deps.isPortable  ポータブル版は自己更新できない
 * @param {boolean} deps.hasUpdateConfig  resources/app-update.yml の有無。インストーラー版にだけ含まれる
 *   （`npm run pack` の展開版には無く、確認するとファイル不足のエラーになる）
 * @param {() => Date} [deps.now]
 */
function createUpdater({ autoUpdater, currentVersion, isPackaged, isPortable, hasUpdateConfig, now = () => new Date() }) {
  const listeners = [];
  let startupTimer = null;
  let intervalTimer = null;

  let status = { state: 'idle', currentVersion };
  if (!isPackaged) {
    status = { state: 'unsupported', currentVersion, message: '開発環境（npm start）ではアップデートを確認しません' };
  } else if (isPortable) {
    status = { state: 'unsupported', currentVersion, message: 'ポータブル版は自動アップデートに対応していません。新しいバージョンはリリースページから入手してください' };
  } else if (!hasUpdateConfig) {
    status = { state: 'unsupported', currentVersion, message: 'この実行形式にはアップデート情報が含まれていません。インストーラー版で自動アップデートを利用できます' };
  }
  const supported = status.state !== 'unsupported';

  function setStatus(next) {
    status = { currentVersion, ...next };
    for (const listener of listeners) listener(status);
  }

  if (supported) {
    // 見つかった更新はバックグラウンドでダウンロードし、終了時にインストールする。
    // 利用者は設定画面の「再起動して更新」ですぐに適用もできる
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => setStatus({ state: 'available', latestVersion: info.version }));
    autoUpdater.on('update-not-available', (info) => setStatus({
      state: 'not-available',
      latestVersion: info && info.version,
      checkedAt: now().toISOString(),
    }));
    autoUpdater.on('download-progress', (progress) => setStatus({
      state: 'downloading',
      latestVersion: status.latestVersion,
      percent: Math.round(progress.percent || 0),
    }));
    autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'downloaded', latestVersion: info.version }));
    autoUpdater.on('error', (err) => setStatus({
      state: 'error',
      latestVersion: status.latestVersion,
      message: describeError(err),
      checkedAt: now().toISOString(),
    }));
  }

  function getStatus() {
    return status;
  }

  /** 利用者の操作、または起動時・定期の確認。確認中/ダウンロード中は重ねて実行しない */
  async function check() {
    if (!supported) return status;
    if (['checking', 'downloading', 'downloaded'].includes(status.state)) return status;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // 通常は 'error' イベントでも通知されるが、イベントが来ない失敗もあるためここでも反映する
      setStatus({ state: 'error', message: describeError(err), checkedAt: now().toISOString() });
    }
    return status;
  }

  function install() {
    if (status.state !== 'downloaded') {
      return { installed: false, message: 'インストールできる更新がありません' };
    }
    // isSilent=false: インストーラーの進捗を表示, isForceRunAfter=true: 更新後にアプリを起動
    autoUpdater.quitAndInstall(false, true);
    return { installed: true };
  }

  function start() {
    if (!supported) return;
    startupTimer = setTimeout(check, STARTUP_CHECK_DELAY_MS);
    intervalTimer = setInterval(check, CHECK_INTERVAL_MS);
  }

  function stop() {
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
  }

  function onStatus(listener) {
    listeners.push(listener);
  }

  return { getStatus, check, install, start, stop, onStatus };
}

// ネットワーク未接続・リリース未作成などの原因を利用者向けの文言にする
function describeError(err) {
  const message = err && err.message ? err.message : String(err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(message)) {
    return 'アップデートサーバーに接続できませんでした。ネットワーク接続を確認してください';
  }
  if (/404|latest\.yml|Cannot find latest|No published versions/i.test(message)) {
    return '公開されているリリースが見つかりませんでした';
  }
  return `アップデートの確認に失敗しました: ${message.split('\n')[0]}`;
}

module.exports = { createUpdater, describeError };
