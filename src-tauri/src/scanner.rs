//! ポートの一覧（画面表示用）、TCP 待受の一覧（履歴用）、指定ポートの確認（監視用）

use crate::classifier::classify;
use crate::excluded_ports::{ExcludedPortsProvider, ExcludedRange};
use crate::system::{ProcessEntry, SystemInfo, TcpState};
use crate::validation::Protocol;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// 画面に渡す1行。キー名は Electron 版（PowerShell の出力）と同じ
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct PortEntry {
    pub protocol: Protocol,
    pub local_address: String,
    pub local_port: u16,
    pub remote_address: String,
    pub remote_port: u16,
    pub state: String,
    #[serde(rename = "PID")]
    pub pid: u32,
    pub process_name: String,
    pub category: String,
    pub category_label: String,
    pub command_line: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanError {
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub ports: Vec<PortEntry>,
    pub excluded_ranges: Vec<ExcludedRange>,
    pub errors: Vec<ScanError>,
}

/// 履歴用の TCP 待受
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub port: u16,
    pub pid: u32,
    pub process_name: String,
    pub process_started_at: Option<String>,
    pub local_address: String,
    pub category: String,
    pub category_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortCheck {
    pub occupied: bool,
    pub process_name: String,
    pub pid: u32,
}

const UNKNOWN_PROCESS: &str = "<unknown>";

/// PID → 表示用のプロセス名
fn process_names(processes: &[ProcessEntry]) -> HashMap<u32, String> {
    processes
        .iter()
        .map(|p| (p.pid, p.display_name()))
        .collect()
}

fn name_of(names: &HashMap<u32, String>, pid: u32) -> String {
    names
        .get(&pid)
        .cloned()
        .unwrap_or_else(|| UNKNOWN_PROCESS.to_string())
}

fn error_entry(source: &str, message: String) -> ScanError {
    ScanError {
        source: source.into(),
        message,
    }
}

/// コマンドラインを取得する（取得できないプロセスは空文字）
pub fn command_lines(system: &dyn SystemInfo, pids: &[u32]) -> HashMap<u32, String> {
    let unique: HashSet<u32> = pids.iter().copied().filter(|&pid| pid > 0).collect();
    unique
        .into_iter()
        .map(|pid| (pid, system.command_line(pid).unwrap_or_default()))
        .collect()
}

/// 全ポートを取得する。TCP/UDP/予約範囲は個別に失敗しうるため、取得できた分を返し、
/// 失敗した分を errors に入れる（失敗を0件として扱わない）。
pub fn scan_ports(system: &dyn SystemInfo, excluded: &ExcludedPortsProvider) -> ScanResult {
    let mut errors = Vec::new();
    let names = match system.processes() {
        Ok(processes) => process_names(&processes),
        Err(message) => {
            errors.push(error_entry("Process", message));
            HashMap::new()
        }
    };

    let mut ports = Vec::new();
    match system.tcp_table() {
        Ok(rows) => ports.extend(
            rows.into_iter()
                .filter(|row| matches!(row.state, TcpState::Listen | TcpState::Established))
                .map(|row| PortEntry {
                    protocol: Protocol::Tcp,
                    local_address: row.local_address,
                    local_port: row.local_port,
                    remote_address: row.remote_address,
                    remote_port: row.remote_port,
                    state: row.state.label().into(),
                    pid: row.pid,
                    process_name: name_of(&names, row.pid),
                    category: String::new(),
                    category_label: String::new(),
                    command_line: String::new(),
                }),
        ),
        Err(message) => errors.push(error_entry("TCP", message)),
    }
    match system.udp_table() {
        Ok(rows) => ports.extend(rows.into_iter().map(|row| PortEntry {
            protocol: Protocol::Udp,
            local_address: row.local_address,
            local_port: row.local_port,
            remote_address: "*".into(),
            remote_port: 0,
            state: "--".into(),
            pid: row.pid,
            process_name: name_of(&names, row.pid),
            category: String::new(),
            category_label: String::new(),
            command_line: String::new(),
        })),
        Err(message) => errors.push(error_entry("UDP", message)),
    }
    let excluded_ranges = excluded.get().unwrap_or_else(|message| {
        errors.push(error_entry("ExcludedRanges", message));
        Vec::new()
    });

    for port in &mut ports {
        let is_listen = port.state == TcpState::Listen.label();
        if let Some(result) = classify(
            port.protocol,
            is_listen,
            port.local_port,
            &port.process_name,
        ) {
            port.category = result.category.as_str().into();
            port.category_label = result.label.into();
        }
    }

    // コマンドラインは開発/DBに分類されたプロセスだけに絞る（一覧が長くなりすぎないように）
    let classified: Vec<u32> = ports
        .iter()
        .filter(|p| !p.category.is_empty())
        .map(|p| p.pid)
        .collect();
    let lines = command_lines(system, &classified);
    for port in &mut ports {
        if let Some(line) = lines.get(&port.pid) {
            port.command_line = line.clone();
        }
    }

    ScanResult {
        ports,
        excluded_ranges,
        errors,
    }
}

/// TCP の待受一覧（履歴用）。取得失敗時はエラーを返す（全ポート解放と誤認しないため）。
pub fn scan_tcp_listeners(system: &dyn SystemInfo) -> Result<Vec<Listener>, String> {
    let rows = system.tcp_table()?;
    let names = process_names(&system.processes()?);
    let mut start_times: HashMap<u32, Option<String>> = HashMap::new();
    Ok(rows
        .into_iter()
        .filter(|row| row.state == TcpState::Listen)
        .map(|row| {
            let process_name = name_of(&names, row.pid);
            let result = classify(Protocol::Tcp, true, row.local_port, &process_name);
            let started_at = start_times
                .entry(row.pid)
                .or_insert_with(|| system.process_start_time(row.pid))
                .clone();
            Listener {
                port: row.local_port,
                pid: row.pid,
                process_name,
                process_started_at: started_at,
                local_address: row.local_address,
                category: result
                    .map(|r| r.category.as_str().to_string())
                    .unwrap_or_default(),
                category_label: result.map(|r| r.label.to_string()).unwrap_or_default(),
            }
        })
        .collect())
}

/// 指定ポートの使用状況（監視用）。TCP は待受のみを使用中とする。
/// 取得に失敗した場合はエラーを返す。空き扱いにすると誤った「解放」通知になるため。
pub fn check_ports(
    system: &dyn SystemInfo,
    targets: &[(Protocol, u16)],
) -> Result<HashMap<(Protocol, u16), PortCheck>, String> {
    let mut result: HashMap<(Protocol, u16), PortCheck> = targets
        .iter()
        .map(|&target| {
            (
                target,
                PortCheck {
                    occupied: false,
                    process_name: String::new(),
                    pid: 0,
                },
            )
        })
        .collect();
    if result.is_empty() {
        return Ok(result);
    }
    let wants = |protocol| targets.iter().any(|(p, _)| *p == protocol);
    let mut found: Vec<(Protocol, u16, u32)> = Vec::new();
    if wants(Protocol::Tcp) {
        found.extend(
            system
                .tcp_table()?
                .into_iter()
                .filter(|row| row.state == TcpState::Listen)
                .map(|row| (Protocol::Tcp, row.local_port, row.pid)),
        );
    }
    if wants(Protocol::Udp) {
        found.extend(
            system
                .udp_table()?
                .into_iter()
                .map(|row| (Protocol::Udp, row.local_port, row.pid)),
        );
    }
    let names = process_names(&system.processes()?);
    for (protocol, port, pid) in found {
        if let Some(entry) = result.get_mut(&(protocol, port)) {
            *entry = PortCheck {
                occupied: true,
                process_name: name_of(&names, pid),
                pid,
            };
        }
    }
    Ok(result)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::system::{TcpRow, UdpRow};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    pub struct FakeSystem {
        pub tcp: Option<Vec<TcpRow>>,
        pub udp: Option<Vec<UdpRow>>,
        pub processes: Vec<ProcessEntry>,
        pub command_lines: HashMap<u32, String>,
        pub start_times: HashMap<u32, String>,
    }

    impl SystemInfo for FakeSystem {
        fn tcp_table(&self) -> Result<Vec<TcpRow>, String> {
            self.tcp.clone().ok_or_else(|| "TCP failed".to_string())
        }
        fn udp_table(&self) -> Result<Vec<UdpRow>, String> {
            self.udp.clone().ok_or_else(|| "UDP failed".to_string())
        }
        fn processes(&self) -> Result<Vec<ProcessEntry>, String> {
            Ok(self.processes.clone())
        }
        fn process_start_time(&self, pid: u32) -> Option<String> {
            self.start_times.get(&pid).cloned()
        }
        fn command_line(&self, pid: u32) -> Option<String> {
            self.command_lines.get(&pid).cloned()
        }
    }

    pub fn tcp(port: u16, pid: u32, state: TcpState) -> TcpRow {
        TcpRow {
            local_address: "127.0.0.1".into(),
            local_port: port,
            remote_address: "0.0.0.0".into(),
            remote_port: 0,
            state,
            pid,
        }
    }

    fn udp(port: u16, pid: u32) -> UdpRow {
        UdpRow {
            local_address: "0.0.0.0".into(),
            local_port: port,
            pid,
        }
    }

    fn processes() -> Vec<ProcessEntry> {
        vec![
            ProcessEntry {
                pid: 100,
                parent_pid: 1,
                name: "node.exe".into(),
            },
            ProcessEntry {
                pid: 200,
                parent_pid: 1,
                name: "chrome.exe".into(),
            },
            ProcessEntry {
                pid: 300,
                parent_pid: 1,
                name: "postgres.exe".into(),
            },
        ]
    }

    fn excluded(result: Result<&'static str, &'static str>) -> ExcludedPortsProvider {
        ExcludedPortsProvider::new(
            Box::new(move |_| result.map(String::from).map_err(String::from)),
            Arc::new(Instant::now),
            Duration::from_secs(60),
        )
    }

    #[test]
    fn scan_classifies_and_attaches_command_lines_only_to_classified_rows() {
        let system = FakeSystem {
            tcp: Some(vec![
                tcp(5173, 100, TcpState::Listen),
                tcp(50000, 200, TcpState::Established),
                tcp(443, 200, TcpState::Other),
            ]),
            udp: Some(vec![udp(5353, 200), udp(9229, 999)]),
            processes: processes(),
            command_lines: HashMap::from([
                (100, "node vite".into()),
                (200, "chrome --flags".into()),
            ]),
            ..Default::default()
        };
        let result = scan_ports(&system, &excluded(Ok("  5357  5357\n")));
        assert!(result.errors.is_empty());
        assert_eq!(result.excluded_ranges.len(), 1);
        assert_eq!(
            result.ports.len(),
            4,
            "Listen/Established 以外の TCP は除く"
        );

        let vite = &result.ports[0];
        assert_eq!(
            (vite.state.as_str(), vite.process_name.as_str()),
            ("Listen", "node")
        );
        assert_eq!(
            (vite.category.as_str(), vite.category_label.as_str()),
            ("dev", "Vite")
        );
        assert_eq!(vite.command_line, "node vite");

        let established = &result.ports[1];
        assert_eq!(established.state, "Established");
        assert_eq!(established.category, "");
        assert_eq!(
            established.command_line, "",
            "分類外はコマンドラインを取得しない"
        );

        let unknown_udp = &result.ports[3];
        assert_eq!(unknown_udp.process_name, "<unknown>");
        assert_eq!(
            (
                unknown_udp.state.as_str(),
                unknown_udp.remote_address.as_str()
            ),
            ("--", "*")
        );
    }

    #[test]
    fn scan_keeps_partial_results_and_reports_errors() {
        let system = FakeSystem {
            tcp: None,
            udp: Some(vec![udp(5353, 200)]),
            processes: processes(),
            ..Default::default()
        };
        let result = scan_ports(&system, &excluded(Err("netsh failed")));
        assert_eq!(result.ports.len(), 1);
        let sources: Vec<&str> = result.errors.iter().map(|e| e.source.as_str()).collect();
        assert_eq!(sources, vec!["TCP", "ExcludedRanges"]);
    }

    #[test]
    fn serializes_with_electron_compatible_keys() {
        let entry = PortEntry {
            protocol: Protocol::Tcp,
            local_address: "::".into(),
            local_port: 80,
            remote_address: "::".into(),
            remote_port: 0,
            state: "Listen".into(),
            pid: 4,
            process_name: "System".into(),
            category: String::new(),
            category_label: String::new(),
            command_line: String::new(),
        };
        let value = serde_json::to_value(&entry).unwrap();
        let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        for key in [
            "Protocol",
            "LocalAddress",
            "LocalPort",
            "RemoteAddress",
            "RemotePort",
            "State",
            "PID",
            "ProcessName",
            "Category",
            "CategoryLabel",
            "CommandLine",
        ] {
            assert!(keys.iter().any(|k| *k == key), "missing {key}");
        }
        assert_eq!(value["Protocol"], "TCP");
    }

    #[test]
    fn tcp_listeners_include_start_time_and_classification() {
        let system = FakeSystem {
            tcp: Some(vec![
                tcp(5173, 100, TcpState::Listen),
                tcp(50000, 200, TcpState::Established),
            ]),
            processes: processes(),
            start_times: HashMap::from([(100, "2026-09-16T01:00:00.0000000Z".into())]),
            ..Default::default()
        };
        let listeners = scan_tcp_listeners(&system).unwrap();
        assert_eq!(listeners.len(), 1);
        assert_eq!(
            listeners[0].process_started_at.as_deref(),
            Some("2026-09-16T01:00:00.0000000Z")
        );
        assert_eq!(listeners[0].category_label, "Vite");
        assert!(
            scan_tcp_listeners(&FakeSystem::default()).is_err(),
            "失敗は空一覧にしない"
        );
    }

    #[test]
    fn check_ports_distinguishes_protocols_and_fails_loudly() {
        let system = FakeSystem {
            tcp: Some(vec![
                tcp(3000, 100, TcpState::Listen),
                tcp(5432, 300, TcpState::Established),
            ]),
            udp: Some(vec![udp(3000, 200)]),
            processes: processes(),
            ..Default::default()
        };
        let targets = [
            (Protocol::Tcp, 3000),
            (Protocol::Tcp, 5432),
            (Protocol::Udp, 3000),
            (Protocol::Udp, 4000),
        ];
        let result = check_ports(&system, &targets).unwrap();
        assert_eq!(
            result[&(Protocol::Tcp, 3000)],
            PortCheck {
                occupied: true,
                process_name: "node".into(),
                pid: 100
            }
        );
        assert!(
            !result[&(Protocol::Tcp, 5432)].occupied,
            "Established は使用中にしない"
        );
        assert_eq!(result[&(Protocol::Udp, 3000)].pid, 200);
        assert!(!result[&(Protocol::Udp, 4000)].occupied);

        let broken = FakeSystem {
            tcp: None,
            udp: Some(vec![]),
            ..Default::default()
        };
        assert!(check_ports(&broken, &[(Protocol::Tcp, 3000)]).is_err());
        assert!(
            check_ports(&broken, &[(Protocol::Udp, 3000)]).is_ok(),
            "UDP だけなら TCP は取得しない"
        );
    }
}
