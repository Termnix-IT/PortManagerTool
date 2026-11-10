//! ポート履歴の永続化（Electron 版と同じファイル形式）。
//! - イベントは1行1件のJSONL（追記のみで済むため、件数が増えてもファイル全体を書き直さない）
//! - 前回検出した待受の一覧（スナップショット）は、アプリ再起動後の差分検出に使う

use crate::store::write_atomic;
use crate::timefmt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use time::{Duration, OffsetDateTime};

pub const EVENTS_FILE: &str = "port-history.jsonl";
pub const SNAPSHOT_FILE: &str = "port-history-snapshot.json";
const DEFAULT_MAX_EVENTS: usize = 2000;
const DEFAULT_RETENTION_DAYS: i64 = 30;

fn tcp() -> String {
    "TCP".into()
}

/// 履歴の1件。種別（started/stopped/killed）によって持つ項目が違うため、任意項目は Option にする
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub at: String,
    #[serde(default = "tcp")]
    pub protocol: String,
    /// アプリからの停止でポートが不明な場合は null
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addresses: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_line: Option<String>,
    /// startup（起動時の比較）/ poll（定期確認）/ app（アプリから停止）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// スナップショットに保存する待受（IPv4/IPv6 をまとめたもの）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerEntry {
    pub port: u16,
    pub pid: u32,
    #[serde(default)]
    pub process_name: String,
    #[serde(default)]
    pub process_started_at: Option<String>,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub category_label: String,
    #[serde(default)]
    pub addresses: Vec<String>,
    #[serde(default)]
    pub command_line: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile<'a> {
    saved_at: String,
    listeners: &'a [ListenerEntry],
}

#[derive(Deserialize)]
struct SnapshotFileIn {
    listeners: Option<Vec<ListenerEntry>>,
}

pub trait HistoryStore: Send + Sync {
    /// 保持期間・件数を超えた分と壊れた行を除いて読む
    fn load_events(&self) -> Vec<HistoryEvent>;
    fn append_events(&self, events: &[HistoryEvent]) -> Result<(), String>;
    /// 無い・壊れている場合は None（前回の状態が不明）
    fn load_snapshot(&self) -> Option<Vec<ListenerEntry>>;
    fn save_snapshot(&self, listeners: &[ListenerEntry]) -> Result<(), String>;
    fn clear_events(&self) -> Result<(), String>;
}

pub struct HistoryStorage {
    pub dir: PathBuf,
    pub max_events: usize,
    pub retention_days: i64,
    pub now: Box<dyn Fn() -> OffsetDateTime + Send + Sync>,
}

impl HistoryStorage {
    pub fn new(dir: &Path) -> Self {
        HistoryStorage {
            dir: dir.to_path_buf(),
            max_events: DEFAULT_MAX_EVENTS,
            retention_days: DEFAULT_RETENTION_DAYS,
            now: Box::new(OffsetDateTime::now_utc),
        }
    }

    pub fn events_path(&self) -> PathBuf {
        self.dir.join(EVENTS_FILE)
    }

    fn snapshot_path(&self) -> PathBuf {
        self.dir.join(SNAPSHOT_FILE)
    }

    fn write_all(&self, events: &[HistoryEvent]) -> Result<(), String> {
        let mut body = String::new();
        for event in events {
            body.push_str(&serde_json::to_string(event).map_err(|err| err.to_string())?);
            body.push('\n');
        }
        write_atomic(&self.events_path(), body.as_bytes())
            .map_err(|err| format!("履歴を保存できませんでした: {err}"))
    }
}

impl HistoryStore for HistoryStorage {
    fn load_events(&self) -> Vec<HistoryEvent> {
        let text = match fs::read_to_string(self.events_path()) {
            Ok(text) => text,
            Err(err) => {
                if err.kind() != io::ErrorKind::NotFound {
                    eprintln!("[history] 履歴を読めませんでした: {err}");
                }
                return Vec::new();
            }
        };
        let lines: Vec<&str> = text
            .split('\n')
            .filter(|line| !line.trim().is_empty())
            .collect();
        // 壊れた行（書き込み途中の終了など）は捨てる
        let parsed: Vec<HistoryEvent> = lines
            .iter()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let cutoff = (self.now)() - Duration::days(self.retention_days);
        let mut kept: Vec<HistoryEvent> = parsed
            .into_iter()
            .filter(|event| timefmt::parse_iso(&event.at).is_some_and(|at| at >= cutoff))
            .collect();
        if kept.len() > self.max_events {
            kept.drain(..kept.len() - self.max_events);
        }
        if kept.len() != lines.len() {
            if let Err(err) = self.write_all(&kept) {
                eprintln!("[history] {err}");
            }
        }
        kept
    }

    fn append_events(&self, events: &[HistoryEvent]) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        let mut body = String::new();
        for event in events {
            body.push_str(&serde_json::to_string(event).map_err(|err| err.to_string())?);
            body.push('\n');
        }
        let append = || -> io::Result<()> {
            fs::create_dir_all(&self.dir)?;
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.events_path())?;
            file.write_all(body.as_bytes())
        };
        append().map_err(|err| format!("履歴を保存できませんでした: {err}"))
    }

    fn load_snapshot(&self) -> Option<Vec<ListenerEntry>> {
        let text = fs::read_to_string(self.snapshot_path()).ok()?;
        serde_json::from_str::<SnapshotFileIn>(&text)
            .ok()?
            .listeners
    }

    fn save_snapshot(&self, listeners: &[ListenerEntry]) -> Result<(), String> {
        let file = SnapshotFile {
            saved_at: timefmt::to_iso_millis((self.now)()),
            listeners,
        };
        let body = serde_json::to_vec(&file).map_err(|err| err.to_string())?;
        write_atomic(&self.snapshot_path(), &body)
            .map_err(|err| format!("履歴を保存できませんでした: {err}"))
    }

    fn clear_events(&self) -> Result<(), String> {
        self.write_all(&[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use time::macros::datetime;

    const NOW: OffsetDateTime = datetime!(2026-09-16 00:00:00 UTC);

    fn storage(dir: &Path, max_events: usize) -> HistoryStorage {
        HistoryStorage {
            dir: dir.to_path_buf(),
            max_events,
            retention_days: 30,
            now: Box::new(|| NOW),
        }
    }

    fn days_ago(days: i64) -> String {
        timefmt::to_iso_millis(NOW - Duration::days(days))
    }

    fn event(id: &str, at: String) -> HistoryEvent {
        HistoryEvent {
            id: id.into(),
            kind: "started".into(),
            at,
            protocol: "TCP".into(),
            ..Default::default()
        }
    }

    fn ids(events: &[HistoryEvent]) -> Vec<&str> {
        events.iter().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn appends_jsonl_and_reads_back_in_order() {
        let dir = TempDir::new();
        let storage = storage(&dir.path().join("nested"), 2000);
        assert!(storage.load_events().is_empty(), "ファイルが無ければ空");
        storage.append_events(&[event("1", days_ago(1))]).unwrap();
        storage
            .append_events(&[event("2", days_ago(0)), event("3", days_ago(0))])
            .unwrap();
        assert_eq!(ids(&storage.load_events()), vec!["1", "2", "3"]);
        assert_eq!(
            fs::read_to_string(storage.events_path())
                .unwrap()
                .trim()
                .split('\n')
                .count(),
            3
        );
    }

    #[test]
    fn drops_expired_excess_and_broken_lines_and_rewrites_file() {
        let dir = TempDir::new();
        let storage = storage(dir.path(), 2);
        let line = |id: &str, days: i64| serde_json::to_string(&event(id, days_ago(days))).unwrap();
        fs::write(
            storage.events_path(),
            [
                line("old", 31),
                "{\"id\":\"broken\"".into(),
                line("a", 3),
                line("b", 2),
                line("c", 1),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(ids(&storage.load_events()), vec!["b", "c"]);
        let rewritten: Vec<String> = fs::read_to_string(storage.events_path())
            .unwrap()
            .trim()
            .split('\n')
            .map(|l| serde_json::from_str::<HistoryEvent>(l).unwrap().id)
            .collect();
        assert_eq!(rewritten, vec!["b", "c"]);
    }

    #[test]
    fn reads_events_written_by_the_electron_version() {
        let dir = TempDir::new();
        let storage = storage(dir.path(), 2000);
        let line = r#"{"id":"1789516800000-1","type":"killed","at":"2026-09-15T00:00:00.000Z","protocol":"TCP","port":null,"pid":10,"processName":"node.exe","method":"force","tree":true,"detection":"app"}"#;
        fs::write(storage.events_path(), format!("{line}\n")).unwrap();
        let events = storage.load_events();
        assert_eq!(events[0].port, None);
        assert_eq!(events[0].tree, Some(true));
        let value = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(
            value,
            serde_json::from_str::<Value>(line).unwrap(),
            "書き戻しても同じ内容"
        );
    }

    #[test]
    fn snapshot_round_trip_and_broken_file_is_none() {
        let dir = TempDir::new();
        let storage = storage(dir.path(), 2000);
        assert_eq!(storage.load_snapshot(), None);
        let entry = ListenerEntry {
            port: 5173,
            pid: 100,
            ..Default::default()
        };
        storage.save_snapshot(std::slice::from_ref(&entry)).unwrap();
        assert_eq!(storage.load_snapshot(), Some(vec![entry]));
        fs::write(dir.path().join(SNAPSHOT_FILE), "{broken").unwrap();
        assert_eq!(storage.load_snapshot(), None);
    }

    #[test]
    fn clear_events_empties_history() {
        let dir = TempDir::new();
        let storage = storage(dir.path(), 2000);
        storage.append_events(&[event("1", days_ago(0))]).unwrap();
        storage.clear_events().unwrap();
        assert!(storage.load_events().is_empty());
    }
}
