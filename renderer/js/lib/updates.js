// アップデート状態の表示用変換（DOMに依存しない）

/**
 * @param {{ state: string, latestVersion?: string, percent?: number, message?: string, checkedAt?: string }} status
 * @param {(date: Date) => string} formatDateTime
 * @returns {{ label: string, pillClass: string, message: string, canCheck: boolean, canInstall: boolean }}
 */
export function describeUpdateStatus(status, formatDateTime) {
  const checkedAt = status.checkedAt ? `（${formatDateTime(new Date(status.checkedAt))} に確認）` : '';
  switch (status.state) {
    case 'unsupported':
      return { label: '対象外', pillClass: 'muted', message: status.message || '', canCheck: false, canInstall: false };
    case 'checking':
      return { label: '確認中…', pillClass: 'muted', message: '', canCheck: false, canInstall: false };
    case 'available':
      return { label: `v${status.latestVersion} があります`, pillClass: 'active', message: 'ダウンロードを開始します', canCheck: false, canInstall: false };
    case 'downloading':
      return { label: `ダウンロード中 ${status.percent ?? 0}%`, pillClass: 'active', message: `v${status.latestVersion ?? ''} をダウンロードしています`, canCheck: false, canInstall: false };
    case 'downloaded':
      return {
        label: `v${status.latestVersion} の準備完了`,
        pillClass: 'active',
        message: 'アプリの終了時に自動でインストールされます。すぐに適用する場合は「再起動して更新」を押してください',
        canCheck: false,
        canInstall: true,
      };
    case 'not-available':
      return { label: '最新です', pillClass: 'muted', message: checkedAt, canCheck: true, canInstall: false };
    case 'error':
      return { label: '確認できませんでした', pillClass: 'busy', message: `${status.message || ''}${checkedAt}`, canCheck: true, canInstall: false };
    default:
      return { label: '未確認', pillClass: 'muted', message: '', canCheck: true, canInstall: false };
  }
}
