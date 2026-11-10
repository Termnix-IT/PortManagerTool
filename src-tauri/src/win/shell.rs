//! シェル連携（既定のブラウザで開く、AppUserModelID の設定）

use super::text::to_wide;
use windows::core::{w, PCWSTR};
use windows::Win32::UI::Shell::{SetCurrentProcessExplicitAppUserModelID, ShellExecuteW};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// URL を既定のブラウザで開く。呼び出し側は固定のURLだけを渡すこと
pub fn open_url(url: &str) -> Result<(), String> {
    let target = to_wide(url);
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // 32 以下はエラー（ShellExecute の仕様）
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "ページを開けませんでした（エラーコード {}）",
            result.0 as isize
        ))
    }
}

/// タスクバーのグループ化とトースト通知でアプリを識別するID（インストーラーのショートカットと同じ値）
pub fn set_app_user_model_id(id: &str) {
    let id = to_wide(id);
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(PCWSTR(id.as_ptr()));
    }
}
