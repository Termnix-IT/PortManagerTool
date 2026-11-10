//! Port Manager Tool（Windows 専用）。
//! renderer（`renderer/`）は表示のみを担当し、システム情報の取得・プロセス停止・保存はすべてこのクレートで行う。

#[cfg(not(windows))]
compile_error!("Port Manager Tool は Windows 専用です");

mod classifier;
mod command;
mod commands;
mod excluded_ports;
mod history_storage;
mod kill_flow;
mod killer;
mod monitor;
mod notify;
mod port_history;
mod process_safety;
mod scanner;
mod store;
mod system;
#[cfg(test)]
mod testutil;
mod ticker;
mod timefmt;
mod updater;
mod validation;
mod win;

use excluded_ports::ExcludedPortsProvider;
use history_storage::HistoryStorage;
use monitor::PortMonitor;
use port_history::{PortHistory, SystemListenerSource};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use store::Store;
use system::{SystemInfo, WindowsSystem};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{App, AppHandle, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use ticker::Ticker;
use updater::{UpdateManager, UpdateState};

/// tauri.conf.json の identifier と一致させる（トースト通知とタスクバーはこのIDでアプリを識別する）
pub const APP_ID: &str = "com.termnix-it.port-manager-tool";
/// tauri.conf.json の updater の endpoints と同じリポジトリ
pub const RELEASES_URL: &str = "https://github.com/Termnix-IT/PortManagerTool/releases";
/// 保存先のフォルダ名（%APPDATA% の下）。Electron 版と同じにして、お気に入り・監視・履歴を引き継ぐ
const DATA_DIR_NAME: &str = "port-manager-tool";
const HISTORY_INTERVAL: Duration = Duration::from_secs(10);
const MIN_MONITOR_INTERVAL_MS: u64 = 1000;

pub struct AppState {
    pub system: Arc<dyn SystemInfo>,
    pub excluded: Arc<ExcludedPortsProvider>,
    pub store: Arc<Store>,
    pub history: Arc<PortHistory>,
    pub monitor_ticker: Ticker,
    pub history_ticker: Ticker,
    pub updater: Arc<UpdateManager>,
    /// "DOMAIN\user"（停止対象が別ユーザーのプロセスかの判定に使う）
    pub current_user: Option<String>,
}

/// `--user-data-dir=<dir>`（または `--user-data-dir <dir>`）。
/// 動作確認で利用者の履歴・設定を汚さないための指定で、WebView のデータもその下に置く
fn user_data_dir_arg() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--user-data-dir=") {
            return Some(PathBuf::from(value));
        }
        if arg == "--user-data-dir" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

/// アプリ内のページ以外へ遷移させない。`tauri dev`（npm start）では開発サーバーのページも許可する
fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || dev_url.is_some_and(|dev| dev.origin() == url.origin())
}

fn create_main_window(app: &App, custom_data_dir: Option<&PathBuf>) -> tauri::Result<()> {
    let dev_url = app.config().build.dev_url.clone();
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("ポート管理ツール")
        .inner_size(1280.0, 760.0)
        .min_inner_size(900.0, 620.0)
        .background_color(Color(0x18, 0x18, 0x18, 0xff))
        // 読み込みが終わるまで表示しない（白い画面のちらつき防止）
        .visible(false)
        .on_navigation(move |url| is_app_url(url, dev_url.as_ref()))
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
            }
        });
    if let Some(dir) = custom_data_dir {
        builder = builder.data_directory(dir.join("webview"));
    }
    builder.build()?;
    Ok(())
}

fn setup(
    app: &mut App,
    custom_data_dir: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    win::shell::set_app_user_model_id(APP_ID);

    let data_dir = match &custom_data_dir {
        Some(dir) => dir.clone(),
        None => app.path().data_dir()?.join(DATA_DIR_NAME),
    };
    let is_installed = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(updater::is_installed))
        .unwrap_or(false);
    let notification_id = notify::notification_app_id(is_installed, APP_ID);

    let system: Arc<dyn SystemInfo> = Arc::new(WindowsSystem);
    let store = Arc::new(Store::open(&data_dir));
    let history = Arc::new(PortHistory::new(
        Box::new(SystemListenerSource(Arc::clone(&system))),
        Box::new(HistoryStorage::new(&data_dir.join("history"))),
    ));

    // --- Monitor ---
    let monitor = PortMonitor::new(store.clone(), {
        let system = Arc::clone(&system);
        Box::new(move |targets| scanner::check_ports(system.as_ref(), targets))
    });
    let monitor_ticker = Ticker::spawn(
        "monitor",
        false,
        {
            let store = Arc::clone(&store);
            move || {
                Duration::from_millis(
                    store
                        .settings()
                        .monitor_interval_ms
                        .max(MIN_MONITOR_INTERVAL_MS),
                )
            }
        },
        {
            let (handle, notification_id) = (handle.clone(), notification_id.clone());
            move || {
                let outcome = monitor.tick();
                if let Some(err) = outcome.error {
                    eprintln!("[monitor] ポート確認に失敗しました。状態は更新せず次回に再試行します: {err}");
                }
                for change in outcome.changes {
                    let _ = handle.emit("monitor:status-changed", &change);
                    let occupied = change.new_state == store::PortState::Occupied;
                    let title = format!(
                        "Port {} - {}",
                        change.port,
                        if occupied { "使用中" } else { "空き" }
                    );
                    let body = if occupied {
                        format!(
                            "{} - Process: {} (PID: {})",
                            change.label, change.process_name, change.pid
                        )
                    } else {
                        format!("{} が解放されました", change.label)
                    };
                    notify::show(&handle, &notification_id, &title, &body);
                }
            }
        },
    );

    // --- History ---
    let history_ticker = Ticker::spawn("history", true, || HISTORY_INTERVAL, {
        let (history, handle) = (Arc::clone(&history), handle.clone());
        move || {
            let outcome = history.poll();
            if let Some(err) = outcome.error {
                eprintln!("[history] 待受一覧の取得に失敗しました。履歴は記録せず次回に再試行します: {err}");
            }
            for event in outcome.events {
                let _ = handle.emit("history:event", &event);
            }
        }
    });

    // --- Updates ---
    let version = app.package_info().version.to_string();
    let updater = Arc::new(UpdateManager::new(
        updater::initial_status(&version, tauri::is_dev(), is_installed),
        {
            let (handle, notification_id) = (handle.clone(), notification_id.clone());
            Box::new(move |status| {
                let _ = handle.emit("updates:status", status);
                if status.state == UpdateState::Downloaded {
                    let body = format!(
                        "バージョン {} は、アプリの終了時または設定画面の「再起動して更新」でインストールされます",
                        status.latest_version.as_deref().unwrap_or("")
                    );
                    notify::show(
                        &handle,
                        &notification_id,
                        "アップデートの準備ができました",
                        &body,
                    );
                }
            })
        },
    ));
    if updater.is_supported() {
        let (updater, handle) = (Arc::clone(&updater), handle.clone());
        std::thread::spawn(move || {
            std::thread::sleep(updater::STARTUP_CHECK_DELAY);
            loop {
                tauri::async_runtime::block_on(updater.check(&handle));
                std::thread::sleep(updater::CHECK_INTERVAL);
            }
        });
    }

    app.manage(AppState {
        system,
        excluded: Arc::new(ExcludedPortsProvider::windows()),
        store,
        history,
        monitor_ticker,
        history_ticker,
        updater,
        current_user: win::process::current_user(),
    });

    create_main_window(app, custom_data_dir.as_ref())?;
    Ok(())
}

fn on_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.monitor_ticker.stop();
        state.history_ticker.stop();
        state.updater.install_on_exit();
    }
}

pub fn run() {
    let custom_data_dir = user_data_dir_arg();
    let mut builder = tauri::Builder::default();
    // 2つ目の起動は既存のウィンドウを前面に出して終了する（履歴ファイルへの同時書き込みを防ぐ）。
    // --user-data-dir 指定時は保存先が別なので、普段使いのアプリと同時に起動できるようにする
    if custom_data_dir.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            notify::focus_main_window(app);
        }));
    }
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| setup(app, custom_data_dir.clone()))
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_open_releases,
            commands::updates_get_status,
            commands::updates_check,
            commands::updates_install,
            commands::ports_scan,
            commands::ports_kill,
            commands::history_list,
            commands::history_clear,
            commands::favorites_list,
            commands::favorites_add,
            commands::favorites_remove,
            commands::monitors_list,
            commands::monitors_add,
            commands::monitors_update,
            commands::monitors_remove,
            commands::settings_get,
            commands::settings_update,
        ])
        .build(tauri::generate_context!())
        .expect("アプリを起動できませんでした")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                on_exit(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_app_pages_are_navigable() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(is_app_url(&url("http://tauri.localhost/index.html"), None));
        assert!(is_app_url(&url("tauri://localhost/index.html"), None));
        assert!(!is_app_url(&url("https://example.com/"), None));
        assert!(!is_app_url(
            &url("http://tauri.localhost.example.com/"),
            None
        ));
        assert!(!is_app_url(&url("http://127.0.0.1:1430/"), None));

        let dev = url("http://127.0.0.1:1430");
        assert!(is_app_url(
            &url("http://127.0.0.1:1430/index.html"),
            Some(&dev)
        ));
        assert!(!is_app_url(&url("http://127.0.0.1:8080/"), Some(&dev)));
    }
}
