//! 自動アップデート（tauri-plugin-updater + GitHub Releases の latest.json）。
//! 状態を1つのオブジェクトで持ち、変化するたびに通知する（renderer の設定画面に表示）。
//! 見つかった更新はバックグラウンドでダウンロードし、アプリの終了時、または「再起動して更新」でインストールする。

use crate::timefmt;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};
use time::OffsetDateTime;

pub const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(15);
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateState {
    Unsupported,
    Idle,
    Checking,
    Available,
    NotAvailable,
    Downloading,
    Downloaded,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: UpdateState,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

impl UpdateStatus {
    fn new(state: UpdateState, current_version: &str) -> Self {
        UpdateStatus {
            state,
            current_version: current_version.into(),
            latest_version: None,
            percent: None,
            message: None,
            checked_at: None,
        }
    }
}

/// 自己更新できない実行形態は unsupported にする
pub fn initial_status(current_version: &str, is_dev: bool, is_installed: bool) -> UpdateStatus {
    let unsupported = |message: &str| UpdateStatus {
        message: Some(message.into()),
        ..UpdateStatus::new(UpdateState::Unsupported, current_version)
    };
    if is_dev {
        unsupported("開発環境（npm start）ではアップデートを確認しません")
    } else if !is_installed {
        unsupported("インストールされていない実行ファイル（ポータブル版）は自動アップデートに対応していません。新しいバージョンはリリースページから入手してください")
    } else {
        UpdateStatus::new(UpdateState::Idle, current_version)
    }
}

/// インストーラー版かどうか。NSIS のインストール先には uninstall.exe が置かれる
pub fn is_installed(exe_dir: &Path) -> bool {
    exe_dir.join("uninstall.exe").is_file()
}

/// ネットワーク未接続・リリース未作成などの原因を利用者向けの文言にする
pub fn describe_error(err: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match err {
        Error::Reqwest(_) | Error::Network(_) => {
            "アップデートサーバーに接続できませんでした。ネットワーク接続を確認してください".into()
        }
        Error::ReleaseNotFound | Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "公開されているリリースが見つかりませんでした".into()
        }
        other => {
            let message = other.to_string();
            let first_line = message.lines().next().unwrap_or_default();
            format!("アップデートの確認に失敗しました: {first_line}")
        }
    }
}

fn now_iso() -> String {
    timefmt::to_iso_millis(OffsetDateTime::now_utc())
}

pub struct UpdateManager {
    current_version: String,
    supported: bool,
    status: Mutex<UpdateStatus>,
    /// ダウンロード済みの更新（インストール待ち）
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    on_status: Box<dyn Fn(&UpdateStatus) + Send + Sync>,
}

impl UpdateManager {
    pub fn new(initial: UpdateStatus, on_status: Box<dyn Fn(&UpdateStatus) + Send + Sync>) -> Self {
        UpdateManager {
            current_version: initial.current_version.clone(),
            supported: initial.state != UpdateState::Unsupported,
            status: Mutex::new(initial),
            pending: Mutex::new(None),
            on_status,
        }
    }

    pub fn is_supported(&self) -> bool {
        self.supported
    }

    pub fn status(&self) -> UpdateStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn set(&self, state: UpdateState, change: impl FnOnce(&mut UpdateStatus)) {
        let mut next = UpdateStatus::new(state, &self.current_version);
        change(&mut next);
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = next.clone();
        (self.on_status)(&next);
    }

    /// 利用者の操作、または起動時・定期の確認。確認中/ダウンロード中は重ねて実行しない
    pub async fn check(self: &Arc<Self>, app: &AppHandle) -> UpdateStatus {
        if !self.supported {
            return self.status();
        }
        {
            let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(
                status.state,
                UpdateState::Checking | UpdateState::Downloading | UpdateState::Downloaded
            ) {
                return status.clone();
            }
            // 確認中の状態を先に立てて、同時に呼ばれても二重に確認しない
            *status = UpdateStatus::new(UpdateState::Checking, &self.current_version);
        }
        (self.on_status)(&self.status());

        let result = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(err) => Err(err),
        };
        match result {
            Ok(Some(update)) => {
                let latest = update.version.clone();
                self.set(UpdateState::Available, |s| s.latest_version = Some(latest));
                let manager = Arc::clone(self);
                tauri::async_runtime::spawn(async move { manager.download(update).await });
            }
            Ok(None) => self.set(UpdateState::NotAvailable, |s| {
                s.checked_at = Some(now_iso())
            }),
            Err(err) => self.set(UpdateState::Error, |s| {
                s.message = Some(describe_error(&err));
                s.checked_at = Some(now_iso());
            }),
        }
        self.status()
    }

    async fn download(self: Arc<Self>, update: Update) {
        let latest = update.version.clone();
        let progress = Arc::clone(&self);
        let progress_version = latest.clone();
        let mut received: u64 = 0;
        let mut last_percent: Option<u32> = None;
        let result = update
            .download(
                move |chunk, total| {
                    received += chunk as u64;
                    let percent = total
                        .filter(|&total| total > 0)
                        .map(|total| (received.saturating_mul(100) / total).min(100) as u32)
                        .unwrap_or(0);
                    // 1% 単位で変化したときだけ通知する
                    if last_percent != Some(percent) {
                        last_percent = Some(percent);
                        progress.set(UpdateState::Downloading, |s| {
                            s.latest_version = Some(progress_version.clone());
                            s.percent = Some(percent);
                        });
                    }
                },
                || {},
            )
            .await;
        match result {
            Ok(bytes) => {
                *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
                self.set(UpdateState::Downloaded, |s| s.latest_version = Some(latest));
            }
            Err(err) => self.set(UpdateState::Error, |s| {
                s.latest_version = Some(latest);
                s.message = Some(describe_error(&err));
                s.checked_at = Some(now_iso());
            }),
        }
    }

    /// 「再起動して更新」。インストーラーを起動してアプリを終了し、更新後に起動し直す
    pub fn install(&self) -> Value {
        let pending = if self.status().state == UpdateState::Downloaded {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
        } else {
            None
        };
        let Some((update, bytes)) = pending else {
            return json!({ "installed": false, "message": "インストールできる更新がありません" });
        };
        // Windows ではインストーラーの起動後にこのプロセスは終了する（ここから戻らない）
        match update.install(&bytes) {
            Ok(()) => json!({ "installed": true }),
            Err(err) => {
                let message = describe_error(&err);
                self.set(UpdateState::Error, |s| s.message = Some(message.clone()));
                json!({ "installed": false, "message": message })
            }
        }
    }

    /// アプリの終了時。ダウンロード済みの更新があれば、起動し直さずにインストールする
    pub fn install_on_exit(&self) {
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some((update, bytes)) = pending {
            if let Err(err) = update.restart_after_install(false).install(&bytes) {
                eprintln!("[updater] 終了時のインストールに失敗しました: {err}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn dev_and_portable_builds_are_unsupported() {
        for (is_dev, is_installed) in [(true, true), (true, false), (false, false)] {
            let status = initial_status("1.0.0", is_dev, is_installed);
            assert_eq!(status.state, UpdateState::Unsupported);
            assert!(status.message.is_some());
        }
        assert_eq!(
            initial_status("1.0.0", false, true).state,
            UpdateState::Idle
        );
    }

    #[test]
    fn installed_build_is_detected_by_uninstaller() {
        let dir = TempDir::new();
        assert!(!is_installed(dir.path()));
        std::fs::write(dir.path().join("uninstall.exe"), b"").unwrap();
        assert!(is_installed(dir.path()));
    }

    #[test]
    fn status_serializes_like_the_electron_version() {
        let status = UpdateStatus {
            latest_version: Some("1.1.0".into()),
            percent: Some(42),
            ..UpdateStatus::new(UpdateState::Downloading, "1.0.0")
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "downloading", "currentVersion": "1.0.0", "latestVersion": "1.1.0", "percent": 42 })
        );
        let not_available =
            serde_json::to_value(UpdateStatus::new(UpdateState::NotAvailable, "1.0.0")).unwrap();
        assert_eq!(not_available["state"], "not-available");
    }

    #[test]
    fn errors_are_described_for_users() {
        use tauri_plugin_updater::Error;
        assert!(describe_error(&Error::Network("dns".into())).contains("ネットワーク"));
        assert!(describe_error(&Error::ReleaseNotFound).contains("リリースが見つかりません"));
        assert!(describe_error(&Error::EmptyEndpoints)
            .starts_with("アップデートの確認に失敗しました: "));
    }

    #[test]
    fn unsupported_manager_never_installs() {
        let notified = Arc::new(AtomicUsize::new(0));
        let counter = notified.clone();
        let manager = UpdateManager::new(
            initial_status("1.0.0", true, false),
            Box::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        );
        assert!(!manager.is_supported());
        assert_eq!(manager.install()["installed"], false);
        manager.install_on_exit();
        assert_eq!(notified.load(Ordering::SeqCst), 0);
    }
}
