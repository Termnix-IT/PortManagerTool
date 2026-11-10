//! renderer から呼び出すコマンド（`window.portManager` の各関数に対応する）。
//! 引数はすべて `validation` で検証してから使う（信頼境界）。検証エラーは Err で返し、renderer の invoke が reject される。

use crate::history_storage::HistoryEvent;
use crate::kill_flow::{DialogKind, DialogOptions, Dialogs, KillFlow, KillResult, StopMethod};
use crate::killer::WindowsKiller;
use crate::port_history::KillRecord;
use crate::scanner::{self, ScanResult};
use crate::store::{Favorite, Monitor, Settings};
use crate::updater::UpdateStatus;
use crate::validation;
use crate::win::dialog::TaskDialogs;
use crate::{AppState, RELEASES_URL};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

type CommandResult<T> = Result<T, String>;

/// ダイアログの親にするメインウィンドウ（HWND を整数で渡す）
fn main_window_handle(app: &AppHandle) -> isize {
    app.get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .unwrap_or(0)
}

async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| err.to_string())
}

// --- App ---

#[tauri::command]
pub fn app_info(app: AppHandle) -> Value {
    let info = app.package_info();
    json!({ "name": info.name, "version": info.version.to_string() })
}

/// 開くURLは renderer から受け取らず固定する
#[tauri::command]
pub fn app_open_releases() -> CommandResult<()> {
    crate::win::shell::open_url(RELEASES_URL)
}

// --- Updates ---

#[tauri::command]
pub fn updates_get_status(state: State<'_, AppState>) -> UpdateStatus {
    state.updater.status()
}

#[tauri::command]
pub async fn updates_check(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<UpdateStatus> {
    let updater = Arc::clone(&state.updater);
    Ok(updater.check(&app).await)
}

#[tauri::command]
pub fn updates_install(state: State<'_, AppState>) -> Value {
    state.updater.install()
}

// --- Ports ---

#[tauri::command]
pub async fn ports_scan(state: State<'_, AppState>) -> CommandResult<ScanResult> {
    let system = Arc::clone(&state.system);
    let excluded = Arc::clone(&state.excluded);
    run_blocking(move || scanner::scan_ports(system.as_ref(), &excluded)).await
}

/// 確認ダイアログ・危険度判定・停止直前の再検証は kill_flow が担当する
#[tauri::command]
pub async fn ports_kill(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Option<Value>,
) -> CommandResult<KillResult> {
    let request = match validation::validate_kill_request(request.as_ref()) {
        Ok(request) => request,
        Err(err) => return Ok(KillResult::failure(err.0)),
    };
    let owner = main_window_handle(&app);
    let current_user = state.current_user.clone();
    let flow_request = request.clone();
    let result = run_blocking(move || {
        let dialogs = TaskDialogs { owner };
        KillFlow {
            killer: &WindowsKiller,
            dialogs: &dialogs,
            self_pid: std::process::id(),
            current_user,
        }
        .run(&flow_request)
    })
    .await?;

    if result.success {
        let event = state.history.record_kill(KillRecord {
            pid: request.pid,
            port: request.port,
            protocol: request.protocol.as_str().into(),
            process_name: result.process_name.clone().unwrap_or(request.process_name),
            method: match result.method {
                Some(StopMethod::Graceful) => "graceful".into(),
                _ => "force".into(),
            },
            tree: result.tree.unwrap_or(false),
        });
        let _ = app.emit("history:event", &event);
    }
    Ok(result)
}

// --- History ---

#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    options: Option<Value>,
) -> CommandResult<Vec<HistoryEvent>> {
    let options = validation::validate_history_list_options(options.as_ref())?;
    Ok(state.history.list(options.limit))
}

#[tauri::command]
pub async fn history_clear(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Value> {
    let owner = main_window_handle(&app);
    let response = run_blocking(move || {
        Dialogs::show(
            &TaskDialogs { owner },
            &DialogOptions {
                kind: DialogKind::Warning,
                title: "履歴の削除".into(),
                message: "ポートの使用履歴をすべて削除しますか？".into(),
                detail: "この操作は元に戻せません。".into(),
                buttons: vec!["キャンセル".into(), "削除する".into()],
                default_id: 0,
                cancel_id: 0,
                checkbox: None,
            },
        )
    })
    .await?;
    if response.response != 1 {
        return Ok(json!({ "cleared": false }));
    }
    state.history.clear()?;
    Ok(json!({ "cleared": true }))
}

// --- Favorites ---

#[tauri::command]
pub fn favorites_list(state: State<'_, AppState>) -> Vec<Favorite> {
    state.store.favorites()
}

#[tauri::command]
pub fn favorites_add(state: State<'_, AppState>, data: Option<Value>) -> CommandResult<Favorite> {
    state
        .store
        .add_favorite(validation::validate_favorite_input(data.as_ref())?)
}

#[tauri::command]
pub fn favorites_remove(state: State<'_, AppState>, id: Option<Value>) -> CommandResult<Value> {
    state
        .store
        .remove_favorite(&validation::validate_id(id.as_ref())?)
}

// --- Monitors ---

#[tauri::command]
pub fn monitors_list(state: State<'_, AppState>) -> Vec<Monitor> {
    state.store.monitors()
}

#[tauri::command]
pub fn monitors_add(state: State<'_, AppState>, data: Option<Value>) -> CommandResult<Monitor> {
    state
        .store
        .add_monitor(validation::validate_monitor_input(data.as_ref())?)
}

#[tauri::command]
pub fn monitors_update(
    state: State<'_, AppState>,
    id: Option<Value>,
    data: Option<Value>,
) -> CommandResult<Value> {
    let id = validation::validate_id(id.as_ref())?;
    let update = validation::validate_monitor_update(data.as_ref())?;
    state.store.update_monitor(&id, update)
}

#[tauri::command]
pub fn monitors_remove(state: State<'_, AppState>, id: Option<Value>) -> CommandResult<Value> {
    state
        .store
        .remove_monitor(&validation::validate_id(id.as_ref())?)
}

// --- Settings ---

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.store.settings()
}

/// 監視間隔が変わった場合は監視ループを再開して即時反映する
#[tauri::command]
pub fn settings_update(state: State<'_, AppState>, data: Option<Value>) -> CommandResult<Settings> {
    let update = validation::validate_settings_update(data.as_ref())?;
    let previous_interval = state.store.settings().monitor_interval_ms;
    let settings = state.store.update_settings(update)?;
    if settings.monitor_interval_ms != previous_interval {
        state.monitor_ticker.restart();
    }
    Ok(settings)
}
