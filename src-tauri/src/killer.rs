//! 停止フロー（kill_flow）が使うプロセス操作の Windows 実装

use crate::kill_flow::{Inspection, Killer, StopOutcome};
use crate::process_safety::TargetProcess;
use crate::system::TcpState;
use crate::win;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const TASKKILL_TIMEOUT: Duration = Duration::from_secs(15);
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(250);

pub struct WindowsKiller;

fn unique_sorted(mut ports: Vec<u16>) -> Vec<u16> {
    ports.sort_unstable();
    ports.dedup();
    ports
}

impl Killer for WindowsKiller {
    /// 停止直前の再検証と危険度判定に必要な情報をまとめて取得する
    fn inspect_process(&self, pid: u32) -> Result<Inspection, String> {
        let processes = win::process::snapshot()?;
        let target = processes
            .iter()
            .find(|p| p.pid == pid)
            .map(|p| TargetProcess {
                pid,
                name: p.name.clone(),
                command_line: win::process::command_line(pid).unwrap_or_default(),
                session_id: win::process::session_id(pid),
            });
        let owner = target.as_ref().and_then(|_| win::process::owner(pid));
        let tcp_ports = win::net::tcp_table()?
            .into_iter()
            .filter(|row| row.pid == pid && row.state == TcpState::Listen)
            .map(|row| row.local_port)
            .collect();
        let udp_ports = win::net::udp_table()?
            .into_iter()
            .filter(|row| row.pid == pid)
            .map(|row| row.local_port)
            .collect();
        Ok(Inspection {
            processes,
            target,
            owner,
            tcp_ports: unique_sorted(tcp_ports),
            udp_ports: unique_sorted(udp_ports),
        })
    }

    /// taskkill で停止する。/F なしはウィンドウへの終了要求（WM_CLOSE）で、ウィンドウを持たない
    /// コンソールアプリ（node / python 等）には効かず「/F オプションのみで強制終了できます」で失敗する
    fn stop_process(&self, pid: u32, force: bool, tree: bool) -> StopOutcome {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string()]);
        if tree {
            command.arg("/T");
        }
        if force {
            command.arg("/F");
        }
        match crate::command::run_with_timeout(command, TASKKILL_TIMEOUT) {
            Ok(output) => {
                let success = output.status.success();
                let bytes = if success {
                    &output.stdout
                } else {
                    &output.stderr
                };
                StopOutcome {
                    exit_code: output.status.code().unwrap_or(1),
                    message: win::text::decode_console_output(bytes),
                }
            }
            Err(err) => StopOutcome {
                exit_code: 1,
                message: format!("taskkill を実行できませんでした: {err}"),
            },
        }
    }

    fn wait_for_exit(&self, pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if !win::process::is_alive(pid) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(EXIT_POLL_INTERVAL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn inspects_this_process_with_its_listening_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let pid = std::process::id();
        let info = WindowsKiller.inspect_process(pid).unwrap();
        let target = info.target.expect("自分自身");
        assert_eq!(target.pid, pid);
        assert!(info.tcp_ports.contains(&port));
        assert!(info.owner.is_some());
        assert!(info.processes.len() > 10);
    }

    #[test]
    fn stops_a_child_process_by_force() {
        let mut child = Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .spawn()
            .unwrap();
        let pid = child.id();
        let outcome = WindowsKiller.stop_process(pid, true, false);
        assert_eq!(outcome.exit_code, 0, "{}", outcome.message);
        child.wait().unwrap();
        assert!(WindowsKiller.wait_for_exit(pid, Duration::from_secs(3)));
    }

    #[test]
    fn missing_process_reports_failure_message() {
        // 存在しない PID（4の倍数で大きな値）
        let outcome = WindowsKiller.stop_process(0x7FFF_FFFC, true, false);
        assert_ne!(outcome.exit_code, 0);
        assert!(!outcome.message.is_empty());
    }
}
