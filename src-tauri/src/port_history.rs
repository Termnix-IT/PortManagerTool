//! ポートの使用開始・解放を検出して履歴に残す。

use crate::classifier::normalize_process_name;
use crate::history_storage::{HistoryEvent, HistoryStore, ListenerEntry};
use crate::scanner::{self, Listener};
use crate::system::SystemInfo;
use crate::timefmt;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use time::OffsetDateTime;

const LIST_LIMIT: usize = 500;
const MEMORY_LIMIT: usize = 2000;

pub trait ListenerSource: Send + Sync {
    /// 失敗時はエラー（解放と誤認しないため、空一覧にしない）
    fn scan_tcp_listeners(&self) -> Result<Vec<Listener>, String>;
    fn command_lines(&self, pids: &[u32]) -> Result<HashMap<u32, String>, String>;
}

pub struct SystemListenerSource(pub Arc<dyn SystemInfo>);

impl ListenerSource for SystemListenerSource {
    fn scan_tcp_listeners(&self) -> Result<Vec<Listener>, String> {
        scanner::scan_tcp_listeners(self.0.as_ref())
    }

    fn command_lines(&self, pids: &[u32]) -> Result<HashMap<u32, String>, String> {
        Ok(scanner::command_lines(self.0.as_ref(), pids))
    }
}

/// 同じプロセスが IPv4/IPv6 の両方で待ち受けても1件として扱う。
/// PID は再利用されるため、プロセス開始時刻も含めて区別する
pub fn listener_key(port: u16, pid: u32, started_at: Option<&str>) -> String {
    format!("{port}:{pid}:{}", started_at.unwrap_or(""))
}

fn entry_key(entry: &ListenerEntry) -> String {
    listener_key(entry.port, entry.pid, entry.process_started_at.as_deref())
}

/// 常駐するOSのサービスは履歴に残しても役に立たないため対象外にする
fn should_track(listener: &Listener) -> bool {
    if listener.pid == 0 || listener.pid == 4 {
        return false;
    }
    !matches!(
        normalize_process_name(&listener.process_name).as_str(),
        "system" | "idle" | "svchost" | "lsass" | "wininit" | "services" | "spoolsv"
    )
}

/// 挿入順を保つ待受の一覧（検出順にイベントを並べるため）
#[derive(Clone, Default)]
struct Listeners {
    entries: Vec<(String, ListenerEntry)>,
    index: HashMap<String, usize>,
}

impl Listeners {
    fn from_entries(entries: Vec<ListenerEntry>) -> Self {
        let mut result = Listeners::default();
        for entry in entries {
            let key = entry_key(&entry);
            if !result.index.contains_key(&key) {
                result.index.insert(key.clone(), result.entries.len());
                result.entries.push((key, entry));
            }
        }
        result
    }

    fn from_scan(scanned: Vec<Listener>) -> Self {
        let mut result = Listeners::default();
        for listener in scanned.into_iter().filter(should_track) {
            let key = listener_key(
                listener.port,
                listener.pid,
                listener.process_started_at.as_deref(),
            );
            if let Some(&position) = result.index.get(&key) {
                let addresses = &mut result.entries[position].1.addresses;
                if !addresses.contains(&listener.local_address) {
                    addresses.push(listener.local_address);
                }
                continue;
            }
            let addresses = if listener.local_address.is_empty() {
                vec![]
            } else {
                vec![listener.local_address]
            };
            result.index.insert(key.clone(), result.entries.len());
            result.entries.push((
                key,
                ListenerEntry {
                    port: listener.port,
                    pid: listener.pid,
                    process_name: listener.process_name,
                    process_started_at: listener.process_started_at,
                    category: listener.category,
                    category_label: listener.category_label,
                    addresses,
                    command_line: String::new(),
                },
            ));
        }
        result
    }

    fn get(&self, key: &str) -> Option<&ListenerEntry> {
        self.index.get(key).map(|&i| &self.entries[i].1)
    }

    fn contains(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    fn values(&self) -> Vec<ListenerEntry> {
        self.entries
            .iter()
            .map(|(_, entry)| entry.clone())
            .collect()
    }
}

#[derive(Debug, Default)]
pub struct PollOutcome {
    pub events: Vec<HistoryEvent>,
    /// 連続失敗の初回だけ入る（ログを埋めないため）
    pub error: Option<String>,
}

pub struct KillRecord {
    pub pid: u32,
    pub port: Option<u16>,
    pub protocol: String,
    pub process_name: String,
    pub method: String,
    pub tree: bool,
}

struct State {
    events: Vec<HistoryEvent>,
    /// このセッションで最後に検出した待受。None は起動後まだ検出していない
    previous: Option<Listeners>,
    sequence: u64,
    failing: bool,
}

pub struct PortHistory {
    source: Box<dyn ListenerSource>,
    storage: Box<dyn HistoryStore>,
    now: Box<dyn Fn() -> OffsetDateTime + Send + Sync>,
    state: Mutex<State>,
    polling: Mutex<()>,
}

impl PortHistory {
    pub fn new(source: Box<dyn ListenerSource>, storage: Box<dyn HistoryStore>) -> Self {
        Self::with_clock(source, storage, Box::new(OffsetDateTime::now_utc))
    }

    pub fn with_clock(
        source: Box<dyn ListenerSource>,
        storage: Box<dyn HistoryStore>,
        now: Box<dyn Fn() -> OffsetDateTime + Send + Sync>,
    ) -> Self {
        let events = storage.load_events();
        PortHistory {
            source,
            storage,
            now,
            state: Mutex::new(State {
                events,
                previous: None,
                sequence: 0,
                failing: false,
            }),
            polling: Mutex::new(()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn create_event(&self, state: &mut State, kind: &str, fields: HistoryEvent) -> HistoryEvent {
        state.sequence += 1;
        let at = (self.now)();
        HistoryEvent {
            id: format!("{}-{}", timefmt::unix_millis(at), state.sequence),
            kind: kind.into(),
            at: timefmt::to_iso_millis(at),
            ..fields
        }
    }

    fn record(&self, state: &mut State, new_events: &[HistoryEvent]) {
        if new_events.is_empty() {
            return;
        }
        if let Err(err) = self.storage.append_events(new_events) {
            eprintln!("[history] {err}");
        }
        // ファイル側の件数上限は次回起動時の読み込みで整理される。メモリ上も同じ上限で保つ
        state.events.extend_from_slice(new_events);
        if state.events.len() > MEMORY_LIMIT {
            let excess = state.events.len() - MEMORY_LIMIT;
            state.events.drain(..excess);
        }
    }

    fn event_fields(entry: &ListenerEntry, detection: &str) -> HistoryEvent {
        HistoryEvent {
            protocol: "TCP".into(),
            port: Some(entry.port),
            pid: Some(entry.pid),
            process_name: Some(entry.process_name.clone()),
            process_started_at: entry.process_started_at.clone(),
            category: Some(entry.category.clone()),
            category_label: Some(entry.category_label.clone()),
            addresses: Some(entry.addresses.clone()),
            command_line: Some(entry.command_line.clone()),
            detection: Some(detection.into()),
            ..Default::default()
        }
    }

    /// 1回分の検出。
    /// - 起動後初回は前回保存したスナップショットと比較する（detection: startup）
    /// - スナップショットが無い初回起動時は、既存の待受を「起動時に検出」として記録する
    pub fn poll(&self) -> PollOutcome {
        let Ok(_polling) = self.polling.try_lock() else {
            return PollOutcome::default();
        };

        let scanned = match self.source.scan_tcp_listeners() {
            Ok(scanned) => scanned,
            Err(err) => {
                let mut state = self.lock();
                let first_failure = !state.failing;
                state.failing = true;
                return PollOutcome {
                    events: vec![],
                    error: first_failure.then_some(err),
                };
            }
        };

        let previous = {
            let mut state = self.lock();
            state.failing = false;
            state.previous.clone()
        };
        let mut current = Listeners::from_scan(scanned);
        let is_first_poll = previous.is_none();
        let baseline = previous.unwrap_or_else(|| {
            Listeners::from_entries(self.storage.load_snapshot().unwrap_or_default())
        });
        let detection = if is_first_poll { "startup" } else { "poll" };

        // 継続中の待受は前回取得したコマンドラインを引き継ぎ、新しいものだけ問い合わせる
        let mut started_keys = Vec::new();
        for (key, entry) in &mut current.entries {
            match baseline.get(key) {
                Some(known) => entry.command_line = known.command_line.clone(),
                None => started_keys.push(key.clone()),
            }
        }
        let started_set: HashSet<&String> = started_keys.iter().collect();
        if !started_keys.is_empty() {
            let pids: Vec<u32> = current
                .entries
                .iter()
                .filter(|(key, _)| started_set.contains(key))
                .map(|(_, entry)| entry.pid)
                .collect();
            // コマンドラインが取れなくても使用開始の記録は残す
            if let Ok(lines) = self.source.command_lines(&pids) {
                for (key, entry) in &mut current.entries {
                    if started_set.contains(key) {
                        entry.command_line = lines.get(&entry.pid).cloned().unwrap_or_default();
                    }
                }
            }
        }

        let stopped: Vec<&ListenerEntry> = baseline
            .entries
            .iter()
            .filter(|(key, _)| !current.contains(key))
            .map(|(_, entry)| entry)
            .collect();
        let started: Vec<&ListenerEntry> = current
            .entries
            .iter()
            .filter(|(key, _)| started_set.contains(key))
            .map(|(_, entry)| entry)
            .collect();

        let mut state = self.lock();
        let mut new_events = Vec::new();
        for entry in stopped {
            let event =
                self.create_event(&mut state, "stopped", Self::event_fields(entry, detection));
            new_events.push(event);
        }
        for entry in started {
            let event =
                self.create_event(&mut state, "started", Self::event_fields(entry, detection));
            new_events.push(event);
        }

        // 変化が無ければ書き込まない（10秒ごとのディスク書き込みを避ける）
        if is_first_poll || !new_events.is_empty() {
            if let Err(err) = self.storage.save_snapshot(&current.values()) {
                eprintln!("[history] {err}");
            }
        }
        state.previous = Some(current);
        self.record(&mut state, &new_events);
        PollOutcome {
            events: new_events,
            error: None,
        }
    }

    /// アプリから停止したことを記録する（停止フローの成功結果）
    pub fn record_kill(&self, kill: KillRecord) -> HistoryEvent {
        let mut state = self.lock();
        let event = self.create_event(
            &mut state,
            "killed",
            HistoryEvent {
                protocol: kill.protocol,
                port: kill.port,
                pid: Some(kill.pid),
                process_name: Some(kill.process_name),
                method: Some(kill.method),
                tree: Some(kill.tree),
                detection: Some("app".into()),
                ..Default::default()
            },
        );
        self.record(&mut state, std::slice::from_ref(&event));
        event
    }

    /// 新しい順
    pub fn list(&self, limit: Option<usize>) -> Vec<HistoryEvent> {
        let limit = limit.unwrap_or(LIST_LIMIT);
        let state = self.lock();
        state.events.iter().rev().take(limit).cloned().collect()
    }

    pub fn clear(&self) -> Result<(), String> {
        let mut state = self.lock();
        self.storage.clear_events()?;
        state.events.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use time::macros::datetime;

    #[derive(Default)]
    struct MemoryState {
        events: Vec<HistoryEvent>,
        snapshot: Option<Vec<ListenerEntry>>,
        snapshot_writes: usize,
    }

    #[derive(Clone, Default)]
    struct MemoryStorage(Arc<Mutex<MemoryState>>);

    impl HistoryStore for MemoryStorage {
        fn load_events(&self) -> Vec<HistoryEvent> {
            self.0.lock().unwrap().events.clone()
        }
        fn append_events(&self, events: &[HistoryEvent]) -> Result<(), String> {
            self.0.lock().unwrap().events.extend_from_slice(events);
            Ok(())
        }
        fn load_snapshot(&self) -> Option<Vec<ListenerEntry>> {
            self.0.lock().unwrap().snapshot.clone()
        }
        fn save_snapshot(&self, listeners: &[ListenerEntry]) -> Result<(), String> {
            let mut state = self.0.lock().unwrap();
            state.snapshot = Some(listeners.to_vec());
            state.snapshot_writes += 1;
            Ok(())
        }
        fn clear_events(&self) -> Result<(), String> {
            self.0.lock().unwrap().events.clear();
            Ok(())
        }
    }

    struct FakeSource {
        scans: Mutex<VecDeque<Result<Vec<Listener>, String>>>,
        command_lines: HashMap<u32, String>,
        fail_command_lines: bool,
        calls: Arc<Mutex<Vec<Vec<u32>>>>,
    }

    impl ListenerSource for FakeSource {
        fn scan_tcp_listeners(&self) -> Result<Vec<Listener>, String> {
            self.scans
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(vec![]))
        }
        fn command_lines(&self, pids: &[u32]) -> Result<HashMap<u32, String>, String> {
            self.calls.lock().unwrap().push(pids.to_vec());
            if self.fail_command_lines {
                return Err("access denied".into());
            }
            Ok(pids
                .iter()
                .map(|pid| {
                    (
                        *pid,
                        self.command_lines.get(pid).cloned().unwrap_or_default(),
                    )
                })
                .collect())
        }
    }

    fn listener(
        port: u16,
        pid: u32,
        name: &str,
        started_at: Option<&str>,
        address: &str,
        label: &str,
    ) -> Listener {
        Listener {
            port,
            pid,
            process_name: name.into(),
            process_started_at: started_at.map(String::from),
            local_address: address.into(),
            category: if label.is_empty() {
                String::new()
            } else {
                "dev".into()
            },
            category_label: label.into(),
        }
    }

    fn vite() -> Listener {
        listener(
            5173,
            100,
            "node",
            Some("2026-09-16T01:00:00Z"),
            "::1",
            "Vite",
        )
    }
    fn vite_v4() -> Listener {
        Listener {
            local_address: "127.0.0.1".into(),
            ..vite()
        }
    }
    fn django() -> Listener {
        listener(
            8000,
            200,
            "python",
            Some("2026-09-16T02:00:00Z"),
            "0.0.0.0",
            "Django / FastAPI",
        )
    }
    fn svchost() -> Listener {
        listener(135, 900, "svchost", None, "0.0.0.0", "")
    }

    fn to_entry(listener: &Listener, command_line: &str) -> ListenerEntry {
        ListenerEntry {
            port: listener.port,
            pid: listener.pid,
            process_name: listener.process_name.clone(),
            process_started_at: listener.process_started_at.clone(),
            category: listener.category.clone(),
            category_label: listener.category_label.clone(),
            addresses: vec![listener.local_address.clone()],
            command_line: command_line.into(),
        }
    }

    struct Setup {
        history: PortHistory,
        storage: MemoryStorage,
        calls: Arc<Mutex<Vec<Vec<u32>>>>,
    }

    fn setup(scans: Vec<Result<Vec<Listener>, String>>, storage: MemoryStorage) -> Setup {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let source = FakeSource {
            scans: Mutex::new(scans.into()),
            command_lines: HashMap::from([
                (100, "node vite".into()),
                (200, "python manage.py runserver".into()),
            ]),
            fail_command_lines: false,
            calls: calls.clone(),
        };
        let history = PortHistory::with_clock(
            Box::new(source),
            Box::new(storage.clone()),
            Box::new(|| datetime!(2026-09-16 03:00:00 UTC)),
        );
        Setup {
            history,
            storage,
            calls,
        }
    }

    fn summary(events: &[HistoryEvent]) -> Vec<(String, u16, String)> {
        events
            .iter()
            .map(|e| {
                (
                    e.kind.clone(),
                    e.port.unwrap_or(0),
                    e.detection.clone().unwrap_or_default(),
                )
            })
            .collect()
    }

    fn s(kind: &str, port: u16, detection: &str) -> (String, u16, String) {
        (kind.into(), port, detection.into())
    }

    #[test]
    fn first_launch_records_existing_listeners_as_startup() {
        let Setup {
            history, storage, ..
        } = setup(
            vec![Ok(vec![vite(), vite_v4(), svchost()])],
            MemoryStorage::default(),
        );
        let events = history.poll().events;
        assert_eq!(events.len(), 1, "IPv4/IPv6 の重複と svchost は除外");
        assert_eq!(summary(&events), vec![s("started", 5173, "startup")]);
        assert_eq!(events[0].command_line.as_deref(), Some("node vite"));
        assert_eq!(
            events[0].addresses,
            Some(vec!["::1".into(), "127.0.0.1".into()])
        );
        let state = storage.0.lock().unwrap();
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.snapshot.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn later_polls_record_differences_and_query_only_new_command_lines() {
        let Setup { history, calls, .. } = setup(
            vec![
                Ok(vec![vite()]),
                Ok(vec![vite(), django()]),
                Ok(vec![django()]),
            ],
            MemoryStorage::default(),
        );
        history.poll();
        let second = history.poll().events;
        let third = history.poll().events;
        assert_eq!(summary(&second), vec![s("started", 8000, "poll")]);
        assert_eq!(
            second[0].command_line.as_deref(),
            Some("python manage.py runserver")
        );
        assert_eq!(summary(&third), vec![s("stopped", 5173, "poll")]);
        assert_eq!(
            third[0].command_line.as_deref(),
            Some("node vite"),
            "解放時は検出済みのコマンドラインを残す"
        );
        assert_eq!(*calls.lock().unwrap(), vec![vec![100], vec![200]]);
    }

    #[test]
    fn restart_compares_with_saved_snapshot() {
        let storage = MemoryStorage::default();
        storage.0.lock().unwrap().snapshot = Some(vec![to_entry(&vite(), "node vite")]);
        let Setup { history, .. } = setup(vec![Ok(vec![vite(), django()])], storage);
        assert_eq!(
            summary(&history.poll().events),
            vec![s("started", 8000, "startup")]
        );
    }

    #[test]
    fn listeners_released_while_closed_are_recorded_at_startup() {
        let storage = MemoryStorage::default();
        storage.0.lock().unwrap().snapshot =
            Some(vec![to_entry(&django(), "python manage.py runserver")]);
        let Setup { history, .. } = setup(vec![Ok(vec![])], storage);
        assert_eq!(
            summary(&history.poll().events),
            vec![s("stopped", 8000, "startup")]
        );
    }

    #[test]
    fn same_pid_with_different_start_time_is_a_different_process() {
        let reused = Listener {
            process_name: "java".into(),
            process_started_at: Some("2026-09-16T02:30:00Z".into()),
            ..vite()
        };
        let Setup { history, .. } = setup(
            vec![Ok(vec![vite()]), Ok(vec![reused])],
            MemoryStorage::default(),
        );
        history.poll();
        let events = history.poll().events;
        let names: Vec<(String, String)> = events
            .iter()
            .map(|e| (e.kind.clone(), e.process_name.clone().unwrap()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("stopped".into(), "node".into()),
                ("started".into(), "java".into())
            ]
        );
    }

    #[test]
    fn scan_failure_records_nothing_and_reports_once() {
        let Setup {
            history, storage, ..
        } = setup(
            vec![
                Ok(vec![vite()]),
                Err("timeout".into()),
                Err("timeout".into()),
                Ok(vec![vite()]),
            ],
            MemoryStorage::default(),
        );
        history.poll();
        let first_failure = history.poll();
        let second_failure = history.poll();
        let recovered = history.poll();
        assert!(first_failure.events.is_empty());
        assert_eq!(first_failure.error.as_deref(), Some("timeout"));
        assert_eq!(second_failure.error, None, "連続失敗中は1回だけ");
        assert!(
            recovered.events.is_empty(),
            "失敗を「全ポート解放」と誤認しない"
        );
        assert_eq!(storage.0.lock().unwrap().events.len(), 1);
    }

    #[test]
    fn unchanged_listeners_do_not_rewrite_snapshot() {
        let Setup {
            history, storage, ..
        } = setup(
            vec![Ok(vec![vite()]), Ok(vec![vite()]), Ok(vec![vite()])],
            MemoryStorage::default(),
        );
        history.poll();
        history.poll();
        history.poll();
        assert_eq!(storage.0.lock().unwrap().snapshot_writes, 1);
    }

    #[test]
    fn records_start_even_without_command_line() {
        let source = FakeSource {
            scans: Mutex::new(VecDeque::from([Ok(vec![django()])])),
            command_lines: HashMap::new(),
            fail_command_lines: true,
            calls: Arc::new(Mutex::new(vec![])),
        };
        let history = PortHistory::new(Box::new(source), Box::new(MemoryStorage::default()));
        let events = history.poll().events;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].command_line.as_deref(), Some(""));
    }

    #[test]
    fn record_kill_list_and_clear() {
        let Setup {
            history, storage, ..
        } = setup(vec![Ok(vec![vite()])], MemoryStorage::default());
        history.poll();
        history.record_kill(KillRecord {
            pid: 100,
            port: Some(5173),
            protocol: "TCP".into(),
            process_name: "node.exe".into(),
            method: "force".into(),
            tree: true,
        });
        let listed = history.list(None);
        assert_eq!(
            listed.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            vec!["killed", "started"],
            "新しい順"
        );
        assert_eq!(listed[0].method.as_deref(), Some("force"));
        assert_eq!(listed[0].tree, Some(true));
        assert_ne!(listed[0].id, listed[1].id, "id は一意");
        assert_eq!(listed[0].id, "1789527600000-2");
        history.clear().unwrap();
        assert!(history.list(None).is_empty());
        assert!(storage.0.lock().unwrap().events.is_empty());
    }

    #[test]
    fn list_returns_saved_events_newest_first_with_limit() {
        let storage = MemoryStorage::default();
        storage.0.lock().unwrap().events = ["1", "2", "3"]
            .iter()
            .map(|id| HistoryEvent {
                id: (*id).into(),
                kind: "started".into(),
                ..Default::default()
            })
            .collect();
        let Setup { history, .. } = setup(vec![], storage);
        assert_eq!(
            history
                .list(Some(2))
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["3", "2"]
        );
    }
}
