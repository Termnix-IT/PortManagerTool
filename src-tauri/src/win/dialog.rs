//! 確認ダイアログ（TaskDialogIndirect）。
//! Electron の dialog.showMessageBox と同じ部品で、任意のボタンとチェックボックスを表示する。
//!
//! TaskDialogIndirect は Common Controls v6 にしか無い。アプリの実行ファイルには tauri-build が v6 を指定する
//! マニフェストを埋め込むが、`cargo test` の実行ファイルには無く、静的にリンクすると起動できなくなる。
//! そのため実行時に GetProcAddress で取得する。

use super::text::to_wide;
use crate::kill_flow::{DialogKind, DialogOptions, DialogResponse, Dialogs};
use std::mem::size_of;
use std::sync::OnceLock;
use windows::core::{s, w, BOOL, HRESULT, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::UI::Controls::{
    TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
    TDF_POSITION_RELATIVE_TO_WINDOW, TDF_USE_HICON_MAIN, TDF_VERIFICATION_FLAG_CHECKED,
    TD_ERROR_ICON, TD_WARNING_ICON,
};
use windows::Win32::UI::WindowsAndMessaging::{LoadIconW, IDCANCEL, IDI_QUESTION};

type TaskDialogIndirectFn =
    unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut BOOL) -> HRESULT;

/// ボタンIDの開始値（IDOK などの既定IDと重ならないようにする）
const BUTTON_ID_BASE: i32 = 1000;

fn task_dialog_indirect() -> Option<TaskDialogIndirectFn> {
    static FUNCTION: OnceLock<Option<usize>> = OnceLock::new();
    let address = FUNCTION.get_or_init(|| unsafe {
        let module = LoadLibraryW(w!("comctl32.dll")).ok()?;
        GetProcAddress(module, s!("TaskDialogIndirect")).map(|f| f as usize)
    });
    address.map(|address| unsafe { std::mem::transmute::<usize, TaskDialogIndirectFn>(address) })
}

/// 親ウィンドウ（HWND を整数で保持する。HWND はスレッド間で送れないため）
pub struct TaskDialogs {
    pub owner: isize,
}

impl TaskDialogs {
    pub fn show(&self, options: &DialogOptions) -> Result<DialogResponse, String> {
        let show = task_dialog_indirect().ok_or_else(|| {
            "確認ダイアログを表示できませんでした（TaskDialogIndirect が見つかりません）"
                .to_string()
        })?;

        let title = to_wide(&options.title);
        let message = to_wide(&options.message);
        let detail = to_wide(&options.detail);
        let labels: Vec<Vec<u16>> = options.buttons.iter().map(|label| to_wide(label)).collect();
        let buttons: Vec<TASKDIALOG_BUTTON> = labels
            .iter()
            .enumerate()
            .map(|(index, label)| TASKDIALOG_BUTTON {
                nButtonID: BUTTON_ID_BASE + index as i32,
                pszButtonText: PCWSTR(label.as_ptr()),
            })
            .collect();
        let checkbox = options.checkbox.as_ref().map(|(label, _)| to_wide(label));

        let mut flags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
        if matches!(options.checkbox, Some((_, true))) {
            flags |= TDF_VERIFICATION_FLAG_CHECKED;
        }
        let icon = match options.kind {
            DialogKind::Error => TASKDIALOGCONFIG_0 {
                pszMainIcon: TD_ERROR_ICON,
            },
            DialogKind::Warning => TASKDIALOGCONFIG_0 {
                pszMainIcon: TD_WARNING_ICON,
            },
            DialogKind::Question => match unsafe { LoadIconW(None, IDI_QUESTION) } {
                Ok(icon) => {
                    flags |= TDF_USE_HICON_MAIN;
                    TASKDIALOGCONFIG_0 { hMainIcon: icon }
                }
                Err(_) => TASKDIALOGCONFIG_0 {
                    pszMainIcon: PCWSTR::null(),
                },
            },
        };

        let config = TASKDIALOGCONFIG {
            cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
            hwndParent: HWND(self.owner as *mut _),
            dwFlags: flags,
            pszWindowTitle: PCWSTR(title.as_ptr()),
            Anonymous1: icon,
            pszMainInstruction: PCWSTR(message.as_ptr()),
            pszContent: if options.detail.is_empty() {
                PCWSTR::null()
            } else {
                PCWSTR(detail.as_ptr())
            },
            cButtons: buttons.len() as u32,
            pButtons: buttons.as_ptr(),
            nDefaultButton: BUTTON_ID_BASE + options.default_id as i32,
            pszVerificationText: checkbox
                .as_ref()
                .map_or(PCWSTR::null(), |label| PCWSTR(label.as_ptr())),
            ..Default::default()
        };

        let mut pressed: i32 = 0;
        let mut checked = BOOL(0);
        unsafe { show(&config, &mut pressed, std::ptr::null_mut(), &mut checked) }
            .ok()
            .map_err(|err| format!("確認ダイアログを表示できませんでした: {}", err.message()))?;

        // Esc・閉じるボタンはキャンセル扱いにする
        let response = if pressed == IDCANCEL.0 {
            options.cancel_id
        } else {
            usize::try_from(pressed - BUTTON_ID_BASE)
                .ok()
                .filter(|&index| index < options.buttons.len())
                .unwrap_or(options.cancel_id)
        };
        Ok(DialogResponse {
            response,
            checkbox_checked: checked.as_bool(),
        })
    }
}

impl Dialogs for TaskDialogs {
    /// 表示できなかった場合はキャンセルとして扱う（停止しない側に倒す）
    fn show(&self, options: &DialogOptions) -> DialogResponse {
        TaskDialogs::show(self, options).unwrap_or_else(|err| {
            eprintln!("[dialog] {err}");
            DialogResponse {
                response: options.cancel_id,
                checkbox_checked: false,
            }
        })
    }
}
