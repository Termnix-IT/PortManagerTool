//! プロセス停止前の安全判定（純粋関数のみ。システムには触れない）

use crate::classifier::normalize_process_name;
use crate::system::ProcessEntry;
use crate::validation::Protocol;
use std::collections::{HashMap, HashSet, VecDeque};

/// 停止するとOSが不安定になる・ログオフ/ブルースクリーンに直結するもの
const BLOCKED_PROCESSES: &[&str] = &[
    "system",
    "idle",
    "registry",
    "secure system",
    "memory compression",
    "smss",
    "csrss",
    "wininit",
    "winlogon",
    "services",
    "lsass",
    "lsaiso",
    "fontdrvhost",
    "msmpeng",
];

/// 停止は可能だが、デスクトップや他機能に影響が出るもの
const DANGEROUS_PROCESSES: &[&str] = &[
    "svchost",
    "explorer",
    "dwm",
    "spoolsv",
    "sihost",
    "taskhostw",
    "ctfmon",
    "searchhost",
    "startmenuexperiencehost",
    "runtimebroker",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskLevel {
    Normal,
    Caution,
    Danger,
    Blocked,
}

/// 停止対象のプロセス（停止直前に取得したもの）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetProcess {
    pub pid: u32,
    pub name: String,
    pub command_line: String,
    pub session_id: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct StopRisk {
    pub level: RiskLevel,
    pub reasons: Vec<String>,
    /// 利用者に見せる子プロセス（conhost を除く）
    pub child_processes: Vec<ProcessEntry>,
}

pub struct RiskInput<'a> {
    pub pid: u32,
    pub target: Option<&'a TargetProcess>,
    /// "DOMAIN\user"。取得できなければ None
    pub owner: Option<&'a str>,
    pub current_user: Option<&'a str>,
    pub processes: &'a [ProcessEntry],
    pub self_pid: u32,
    /// 子プロセスも停止対象にするか
    pub include_tree: bool,
}

/// 子孫プロセスを列挙する（taskkill /T の対象に相当）。
/// PIDの再利用で親子関係がループしていても停止するよう、訪問済みを記録する。
pub fn collect_descendants(processes: &[ProcessEntry], root_pid: u32) -> Vec<ProcessEntry> {
    let mut children: HashMap<u32, Vec<&ProcessEntry>> = HashMap::new();
    for process in processes {
        children
            .entry(process.parent_pid)
            .or_default()
            .push(process);
    }
    let mut result = Vec::new();
    let mut visited = HashSet::from([root_pid]);
    let mut queue = VecDeque::from([root_pid]);
    while let Some(current) = queue.pop_front() {
        for child in children.get(&current).into_iter().flatten() {
            if !visited.insert(child.pid) {
                continue;
            }
            result.push((*child).clone());
            queue.push_back(child.pid);
        }
    }
    result
}

pub fn collect_ancestor_pids(processes: &[ProcessEntry], pid: u32) -> Vec<u32> {
    let by_pid: HashMap<u32, &ProcessEntry> = processes.iter().map(|p| (p.pid, p)).collect();
    let mut result = Vec::new();
    let mut visited = HashSet::from([pid]);
    let mut current = by_pid.get(&pid);
    while let Some(process) = current {
        let parent_pid = process.parent_pid;
        if parent_pid == 0 || !visited.insert(parent_pid) {
            break;
        }
        let Some(parent) = by_pid.get(&parent_pid) else {
            break;
        };
        result.push(parent_pid);
        current = Some(parent);
    }
    result
}

fn same_user(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// コンソールアプリには必ず conhost が付くため、利用者に見せる子プロセスからは除く
fn meaningful_children(descendants: &[ProcessEntry]) -> Vec<ProcessEntry> {
    descendants
        .iter()
        .filter(|p| normalize_process_name(&p.name) != "conhost")
        .cloned()
        .collect()
}

pub fn assess_stop_risk(input: &RiskInput<'_>) -> StopRisk {
    let mut findings: Vec<(RiskLevel, String)> = Vec::new();
    let mut raise = |level: RiskLevel, reason: String| findings.push((level, reason));

    let descendants = collect_descendants(input.processes, input.pid);

    if input.pid == 0 || input.pid == 4 {
        raise(RiskLevel::Blocked, "Windowsのシステムプロセスです".into());
    }

    if let Some(target) = input.target {
        let name = normalize_process_name(&target.name);
        if BLOCKED_PROCESSES.contains(&name.as_str()) {
            raise(
                RiskLevel::Blocked,
                format!(
                    "{} はOSの重要なプロセスです。停止するとWindowsが不安定になります",
                    target.name
                ),
            );
        } else if DANGEROUS_PROCESSES.contains(&name.as_str()) {
            raise(
                RiskLevel::Danger,
                format!(
                    "{} はWindowsの機能を担うプロセスです。停止すると他の機能に影響する可能性があります",
                    target.name
                ),
            );
        }
    }

    let mut self_tree: HashSet<u32> = collect_descendants(input.processes, input.self_pid)
        .iter()
        .map(|p| p.pid)
        .collect();
    self_tree.insert(input.self_pid);
    if self_tree.contains(&input.pid) {
        raise(RiskLevel::Blocked, "このアプリ自身のプロセスです".into());
    } else if input.include_tree && descendants.iter().any(|p| self_tree.contains(&p.pid)) {
        raise(
            RiskLevel::Blocked,
            "子プロセスにこのアプリ自身が含まれています".into(),
        );
    } else if collect_ancestor_pids(input.processes, input.self_pid).contains(&input.pid) {
        raise(
            RiskLevel::Danger,
            "このアプリの親プロセスです。停止するとアプリも終了する可能性があります".into(),
        );
    }

    if input.target.and_then(|t| t.session_id) == Some(0) {
        raise(
            RiskLevel::Danger,
            "Windowsサービスとして動作しています。サービスの管理画面から停止することを推奨します"
                .into(),
        );
    }

    match (input.owner, input.current_user) {
        (None, _) => raise(
            RiskLevel::Caution,
            "実行ユーザーを取得できませんでした（管理者権限のプロセスの可能性があります）".into(),
        ),
        (Some(owner), Some(current)) if !same_user(owner, current) => raise(
            RiskLevel::Danger,
            format!("別のユーザー（{owner}）のプロセスです"),
        ),
        _ => {}
    }

    let child_processes = meaningful_children(&descendants);
    if !child_processes.is_empty() && !input.include_tree {
        raise(
            RiskLevel::Caution,
            format!(
                "子プロセスが{}件あります。親だけを停止すると子プロセスがポートを使い続けることがあります",
                child_processes.len()
            ),
        );
    }

    let level = findings
        .iter()
        .map(|(level, _)| *level)
        .max()
        .unwrap_or(RiskLevel::Normal);
    // 重大な理由から順に表示する（sort_by_key は安定なので同じ重大度内は検出順）
    findings.sort_by_key(|(level, _)| std::cmp::Reverse(*level));
    StopRisk {
        level,
        reasons: findings.into_iter().map(|(_, reason)| reason).collect(),
        child_processes,
    }
}

/// 画面で表示していたプロセスと、停止直前に取得したプロセスが同じかを確認する。
/// 表示から停止までの間にプロセスが終了し、PIDが別のプロセスに再利用されている場合に誤停止を防ぐ。
pub fn verify_expected_process<'a>(
    expected_name: &str,
    expected_port: Option<u16>,
    protocol: Protocol,
    target: Option<&'a TargetProcess>,
    tcp_ports: &[u16],
    udp_ports: &[u16],
) -> Result<&'a TargetProcess, String> {
    let Some(target) = target else {
        return Err("プロセスは既に終了しています".into());
    };
    if !expected_name.is_empty()
        && normalize_process_name(expected_name) != normalize_process_name(&target.name)
    {
        return Err(format!(
            "PIDが別のプロセス（{}）に変わっています",
            target.name
        ));
    }
    if let Some(port) = expected_port {
        let ports = if protocol == Protocol::Udp {
            udp_ports
        } else {
            tcp_ports
        };
        if !ports.contains(&port) {
            return Err(format!(
                "このプロセスはポート {port}/{protocol} を使用していません"
            ));
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "PC\\dev";
    const SELF_PID: u32 = 500;

    fn entry(pid: u32, parent_pid: u32, name: &str) -> ProcessEntry {
        ProcessEntry {
            pid,
            parent_pid,
            name: name.into(),
        }
    }

    // explorer(100) → terminal(200) → npm(300) → node(301) + conhost(302)
    // アプリは terminal(200) → 500 → 501
    fn processes() -> Vec<ProcessEntry> {
        vec![
            entry(4, 0, "System"),
            entry(100, 1, "explorer.exe"),
            entry(200, 100, "WindowsTerminal.exe"),
            entry(300, 200, "node.exe"),
            entry(301, 300, "node.exe"),
            entry(302, 300, "conhost.exe"),
            entry(500, 200, "port-manager-tool.exe"),
            entry(501, 500, "msedgewebview2.exe"),
            entry(700, 1, "postgres.exe"),
        ]
    }

    fn target_of(pid: u32, session_id: u32) -> Option<TargetProcess> {
        processes()
            .into_iter()
            .find(|p| p.pid == pid)
            .map(|p| TargetProcess {
                pid: p.pid,
                name: p.name,
                command_line: String::new(),
                session_id: Some(session_id),
            })
    }

    struct Case {
        pid: u32,
        target: Option<TargetProcess>,
        owner: Option<&'static str>,
        include_tree: bool,
    }

    impl Case {
        fn new(pid: u32) -> Self {
            Case {
                pid,
                target: target_of(pid, 1),
                owner: Some(USER),
                include_tree: false,
            }
        }

        fn assess(&self) -> StopRisk {
            let processes = processes();
            assess_stop_risk(&RiskInput {
                pid: self.pid,
                target: self.target.as_ref(),
                owner: self.owner,
                current_user: Some(USER),
                processes: &processes,
                self_pid: SELF_PID,
                include_tree: self.include_tree,
            })
        }
    }

    #[test]
    fn descendants_include_grandchildren() {
        let mut pids: Vec<u32> = collect_descendants(&processes(), 200)
            .iter()
            .map(|p| p.pid)
            .collect();
        pids.sort();
        assert_eq!(pids, vec![300, 301, 302, 500, 501]);
    }

    #[test]
    fn descendants_stop_on_parent_loops() {
        let looped = vec![entry(1, 2, "a"), entry(2, 1, "b")];
        assert_eq!(
            collect_descendants(&looped, 1)
                .iter()
                .map(|p| p.pid)
                .collect::<Vec<_>>(),
            vec![2]
        );
    }

    #[test]
    fn ancestors_are_followed_in_order() {
        assert_eq!(
            collect_ancestor_pids(&processes(), 501),
            vec![500, 200, 100]
        );
    }

    #[test]
    fn own_dev_process_is_normal() {
        let risk = Case::new(301).assess();
        assert_eq!(risk.level, RiskLevel::Normal);
        assert!(risk.reasons.is_empty());
    }

    #[test]
    fn children_raise_caution_without_counting_conhost() {
        let risk = Case::new(300).assess();
        assert_eq!(risk.level, RiskLevel::Caution);
        assert_eq!(
            risk.child_processes
                .iter()
                .map(|p| p.pid)
                .collect::<Vec<_>>(),
            vec![301]
        );
    }

    #[test]
    fn tree_stop_drops_child_caution() {
        let case = Case {
            include_tree: true,
            ..Case::new(300)
        };
        assert_eq!(case.assess().level, RiskLevel::Normal);
    }

    #[test]
    fn system_pid_and_critical_processes_are_blocked() {
        assert_eq!(Case::new(4).assess().level, RiskLevel::Blocked);
        let lsass = TargetProcess {
            pid: 900,
            name: "lsass.exe".into(),
            command_line: String::new(),
            session_id: Some(0),
        };
        let risk = assess_stop_risk(&RiskInput {
            pid: 900,
            target: Some(&lsass),
            owner: None,
            current_user: Some(USER),
            processes: &[],
            self_pid: SELF_PID,
            include_tree: false,
        });
        assert_eq!(risk.level, RiskLevel::Blocked);
    }

    #[test]
    fn this_app_and_its_children_are_blocked() {
        assert_eq!(Case::new(500).assess().level, RiskLevel::Blocked);
        assert_eq!(Case::new(501).assess().level, RiskLevel::Blocked);
    }

    #[test]
    fn tree_stop_containing_this_app_is_blocked() {
        let risk = Case {
            include_tree: true,
            ..Case::new(200)
        }
        .assess();
        assert_eq!(risk.level, RiskLevel::Blocked);
        assert!(risk
            .reasons
            .join(",")
            .contains("子プロセスにこのアプリ自身"));
    }

    #[test]
    fn reasons_are_ordered_by_severity() {
        let risk = Case {
            owner: None,
            ..Case::new(500)
        }
        .assess();
        assert_eq!(risk.level, RiskLevel::Blocked);
        assert!(risk.reasons[0].contains("このアプリ自身"));
        let last = risk.reasons.last().unwrap();
        assert!(last.contains("子プロセス") || last.contains("実行ユーザー"));
    }

    #[test]
    fn parent_of_this_app_is_danger() {
        let risk = Case::new(200).assess();
        assert_eq!(risk.level, RiskLevel::Danger);
        assert!(risk.reasons.join(",").contains("親プロセス"));
    }

    #[test]
    fn windows_feature_processes_are_danger() {
        assert_eq!(Case::new(100).assess().level, RiskLevel::Danger);
    }

    #[test]
    fn services_and_other_users_are_danger() {
        let service = Case {
            target: target_of(700, 0),
            ..Case::new(700)
        };
        assert_eq!(service.assess().level, RiskLevel::Danger);
        let other_user = Case {
            owner: Some("PC\\other"),
            ..Case::new(301)
        };
        assert_eq!(other_user.assess().level, RiskLevel::Danger);
    }

    #[test]
    fn user_comparison_ignores_case() {
        assert_eq!(
            Case {
                owner: Some("pc\\DEV"),
                ..Case::new(301)
            }
            .assess()
            .level,
            RiskLevel::Normal
        );
    }

    #[test]
    fn unknown_owner_is_caution() {
        assert_eq!(
            Case {
                owner: None,
                ..Case::new(301)
            }
            .assess()
            .level,
            RiskLevel::Caution
        );
    }

    fn node_target() -> TargetProcess {
        TargetProcess {
            pid: 301,
            name: "node.exe".into(),
            command_line: String::new(),
            session_id: Some(1),
        }
    }

    #[test]
    fn verify_ok_when_same_process_uses_port() {
        let target = node_target();
        assert!(verify_expected_process(
            "node",
            Some(5173),
            Protocol::Tcp,
            Some(&target),
            &[5173],
            &[]
        )
        .is_ok());
    }

    #[test]
    fn verify_detects_exit_pid_reuse_and_released_port() {
        let err =
            verify_expected_process("node", Some(5173), Protocol::Tcp, None, &[], &[]).unwrap_err();
        assert!(err.contains("終了"));
        let chrome = TargetProcess {
            name: "chrome.exe".into(),
            ..node_target()
        };
        let err = verify_expected_process(
            "node",
            Some(5173),
            Protocol::Tcp,
            Some(&chrome),
            &[5173],
            &[],
        )
        .unwrap_err();
        assert!(err.contains("別のプロセス"));
        let target = node_target();
        let err = verify_expected_process(
            "node",
            Some(5173),
            Protocol::Tcp,
            Some(&target),
            &[3000],
            &[5173],
        )
        .unwrap_err();
        assert!(err.contains("使用していません"));
    }

    #[test]
    fn verify_uses_udp_ports_for_udp() {
        let target = node_target();
        assert!(verify_expected_process(
            "node",
            Some(9229),
            Protocol::Udp,
            Some(&target),
            &[],
            &[9229]
        )
        .is_ok());
    }
}
