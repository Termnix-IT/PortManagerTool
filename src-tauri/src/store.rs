//! お気に入り・監視・設定の永続化。
//! Electron 版（electron-store）と同じ `config.json` を読み書きし、既存のデータを引き継ぐ。

use crate::timefmt;
use crate::validation::{FavoriteInput, MonitorInput, MonitorUpdate, Protocol, SettingsUpdate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use time::OffsetDateTime;

pub const CONFIG_FILE: &str = "config.json";
pub const DEFAULT_MONITOR_INTERVAL_MS: u64 = 5000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    pub id: String,
    pub port: u16,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub protocol: Protocol,
    #[serde(default)]
    pub created_at: String,
    /// 知らない項目も書き戻す（新しい版で追加された項目を消さない）
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortState {
    #[default]
    Free,
    Occupied,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub id: String,
    pub port: u16,
    #[serde(default)]
    pub protocol: Protocol,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub notify_on_occupied: bool,
    #[serde(default = "default_true")]
    pub notify_on_freed: bool,
    #[serde(default)]
    pub last_known_state: PortState,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_interval() -> u64 {
    DEFAULT_MONITOR_INTERVAL_MS
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_interval")]
    pub monitor_interval_ms: u64,
    #[serde(default = "default_true")]
    pub show_udp: bool,
    #[serde(default)]
    pub show_established: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            monitor_interval_ms: DEFAULT_MONITOR_INTERVAL_MS,
            show_udp: true,
            show_established: false,
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub favorites: Vec<Favorite>,
    #[serde(default)]
    pub monitors: Vec<Monitor>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

pub struct Store {
    path: PathBuf,
    config: Mutex<Config>,
    now: Box<dyn Fn() -> OffsetDateTime + Send + Sync>,
}

/// 一時ファイルに書いてから置き換える（書き込み途中で終了しても壊れたファイルを残さない）
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)
}

fn load_config(path: &Path) -> Config {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Config::default(),
        Err(err) => {
            eprintln!("[store] {} を読めませんでした: {err}", path.display());
            return Config::default();
        }
    };
    match serde_json::from_str::<Config>(text.trim_start_matches('\u{feff}')) {
        Ok(config) => config,
        Err(err) => {
            // 壊れたファイルは消さずに残し、既定値で起動する（手作業で復旧できるように）
            let mut backup = path.as_os_str().to_owned();
            backup.push(".invalid");
            let _ = fs::rename(path, PathBuf::from(backup));
            eprintln!(
                "[store] {} を解析できなかったため退避しました: {err}",
                path.display()
            );
            Config::default()
        }
    }
}

/// 同じ時刻（ミリ秒）に作成しても重複しないIDにする
fn unique_id(prefix: &str, millis: i64, exists: impl Fn(&str) -> bool) -> String {
    let mut candidate = millis;
    loop {
        let id = format!("{prefix}_{candidate}");
        if !exists(&id) {
            return id;
        }
        candidate += 1;
    }
}

fn default_label(label: &str, port: u16) -> String {
    if label.is_empty() {
        format!("ポート {port}")
    } else {
        label.to_string()
    }
}

impl Store {
    pub fn open(dir: &Path) -> Self {
        Self::with_clock(dir, Box::new(OffsetDateTime::now_utc))
    }

    pub fn with_clock(dir: &Path, now: Box<dyn Fn() -> OffsetDateTime + Send + Sync>) -> Self {
        let path = dir.join(CONFIG_FILE);
        let config = load_config(&path);
        Store {
            path,
            config: Mutex::new(config),
            now,
        }
    }

    fn update<T>(&self, change: impl FnOnce(&mut Config) -> T) -> Result<T, String> {
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = config.clone();
        let result = change(&mut next);
        // electron-store と同じくタブでインデントする
        let mut bytes = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
        let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
        next.serialize(&mut serializer)
            .map_err(|err| err.to_string())?;
        write_atomic(&self.path, &bytes)
            .map_err(|err| format!("設定を保存できませんでした: {err}"))?;
        *config = next;
        Ok(result)
    }

    fn read<T>(&self, get: impl FnOnce(&Config) -> T) -> T {
        get(&self.config.lock().unwrap_or_else(|e| e.into_inner()))
    }

    // --- Favorites ---

    pub fn favorites(&self) -> Vec<Favorite> {
        self.read(|config| config.favorites.clone())
    }

    /// 同じ port + protocol が既にあればそれを返す
    pub fn add_favorite(&self, input: FavoriteInput) -> Result<Favorite, String> {
        if let Some(existing) = self.read(|config| {
            config
                .favorites
                .iter()
                .find(|f| f.port == input.port && f.protocol == input.protocol)
                .cloned()
        }) {
            return Ok(existing);
        }
        let now = (self.now)();
        self.update(|config| {
            let id = unique_id("fav", timefmt::unix_millis(now), |id| {
                config.favorites.iter().any(|f| f.id == id)
            });
            let entry = Favorite {
                id,
                port: input.port,
                label: default_label(&input.label, input.port),
                description: input.description,
                protocol: input.protocol,
                created_at: timefmt::to_iso_millis(now),
                extra: Map::new(),
            };
            config.favorites.push(entry.clone());
            entry
        })
    }

    pub fn remove_favorite(&self, id: &str) -> Result<Value, String> {
        self.update(|config| config.favorites.retain(|f| f.id != id))?;
        Ok(json!({ "success": true }))
    }

    // --- Monitors ---

    pub fn monitors(&self) -> Vec<Monitor> {
        self.read(|config| config.monitors.clone())
    }

    /// 同じ port + protocol が既にあれば、名前と通知設定を更新して有効にする
    pub fn add_monitor(&self, input: MonitorInput) -> Result<Monitor, String> {
        let now = (self.now)();
        self.update(|config| {
            if let Some(existing) = config
                .monitors
                .iter_mut()
                .find(|m| m.port == input.port && m.protocol == input.protocol)
            {
                if !input.label.is_empty() {
                    existing.label = input.label;
                } else if existing.label.is_empty() {
                    existing.label = default_label("", input.port);
                }
                existing.enabled = true;
                existing.notify_on_occupied = input.notify_on_occupied;
                existing.notify_on_freed = input.notify_on_freed;
                return existing.clone();
            }
            let id = unique_id("mon", timefmt::unix_millis(now), |id| {
                config.monitors.iter().any(|m| m.id == id)
            });
            let entry = Monitor {
                id,
                port: input.port,
                protocol: input.protocol,
                label: default_label(&input.label, input.port),
                enabled: true,
                notify_on_occupied: input.notify_on_occupied,
                notify_on_freed: input.notify_on_freed,
                last_known_state: PortState::Free,
                extra: Map::new(),
            };
            config.monitors.push(entry.clone());
            entry
        })
    }

    /// 見つからない場合は Electron 版と同じく `{ success: false, error }` を返す
    pub fn update_monitor(&self, id: &str, update: MonitorUpdate) -> Result<Value, String> {
        if !self.read(|config| config.monitors.iter().any(|m| m.id == id)) {
            return Ok(json!({ "success": false, "error": "Not found" }));
        }
        let updated = self.update(|config| {
            let monitor = config.monitors.iter_mut().find(|m| m.id == id)?;
            if let Some(label) = update.label {
                monitor.label = label;
            }
            if let Some(enabled) = update.enabled {
                monitor.enabled = enabled;
            }
            if let Some(flag) = update.notify_on_occupied {
                monitor.notify_on_occupied = flag;
            }
            if let Some(flag) = update.notify_on_freed {
                monitor.notify_on_freed = flag;
            }
            Some(monitor.clone())
        })?;
        Ok(serde_json::to_value(updated).unwrap_or(Value::Null))
    }

    /// 監視ループが検出した状態を記録する（renderer からは変更させない）
    pub fn set_monitor_state(&self, id: &str, state: PortState) -> Result<(), String> {
        self.update(|config| {
            if let Some(monitor) = config.monitors.iter_mut().find(|m| m.id == id) {
                monitor.last_known_state = state;
            }
        })
    }

    pub fn remove_monitor(&self, id: &str) -> Result<Value, String> {
        self.update(|config| config.monitors.retain(|m| m.id != id))?;
        Ok(json!({ "success": true }))
    }

    // --- Settings ---

    pub fn settings(&self) -> Settings {
        self.read(|config| config.settings.clone())
    }

    pub fn update_settings(&self, update: SettingsUpdate) -> Result<Settings, String> {
        self.update(|config| {
            if let Some(interval) = update.monitor_interval_ms {
                config.settings.monitor_interval_ms = interval;
            }
            if let Some(flag) = update.show_udp {
                config.settings.show_udp = flag;
            }
            if let Some(flag) = update.show_established {
                config.settings.show_established = flag;
            }
            config.settings.clone()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use time::macros::datetime;

    fn open_store(dir: &Path) -> Store {
        Store::with_clock(dir, Box::new(|| datetime!(2026-09-16 00:00:00 UTC)))
    }

    fn favorite_input(port: u16, label: &str) -> FavoriteInput {
        FavoriteInput {
            port,
            protocol: Protocol::Tcp,
            label: label.into(),
            description: String::new(),
        }
    }

    fn monitor_input(port: u16, label: &str) -> MonitorInput {
        MonitorInput {
            port,
            protocol: Protocol::Tcp,
            label: label.into(),
            notify_on_occupied: true,
            notify_on_freed: true,
        }
    }

    #[test]
    fn reads_electron_store_file_and_keeps_unknown_fields() {
        let dir = TempDir::new();
        fs::write(
            dir.path().join(CONFIG_FILE),
            r#"{
	"favorites": [{ "id": "fav_1", "port": 3000, "label": "Next.js", "description": "", "protocol": "TCP", "createdAt": "2026-01-01T00:00:00.000Z" }],
	"monitors": [{ "id": "mon_1", "port": 5432, "label": "DB", "enabled": true, "notifyOnOccupied": true, "notifyOnFreed": false, "lastKnownState": "occupied" }],
	"settings": { "monitorIntervalMs": 3000 },
	"__internal__": { "migrations": { "version": "1.0.0" } }
}"#,
        )
        .unwrap();
        let store = open_store(dir.path());
        assert_eq!(store.favorites()[0].label, "Next.js");
        let monitor = &store.monitors()[0];
        assert_eq!(
            monitor.protocol,
            Protocol::Tcp,
            "protocol の無い旧データは TCP"
        );
        assert_eq!(monitor.last_known_state, PortState::Occupied);
        assert!(!monitor.notify_on_freed);
        let settings = store.settings();
        assert_eq!(settings.monitor_interval_ms, 3000);
        assert!(settings.show_udp, "足りない設定は既定値で補う");

        store
            .update_settings(SettingsUpdate {
                show_udp: Some(false),
                ..Default::default()
            })
            .unwrap();
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap())
                .unwrap();
        assert_eq!(saved["__internal__"]["migrations"]["version"], "1.0.0");
        assert_eq!(saved["settings"]["showUdp"], false);
        assert_eq!(saved["monitors"][0]["notifyOnFreed"], false);
    }

    #[test]
    fn starts_with_defaults_and_moves_broken_file_aside() {
        let dir = TempDir::new();
        assert_eq!(open_store(dir.path()).settings(), Settings::default());
        fs::write(dir.path().join(CONFIG_FILE), "{ broken").unwrap();
        let store = open_store(dir.path());
        assert!(store.favorites().is_empty());
        assert!(dir.path().join("config.json.invalid").exists());
    }

    #[test]
    fn favorites_are_deduplicated_by_port_and_protocol() {
        let dir = TempDir::new();
        let store = open_store(dir.path());
        let first = store.add_favorite(favorite_input(3000, "")).unwrap();
        assert_eq!(first.label, "ポート 3000");
        assert_eq!(first.id, "fav_1789516800000");
        assert_eq!(first.created_at, "2026-09-16T00:00:00.000Z");
        assert_eq!(
            store
                .add_favorite(favorite_input(3000, "other"))
                .unwrap()
                .id,
            first.id
        );
        let udp = store
            .add_favorite(FavoriteInput {
                protocol: Protocol::Udp,
                ..favorite_input(3000, "")
            })
            .unwrap();
        assert_ne!(udp.id, first.id, "同じ時刻でもIDは重複しない");
        assert_eq!(store.favorites().len(), 2);
        store.remove_favorite(&first.id).unwrap();
        assert_eq!(
            open_store(dir.path()).favorites().len(),
            1,
            "ファイルに保存されている"
        );
    }

    #[test]
    fn existing_monitor_is_updated_and_enabled() {
        let dir = TempDir::new();
        let store = open_store(dir.path());
        let monitor = store.add_monitor(monitor_input(5173, "Vite")).unwrap();
        store
            .update_monitor(
                &monitor.id,
                MonitorUpdate {
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        let again = store
            .add_monitor(MonitorInput {
                notify_on_freed: false,
                ..monitor_input(5173, "")
            })
            .unwrap();
        assert_eq!(again.id, monitor.id);
        assert_eq!(again.label, "Vite", "名前が空なら既存の名前を残す");
        assert!(again.enabled);
        assert!(!again.notify_on_freed);
        assert_eq!(store.monitors().len(), 1);
    }

    #[test]
    fn monitor_update_reports_missing_and_state_is_internal() {
        let dir = TempDir::new();
        let store = open_store(dir.path());
        assert_eq!(
            store
                .update_monitor("mon_x", MonitorUpdate::default())
                .unwrap(),
            json!({ "success": false, "error": "Not found" })
        );
        let monitor = store.add_monitor(monitor_input(5173, "Vite")).unwrap();
        store
            .set_monitor_state(&monitor.id, PortState::Occupied)
            .unwrap();
        let updated = store
            .update_monitor(
                &monitor.id,
                MonitorUpdate {
                    label: Some("x".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated["lastKnownState"], "occupied");
        assert_eq!(updated["label"], "x");
        store.remove_monitor(&monitor.id).unwrap();
        assert!(store.monitors().is_empty());
    }
}
