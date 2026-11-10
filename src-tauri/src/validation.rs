//! renderer から受け取る値の検証。
//! renderer の入力チェックは利便性のためのもので、ここが信頼境界になる。
//! 引数は JSON（`serde_json::Value`）のまま受け取り、型の誤りも日本語のエラーにする。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;

pub const LABEL_MAX_LENGTH: usize = 64;
pub const DESCRIPTION_MAX_LENGTH: usize = 200;
pub const ID_MAX_LENGTH: usize = 64;
pub const PROCESS_NAME_MAX_LENGTH: usize = 260;
pub const HISTORY_LIST_MAX: usize = 2000;
pub const MONITOR_INTERVAL_MIN_MS: u64 = 1000;
pub const MONITOR_INTERVAL_MAX_MS: u64 = 60000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError(pub String);

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ValidationError {}

impl From<ValidationError> for String {
    fn from(err: ValidationError) -> Self {
        err.0
    }
}

type Result<T> = std::result::Result<T, ValidationError>;

fn error<T>(message: impl Into<String>) -> Result<T> {
    Err(ValidationError(message.into()))
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize,
)]
pub enum Protocol {
    #[default]
    #[serde(rename = "TCP")]
    Tcp,
    #[serde(rename = "UDP")]
    Udp,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Protocol::Tcp => "TCP",
            Protocol::Udp => "UDP",
        }
    }
}

impl fmt::Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FavoriteInput {
    pub port: u16,
    pub protocol: Protocol,
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorInput {
    pub port: u16,
    pub protocol: Protocol,
    pub label: String,
    pub notify_on_occupied: bool,
    pub notify_on_freed: bool,
}

/// 監視の更新。port/protocol/lastKnownState 等は renderer から書き換えさせない
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorUpdate {
    pub label: Option<String>,
    pub enabled: Option<bool>,
    pub notify_on_occupied: Option<bool>,
    pub notify_on_freed: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SettingsUpdate {
    pub monitor_interval_ms: Option<u64>,
    pub show_udp: Option<bool>,
    pub show_established: Option<bool>,
}

/// 停止要求。port/protocol/processName は停止直前の再検証（別プロセスへのPID再利用検出）に使う
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillRequest {
    pub pid: u32,
    pub port: Option<u16>,
    pub protocol: Protocol,
    pub process_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryListOptions {
    pub limit: Option<usize>,
}

/// 数値、または数字だけの文字列（前後の空白は可）を整数にする。小数・それ以外は None
fn to_integer(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => {
            if let Some(n) = number.as_i64() {
                return Some(n);
            }
            let float = number.as_f64()?;
            if float.is_finite() && float.fract() == 0.0 && float.abs() < 9.0e15 {
                Some(float as i64)
            } else {
                None
            }
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            trimmed.parse::<i64>().ok()
        }
        _ => None,
    }
}

fn is_missing(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

pub fn validate_pid(value: Option<&Value>) -> Result<u32> {
    match to_integer(value) {
        Some(pid) if (1..=i64::from(u32::MAX)).contains(&pid) => Ok(pid as u32),
        _ => error("PIDが不正です"),
    }
}

pub fn validate_port(value: Option<&Value>) -> Result<u16> {
    match to_integer(value) {
        Some(port) if (1..=65535).contains(&port) => Ok(port as u16),
        _ => error("ポート番号は1〜65535の整数で指定してください"),
    }
}

pub fn validate_protocol(value: Option<&Value>) -> Result<Protocol> {
    match value {
        None | Some(Value::Null) => Ok(Protocol::Tcp),
        Some(Value::String(text)) if text.is_empty() => Ok(Protocol::Tcp),
        Some(Value::String(text)) => match text.to_uppercase().as_str() {
            "TCP" => Ok(Protocol::Tcp),
            "UDP" => Ok(Protocol::Udp),
            _ => error("プロトコルはTCPまたはUDPで指定してください"),
        },
        Some(_) => error("プロトコルはTCPまたはUDPで指定してください"),
    }
}

fn validate_text(value: Option<&Value>, field: &str, max_length: usize) -> Result<String> {
    match value {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            // renderer（JavaScript）の文字数と揃えるため UTF-16 の長さで数える
            if trimmed.encode_utf16().count() > max_length {
                return error(format!("{field}は{max_length}文字以内で指定してください"));
            }
            Ok(trimmed.to_string())
        }
        Some(_) => error(format!("{field}は文字列で指定してください")),
    }
}

fn validate_boolean(value: Option<&Value>, field: &str, default: Option<bool>) -> Result<bool> {
    match (value, default) {
        (None, Some(default)) => Ok(default),
        (Some(Value::Bool(flag)), _) => Ok(*flag),
        _ => error(format!("{field}は真偽値で指定してください")),
    }
}

pub fn validate_id(value: Option<&Value>) -> Result<String> {
    match value {
        Some(Value::String(id))
            if !id.is_empty()
                && id.len() <= ID_MAX_LENGTH
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') =>
        {
            Ok(id.clone())
        }
        _ => error("IDが不正です"),
    }
}

fn require_object(value: Option<&Value>) -> Result<&Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => error("入力データが不正です"),
    }
}

fn reject_unknown_keys(data: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    let unknown: Vec<&str> = data
        .keys()
        .map(String::as_str)
        .filter(|key| !allowed.contains(key))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        error(format!(
            "変更できない項目が含まれています: {}",
            unknown.join(", ")
        ))
    }
}

pub fn validate_favorite_input(value: Option<&Value>) -> Result<FavoriteInput> {
    let data = require_object(value)?;
    Ok(FavoriteInput {
        port: validate_port(data.get("port"))?,
        protocol: validate_protocol(data.get("protocol"))?,
        label: validate_text(data.get("label"), "名前", LABEL_MAX_LENGTH)?,
        description: validate_text(data.get("description"), "説明", DESCRIPTION_MAX_LENGTH)?,
    })
}

pub fn validate_monitor_input(value: Option<&Value>) -> Result<MonitorInput> {
    let data = require_object(value)?;
    Ok(MonitorInput {
        port: validate_port(data.get("port"))?,
        protocol: validate_protocol(data.get("protocol"))?,
        label: validate_text(data.get("label"), "名前", LABEL_MAX_LENGTH)?,
        notify_on_occupied: validate_boolean(
            data.get("notifyOnOccupied"),
            "使用開始通知",
            Some(true),
        )?,
        notify_on_freed: validate_boolean(data.get("notifyOnFreed"), "解放通知", Some(true))?,
    })
}

pub fn validate_monitor_update(value: Option<&Value>) -> Result<MonitorUpdate> {
    let data = require_object(value)?;
    reject_unknown_keys(
        data,
        &["label", "enabled", "notifyOnOccupied", "notifyOnFreed"],
    )?;
    let mut update = MonitorUpdate::default();
    if data.contains_key("label") {
        update.label = Some(validate_text(data.get("label"), "名前", LABEL_MAX_LENGTH)?);
    }
    if let Some(value) = data.get("enabled") {
        update.enabled = Some(validate_boolean(Some(value), "有効/無効", None)?);
    }
    if let Some(value) = data.get("notifyOnOccupied") {
        update.notify_on_occupied = Some(validate_boolean(Some(value), "使用開始通知", None)?);
    }
    if let Some(value) = data.get("notifyOnFreed") {
        update.notify_on_freed = Some(validate_boolean(Some(value), "解放通知", None)?);
    }
    Ok(update)
}

pub fn validate_settings_update(value: Option<&Value>) -> Result<SettingsUpdate> {
    let data = require_object(value)?;
    reject_unknown_keys(data, &["monitorIntervalMs", "showUdp", "showEstablished"])?;
    let mut update = SettingsUpdate::default();
    if data.contains_key("monitorIntervalMs") {
        let range = MONITOR_INTERVAL_MIN_MS as i64..=MONITOR_INTERVAL_MAX_MS as i64;
        match to_integer(data.get("monitorIntervalMs")) {
            Some(interval) if range.contains(&interval) => {
                update.monitor_interval_ms = Some(interval as u64)
            }
            _ => return error("監視間隔は1〜60秒で指定してください"),
        }
    }
    if let Some(value) = data.get("showUdp") {
        update.show_udp = Some(validate_boolean(Some(value), "UDP表示", None)?);
    }
    if let Some(value) = data.get("showEstablished") {
        update.show_established = Some(validate_boolean(Some(value), "接続済み表示", None)?);
    }
    Ok(update)
}

/// PID 単体（旧形式）も受け付ける
pub fn validate_kill_request(value: Option<&Value>) -> Result<KillRequest> {
    let wrapped;
    let data = match value {
        Some(Value::Object(map)) => map,
        other => {
            let mut map = Map::new();
            map.insert("pid".into(), other.cloned().unwrap_or(Value::Null));
            wrapped = map;
            &wrapped
        }
    };
    let port = if is_missing(data.get("port")) {
        None
    } else {
        Some(validate_port(data.get("port"))?)
    };
    Ok(KillRequest {
        pid: validate_pid(data.get("pid"))?,
        port,
        protocol: validate_protocol(data.get("protocol"))?,
        process_name: validate_text(
            data.get("processName"),
            "プロセス名",
            PROCESS_NAME_MAX_LENGTH,
        )?,
    })
}

pub fn validate_history_list_options(value: Option<&Value>) -> Result<HistoryListOptions> {
    if is_missing(value) {
        return Ok(HistoryListOptions::default());
    }
    let data = require_object(value)?;
    reject_unknown_keys(data, &["limit"])?;
    if !data.contains_key("limit") {
        return Ok(HistoryListOptions::default());
    }
    match to_integer(data.get("limit")) {
        Some(limit) if (1..=HISTORY_LIST_MAX as i64).contains(&limit) => Ok(HistoryListOptions {
            limit: Some(limit as usize),
        }),
        _ => error(format!("取得件数は1〜{HISTORY_LIST_MAX}で指定してください")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(value: Value) -> Option<Value> {
        Some(value)
    }

    #[test]
    fn pid_accepts_positive_integers_and_numeric_strings() {
        assert_eq!(validate_pid(v(json!(1234)).as_ref()), Ok(1234));
        assert_eq!(validate_pid(v(json!("5678")).as_ref()), Ok(5678));
    }

    #[test]
    fn pid_rejects_zero_negative_fraction_and_injection() {
        for bad in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!(""),
            json!("abc"),
            json!("12; Stop-Computer"),
            Value::Null,
            json!({}),
            json!([1]),
            json!(4294967296u64),
        ] {
            assert!(validate_pid(Some(&bad)).is_err(), "should reject {bad}");
        }
        assert!(validate_pid(None).is_err());
    }

    #[test]
    fn kill_request_is_normalized_and_accepts_bare_pid() {
        let request = validate_kill_request(
            v(json!({ "pid": "301", "port": 5173, "protocol": "udp", "processName": "node" }))
                .as_ref(),
        )
        .unwrap();
        assert_eq!(
            request,
            KillRequest {
                pid: 301,
                port: Some(5173),
                protocol: Protocol::Udp,
                process_name: "node".into()
            }
        );
        assert_eq!(
            validate_kill_request(v(json!(301)).as_ref()).unwrap(),
            KillRequest {
                pid: 301,
                port: None,
                protocol: Protocol::Tcp,
                process_name: String::new()
            }
        );
        assert!(validate_kill_request(v(json!({ "pid": 301, "port": 0 })).as_ref()).is_err());
        assert!(validate_kill_request(v(json!({ "pid": "1 & calc" })).as_ref()).is_err());
    }

    #[test]
    fn history_list_options_limit_range() {
        assert_eq!(
            validate_history_list_options(None),
            Ok(HistoryListOptions::default())
        );
        assert_eq!(
            validate_history_list_options(v(json!({})).as_ref()),
            Ok(HistoryListOptions::default())
        );
        assert_eq!(
            validate_history_list_options(v(json!({ "limit": "100" })).as_ref()),
            Ok(HistoryListOptions { limit: Some(100) })
        );
        assert!(validate_history_list_options(v(json!({ "limit": 0 })).as_ref()).is_err());
        assert!(validate_history_list_options(
            v(json!({ "limit": HISTORY_LIST_MAX + 1 })).as_ref()
        )
        .is_err());
        assert!(
            validate_history_list_options(v(json!({ "limit": 10, "type": "x" })).as_ref()).is_err()
        );
    }

    #[test]
    fn port_range() {
        assert_eq!(validate_port(v(json!(1)).as_ref()), Ok(1));
        assert_eq!(validate_port(v(json!("65535")).as_ref()), Ok(65535));
        for bad in [
            json!(0),
            json!(65536),
            json!(-80),
            json!(80.5),
            json!("80,443"),
            json!("http"),
        ] {
            assert!(validate_port(Some(&bad)).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn protocol_defaults_and_normalizes() {
        assert_eq!(validate_protocol(None), Ok(Protocol::Tcp));
        assert_eq!(
            validate_protocol(v(json!("udp")).as_ref()),
            Ok(Protocol::Udp)
        );
        assert!(validate_protocol(v(json!("ICMP")).as_ref()).is_err());
    }

    #[test]
    fn id_format() {
        assert_eq!(
            validate_id(v(json!("fav_1713246000000")).as_ref()),
            Ok("fav_1713246000000".into())
        );
        assert!(validate_id(v(json!("")).as_ref()).is_err());
        assert!(validate_id(v(json!("mon_1; rm")).as_ref()).is_err());
        assert!(validate_id(v(json!("a".repeat(65))).as_ref()).is_err());
        assert!(validate_id(v(json!(123)).as_ref()).is_err());
    }

    #[test]
    fn favorite_input_returns_only_normalized_values() {
        let result = validate_favorite_input(
            v(json!({ "port": "3000", "protocol": "tcp", "label": "  Next.js  ", "extra": "x" }))
                .as_ref(),
        )
        .unwrap();
        assert_eq!(
            result,
            FavoriteInput {
                port: 3000,
                protocol: Protocol::Tcp,
                label: "Next.js".into(),
                description: String::new()
            }
        );
    }

    #[test]
    fn favorite_input_rejects_long_label_wrong_types_and_non_objects() {
        let long = "a".repeat(LABEL_MAX_LENGTH + 1);
        assert!(
            validate_favorite_input(v(json!({ "port": 3000, "label": long })).as_ref()).is_err()
        );
        assert!(validate_favorite_input(v(json!({ "port": 3000, "label": 42 })).as_ref()).is_err());
        assert!(validate_favorite_input(v(Value::Null).as_ref()).is_err());
        assert!(validate_favorite_input(v(json!([3000])).as_ref()).is_err());
        // 日本語は UTF-16 の長さで数える（64文字ちょうどは許可）
        let japanese = "あ".repeat(LABEL_MAX_LENGTH);
        assert!(
            validate_favorite_input(v(json!({ "port": 3000, "label": japanese })).as_ref()).is_ok()
        );
    }

    #[test]
    fn monitor_input_notification_flags_default_to_true() {
        assert_eq!(
            validate_monitor_input(v(json!({ "port": 5173 })).as_ref()).unwrap(),
            MonitorInput {
                port: 5173,
                protocol: Protocol::Tcp,
                label: String::new(),
                notify_on_occupied: true,
                notify_on_freed: true
            }
        );
        assert!(validate_monitor_input(
            v(json!({ "port": 5173, "notifyOnFreed": "yes" })).as_ref()
        )
        .is_err());
    }

    #[test]
    fn monitor_update_allows_only_known_keys() {
        assert_eq!(
            validate_monitor_update(v(json!({ "enabled": false })).as_ref()).unwrap(),
            MonitorUpdate {
                enabled: Some(false),
                ..Default::default()
            }
        );
        assert!(
            validate_monitor_update(v(json!({ "lastKnownState": "occupied" })).as_ref()).is_err()
        );
        assert!(validate_monitor_update(v(json!({ "port": 1 })).as_ref()).is_err());
        assert!(validate_monitor_update(v(json!({ "enabled": null })).as_ref()).is_err());
    }

    #[test]
    fn settings_update_interval_range() {
        assert_eq!(
            validate_settings_update(v(json!({ "monitorIntervalMs": 1000 })).as_ref())
                .unwrap()
                .monitor_interval_ms,
            Some(1000)
        );
        assert_eq!(
            validate_settings_update(v(json!({ "monitorIntervalMs": 60000 })).as_ref())
                .unwrap()
                .monitor_interval_ms,
            Some(60000)
        );
        assert!(validate_settings_update(v(json!({ "monitorIntervalMs": 999 })).as_ref()).is_err());
        assert!(
            validate_settings_update(v(json!({ "monitorIntervalMs": 60001 })).as_ref()).is_err()
        );
        assert!(validate_settings_update(v(json!({ "unknown": true })).as_ref()).is_err());
    }
}
