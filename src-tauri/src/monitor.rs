//! 登録したポートの定期確認。前回の状態（lastKnownState）との差分で使用開始/解放を検出する。

use crate::scanner::PortCheck;
use crate::store::{Monitor, PortState, Store};
use crate::validation::Protocol;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub trait MonitorStore: Send + Sync {
    fn monitors(&self) -> Vec<Monitor>;
    fn set_monitor_state(&self, id: &str, state: PortState) -> Result<(), String>;
}

impl MonitorStore for Store {
    fn monitors(&self) -> Vec<Monitor> {
        Store::monitors(self)
    }

    fn set_monitor_state(&self, id: &str, state: PortState) -> Result<(), String> {
        Store::set_monitor_state(self, id, state)
    }
}

pub type PortChecker =
    dyn Fn(&[(Protocol, u16)]) -> Result<HashMap<(Protocol, u16), PortCheck>, String> + Send + Sync;

/// renderer へ送る状態変化（`monitor:status-changed`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusChange {
    pub monitor_id: String,
    pub port: u16,
    pub label: String,
    pub old_state: PortState,
    pub new_state: PortState,
    pub process_name: String,
    pub pid: u32,
}

#[derive(Debug, Default)]
pub struct TickOutcome {
    /// 通知が有効な状態変化だけが入る
    pub changes: Vec<StatusChange>,
    /// 連続失敗の初回だけ入る（ログやUIを埋めないため）
    pub error: Option<String>,
}

pub struct PortMonitor {
    store: Arc<dyn MonitorStore>,
    check: Box<PortChecker>,
    running: Mutex<()>,
    failing: AtomicBool,
}

impl PortMonitor {
    pub fn new(store: Arc<dyn MonitorStore>, check: Box<PortChecker>) -> Self {
        PortMonitor {
            store,
            check,
            running: Mutex::new(()),
            failing: AtomicBool::new(false),
        }
    }

    pub fn tick(&self) -> TickOutcome {
        // 前回の確認が終わる前の呼び出しはスキップする
        let Ok(_running) = self.running.try_lock() else {
            return TickOutcome::default();
        };

        let monitors: Vec<Monitor> = self
            .store
            .monitors()
            .into_iter()
            .filter(|m| m.enabled)
            .collect();
        if monitors.is_empty() {
            return TickOutcome::default();
        }
        let targets: Vec<(Protocol, u16)> = monitors.iter().map(|m| (m.protocol, m.port)).collect();
        let results = match (self.check)(&targets) {
            Ok(results) => results,
            Err(err) => {
                // 取得失敗時は状態を更新しない。空き扱いにすると誤った「解放」通知が出る
                let first_failure = !self.failing.swap(true, Ordering::SeqCst);
                return TickOutcome {
                    changes: vec![],
                    error: first_failure.then_some(err),
                };
            }
        };
        self.failing.store(false, Ordering::SeqCst);

        let mut changes = Vec::new();
        for monitor in monitors {
            let Some(info) = results.get(&(monitor.protocol, monitor.port)) else {
                continue;
            };
            let new_state = if info.occupied {
                PortState::Occupied
            } else {
                PortState::Free
            };
            if new_state == monitor.last_known_state {
                continue;
            }
            if let Err(err) = self.store.set_monitor_state(&monitor.id, new_state) {
                eprintln!("[monitor] {err}");
            }
            let should_notify = match new_state {
                PortState::Occupied => monitor.notify_on_occupied,
                PortState::Free => monitor.notify_on_freed,
            };
            if should_notify {
                changes.push(StatusChange {
                    monitor_id: monitor.id,
                    port: monitor.port,
                    label: monitor.label,
                    old_state: monitor.last_known_state,
                    new_state,
                    process_name: info.process_name.clone(),
                    pid: info.pid,
                });
            }
        }
        TickOutcome {
            changes,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[derive(Default)]
    struct FakeStore(Mutex<Vec<Monitor>>);

    impl MonitorStore for FakeStore {
        fn monitors(&self) -> Vec<Monitor> {
            self.0.lock().unwrap().clone()
        }
        fn set_monitor_state(&self, id: &str, state: PortState) -> Result<(), String> {
            let mut monitors = self.0.lock().unwrap();
            if let Some(monitor) = monitors.iter_mut().find(|m| m.id == id) {
                monitor.last_known_state = state;
            }
            Ok(())
        }
    }

    fn base_monitor() -> Monitor {
        Monitor {
            id: "mon_1".into(),
            port: 3000,
            protocol: Protocol::Tcp,
            label: "Next.js".into(),
            enabled: true,
            notify_on_occupied: true,
            notify_on_freed: true,
            last_known_state: PortState::Free,
            extra: Map::new(),
        }
    }

    fn occupied() -> HashMap<(Protocol, u16), PortCheck> {
        HashMap::from([(
            (Protocol::Tcp, 3000),
            PortCheck {
                occupied: true,
                process_name: "node".into(),
                pid: 100,
            },
        )])
    }

    fn monitor_with(monitor: Monitor, check: Box<PortChecker>) -> (PortMonitor, Arc<FakeStore>) {
        let store = Arc::new(FakeStore(Mutex::new(vec![monitor])));
        (PortMonitor::new(store.clone(), check), store)
    }

    fn state_of(store: &FakeStore) -> PortState {
        store.0.lock().unwrap()[0].last_known_state
    }

    #[test]
    fn state_change_updates_store_and_notifies() {
        let (monitor, store) = monitor_with(base_monitor(), Box::new(|_| Ok(occupied())));
        let outcome = monitor.tick();
        assert_eq!(state_of(&store), PortState::Occupied);
        assert_eq!(outcome.changes.len(), 1);
        assert_eq!(outcome.changes[0].old_state, PortState::Free);
        assert_eq!(outcome.changes[0].new_state, PortState::Occupied);
        assert_eq!(outcome.changes[0].pid, 100);
        let value = serde_json::to_value(&outcome.changes[0]).unwrap();
        assert_eq!(value["monitorId"], "mon_1");
        assert_eq!(value["newState"], "occupied");
    }

    #[test]
    fn unchanged_state_is_not_notified() {
        let current = Monitor {
            last_known_state: PortState::Occupied,
            ..base_monitor()
        };
        let (monitor, _) = monitor_with(current, Box::new(|_| Ok(occupied())));
        assert!(monitor.tick().changes.is_empty());
    }

    #[test]
    fn disabled_direction_updates_state_without_notification() {
        let quiet = Monitor {
            notify_on_occupied: false,
            ..base_monitor()
        };
        let (monitor, store) = monitor_with(quiet, Box::new(|_| Ok(occupied())));
        assert!(monitor.tick().changes.is_empty());
        assert_eq!(state_of(&store), PortState::Occupied);
    }

    #[test]
    fn failure_keeps_state_and_reports_once() {
        let current = Monitor {
            last_known_state: PortState::Occupied,
            ..base_monitor()
        };
        let (monitor, store) = monitor_with(current, Box::new(|_| Err("timeout".into())));
        let first = monitor.tick();
        let second = monitor.tick();
        assert_eq!(state_of(&store), PortState::Occupied);
        assert!(first.changes.is_empty());
        assert_eq!(first.error.as_deref(), Some("timeout"));
        assert_eq!(second.error, None, "連続失敗中のエラー通知は1回だけ");
    }

    #[test]
    fn failure_after_recovery_is_reported_again() {
        let fail = Arc::new(AtomicBool::new(true));
        let flag = fail.clone();
        let (monitor, _) = monitor_with(
            base_monitor(),
            Box::new(move |_| {
                if flag.load(Ordering::SeqCst) {
                    Err("failed".into())
                } else {
                    Ok(occupied())
                }
            }),
        );
        let mut errors = 0;
        errors += usize::from(monitor.tick().error.is_some());
        fail.store(false, Ordering::SeqCst);
        errors += usize::from(monitor.tick().error.is_some());
        fail.store(true, Ordering::SeqCst);
        errors += usize::from(monitor.tick().error.is_some());
        assert_eq!(errors, 2);
    }

    #[test]
    fn overlapping_tick_is_skipped() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let counter = calls.clone();
        let (monitor, _) = monitor_with(
            base_monitor(),
            Box::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                let _ = release_rx.lock().unwrap().recv();
                Ok(occupied())
            }),
        );
        let monitor = Arc::new(monitor);
        let first = {
            let monitor = monitor.clone();
            thread::spawn(move || monitor.tick())
        };
        while calls.load(Ordering::SeqCst) == 0 {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(monitor.tick().changes.is_empty());
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap().changes.len(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn no_enabled_monitors_means_no_check() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let disabled = Monitor {
            enabled: false,
            ..base_monitor()
        };
        let (monitor, _) = monitor_with(
            disabled,
            Box::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(HashMap::new())
            }),
        );
        monitor.tick();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
