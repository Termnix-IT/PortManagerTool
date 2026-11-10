//! OSから取得する情報の型と、その取得手段の抽象化。
//! 実装は `win`（Win32 API）で、テストでは偽物に差し替える。

/// TCP の状態（MIB_TCP_STATE）。このアプリで使うものだけを区別する
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TcpState {
    Listen,
    Established,
    Other,
}

impl TcpState {
    pub fn from_mib(state: u32) -> Self {
        match state {
            2 => TcpState::Listen,
            5 => TcpState::Established,
            _ => TcpState::Other,
        }
    }

    /// 画面表示用（PowerShell の Get-NetTCPConnection と同じ表記）
    pub fn label(self) -> &'static str {
        match self {
            TcpState::Listen => "Listen",
            TcpState::Established => "Established",
            TcpState::Other => "Other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TcpRow {
    pub local_address: String,
    pub local_port: u16,
    pub remote_address: String,
    pub remote_port: u16,
    pub state: TcpState,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UdpRow {
    pub local_address: String,
    pub local_port: u16,
    pub pid: u32,
}

/// 実行中のプロセス。`name` は実行ファイル名（例: `node.exe`）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
}

impl ProcessEntry {
    /// 一覧表示用の名前（PowerShell の Get-Process と同じく `.exe` を除く。PID 0 は Idle）
    pub fn display_name(&self) -> String {
        if self.pid == 0 {
            return "Idle".to_string();
        }
        // 日本語名などでも文字の途中で切らないよう get で取り出す
        let split = self.name.len().checked_sub(4).filter(|&i| i > 0);
        match split.and_then(|i| Some((i, self.name.get(i..)?))) {
            Some((i, ext)) if ext.eq_ignore_ascii_case(".exe") => self.name[..i].to_string(),
            _ => self.name.clone(),
        }
    }
}

pub trait SystemInfo: Send + Sync {
    fn tcp_table(&self) -> Result<Vec<TcpRow>, String>;
    fn udp_table(&self) -> Result<Vec<UdpRow>, String>;
    fn processes(&self) -> Result<Vec<ProcessEntry>, String>;
    /// ISO 8601（UTC、100ns精度）。取得できなければ None
    fn process_start_time(&self, pid: u32) -> Option<String>;
    /// 取得できなければ None（権限不足・終了済みなど）
    fn command_line(&self, pid: u32) -> Option<String>;
}

pub struct WindowsSystem;

impl SystemInfo for WindowsSystem {
    fn tcp_table(&self) -> Result<Vec<TcpRow>, String> {
        crate::win::net::tcp_table()
    }

    fn udp_table(&self) -> Result<Vec<UdpRow>, String> {
        crate::win::net::udp_table()
    }

    fn processes(&self) -> Result<Vec<ProcessEntry>, String> {
        crate::win::process::snapshot()
    }

    fn process_start_time(&self, pid: u32) -> Option<String> {
        crate::win::process::start_time(pid)
    }

    fn command_line(&self, pid: u32) -> Option<String> {
        crate::win::process::command_line(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_strips_exe_and_names_idle() {
        let entry = |pid, name: &str| ProcessEntry {
            pid,
            parent_pid: 0,
            name: name.into(),
        };
        assert_eq!(entry(10, "node.exe").display_name(), "node");
        assert_eq!(entry(10, "Code.EXE").display_name(), "Code");
        assert_eq!(entry(4, "System").display_name(), "System");
        assert_eq!(entry(0, "[System Process]").display_name(), "Idle");
    }
}
