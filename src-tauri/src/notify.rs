//! デスクトップ通知（Windows のトースト）。クリックでメインウィンドウを前面に出す。

use tauri::{AppHandle, Manager};
use tauri_winrt_notification::Toast;

/// トーストの送信元ID。インストーラー版はスタートメニューのショートカットにアプリのIDが登録されるが、
/// 登録の無い実行形態（開発中・ポータブル版）でそのIDを使うと通知が表示されないため、PowerShell のIDを借りる
pub fn notification_app_id(is_installed: bool, app_id: &str) -> String {
    if is_installed {
        app_id.to_string()
    } else {
        Toast::POWERSHELL_APP_ID.to_string()
    }
}

pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn show(app: &AppHandle, app_id: &str, title: &str, body: &str) {
    let handle = app.clone();
    let result = Toast::new(app_id)
        .title(title)
        .text1(body)
        .on_activated(move |_action| {
            focus_main_window(&handle);
            Ok(())
        })
        .show();
    if let Err(err) = result {
        eprintln!("[notify] 通知を表示できませんでした: {err}");
    }
}
