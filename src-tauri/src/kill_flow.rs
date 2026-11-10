//! プロセス停止の対話フロー。
//! 停止直前の再検証 → 危険度判定 → 確認ダイアログ → 通常停止/強制停止 → 終了確認 の順に進む。
//! ダイアログ表示とプロセス操作はトレイトで受け取り、テストでは偽物に差し替える。

use crate::process_safety::{
    assess_stop_risk, verify_expected_process, RiskInput, RiskLevel, TargetProcess,
};
use crate::system::ProcessEntry;
use crate::validation::KillRequest;
use serde::Serialize;
use std::time::Duration;

const COMMAND_LINE_PREVIEW_LENGTH: usize = 300;
const CHILD_NAME_PREVIEW_COUNT: usize = 5;

pub const BUTTON_CANCEL: usize = 0;
pub const BUTTON_GRACEFUL: usize = 1;
pub const BUTTON_FORCE: usize = 2;

/// 停止直前に取得したプロセス情報
#[derive(Debug, Clone)]
pub struct Inspection {
    pub processes: Vec<ProcessEntry>,
    pub target: Option<TargetProcess>,
    pub owner: Option<String>,
    pub tcp_ports: Vec<u16>,
    pub udp_ports: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopOutcome {
    pub exit_code: i32,
    pub message: String,
}

pub trait Killer {
    fn inspect_process(&self, pid: u32) -> Result<Inspection, String>;
    fn stop_process(&self, pid: u32, force: bool, tree: bool) -> StopOutcome;
    fn wait_for_exit(&self, pid: u32, timeout: Duration) -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogKind {
    Error,
    Warning,
    Question,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogOptions {
    pub kind: DialogKind,
    pub title: String,
    pub message: String,
    pub detail: String,
    pub buttons: Vec<String>,
    pub default_id: usize,
    pub cancel_id: usize,
    /// チェックボックスの文言と初期値
    pub checkbox: Option<(String, bool)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DialogResponse {
    pub response: usize,
    pub checkbox_checked: bool,
}

pub trait Dialogs {
    fn show(&self, options: &DialogOptions) -> DialogResponse;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StopMethod {
    Graceful,
    Force,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// renderer へ返す結果（`ports:kill`）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<StopMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree: Option<bool>,
    #[serde(skip_serializing_if = "is_false")]
    pub cancelled: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub graceful_failed: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub stale: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl KillResult {
    pub fn failure(error: impl Into<String>) -> Self {
        KillResult {
            error: Some(error.into()),
            ..Default::default()
        }
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() > max_chars {
        let mut cut: String = text.chars().take(max_chars).collect();
        cut.push('…');
        cut
    } else {
        text.to_string()
    }
}

fn describe_children(children: &[ProcessEntry]) -> String {
    let names: Vec<String> = children
        .iter()
        .take(CHILD_NAME_PREVIEW_COUNT)
        .map(|p| format!("{} ({})", p.name, p.pid))
        .collect();
    let rest = children.len() - names.len();
    if rest > 0 {
        format!("{} ほか{rest}件", names.join(", "))
    } else {
        names.join(", ")
    }
}

fn buttons(labels: &[&str]) -> Vec<String> {
    labels.iter().map(|label| label.to_string()).collect()
}

pub struct KillFlow<'a> {
    pub killer: &'a dyn Killer,
    pub dialogs: &'a dyn Dialogs,
    pub self_pid: u32,
    pub current_user: Option<String>,
}

impl KillFlow<'_> {
    fn show_blocked(&self, title: &str, message: String, reasons: &[String]) {
        self.dialogs.show(&DialogOptions {
            kind: DialogKind::Error,
            title: title.into(),
            message,
            detail: reasons.join("\n"),
            buttons: buttons(&["閉じる"]),
            default_id: 0,
            cancel_id: 0,
            checkbox: None,
        });
    }

    pub fn run(&self, request: &KillRequest) -> KillResult {
        let pid = request.pid;
        let info = match self.killer.inspect_process(pid) {
            Ok(info) => info,
            Err(err) => {
                return KillResult::failure(format!("プロセス情報を取得できませんでした: {err}"))
            }
        };

        let target = match verify_expected_process(
            &request.process_name,
            request.port,
            request.protocol,
            info.target.as_ref(),
            &info.tcp_ports,
            &info.udp_ports,
        ) {
            Ok(target) => target,
            Err(reason) => {
                self.show_blocked(
                    "停止を中止しました",
                    "表示時点からプロセスの状態が変わっています".into(),
                    &[
                        reason.clone(),
                        "一覧を更新してから、もう一度お試しください。".into(),
                    ],
                );
                return KillResult {
                    stale: true,
                    ..KillResult::failure(reason)
                };
            }
        };

        let risk_input = |include_tree| RiskInput {
            pid,
            target: Some(target),
            owner: info.owner.as_deref(),
            current_user: self.current_user.as_deref(),
            processes: &info.processes,
            self_pid: self.self_pid,
            include_tree,
        };
        let risk = assess_stop_risk(&risk_input(false));
        if risk.level == RiskLevel::Blocked {
            self.show_blocked(
                "停止できません",
                format!("{}（PID {pid}）は停止できません", target.name),
                &risk.reasons,
            );
            return KillResult {
                blocked: true,
                ..KillResult::failure(risk.reasons.join(" / "))
            };
        }

        let children = &risk.child_processes;
        let mut detail: Vec<String> = Vec::new();
        if let Some(port) = request.port {
            detail.push(format!("ポート: {port}/{}", request.protocol));
        }
        detail.push(format!(
            "実行ユーザー: {}",
            info.owner.as_deref().unwrap_or("取得できませんでした")
        ));
        if !target.command_line.is_empty() {
            detail.push(format!(
                "コマンドライン: {}",
                truncate(&target.command_line, COMMAND_LINE_PREVIEW_LENGTH)
            ));
        }
        if !children.is_empty() {
            detail.push(format!("子プロセス: {}", describe_children(children)));
        }
        if !risk.reasons.is_empty() {
            let lines: Vec<String> = risk.reasons.iter().map(|r| format!("・{r}")).collect();
            detail.push(format!("\n⚠ 注意\n{}", lines.join("\n")));
        }
        detail.push("\n通常停止: アプリに終了を要求します（node / python などのコンソールアプリは応答しないため、強制停止を案内します）".into());
        detail.push("強制停止: 即座に終了させます。保存されていないデータは失われます".into());

        let is_danger = risk.level == RiskLevel::Danger;
        let choice = self.dialogs.show(&DialogOptions {
            kind: if is_danger {
                DialogKind::Warning
            } else {
                DialogKind::Question
            },
            title: "プロセスの停止".into(),
            message: format!("{}（PID {pid}）を停止しますか？", target.name),
            detail: detail.join("\n"),
            buttons: buttons(&["キャンセル", "通常停止", "強制停止"]),
            default_id: if is_danger {
                BUTTON_CANCEL
            } else {
                BUTTON_GRACEFUL
            },
            cancel_id: BUTTON_CANCEL,
            checkbox: (!children.is_empty()).then(|| {
                (
                    format!("子プロセス（{}件）もまとめて停止する", children.len()),
                    true,
                )
            }),
        });
        // キャンセル（Esc・閉じるボタンを含む）と想定外の応答は停止しない
        if choice.response != BUTTON_GRACEFUL && choice.response != BUTTON_FORCE {
            return KillResult {
                cancelled: true,
                ..Default::default()
            };
        }

        let tree = !children.is_empty() && choice.checkbox_checked;
        let effective_risk = if tree {
            assess_stop_risk(&risk_input(true))
        } else {
            risk.clone()
        };
        if effective_risk.level == RiskLevel::Blocked {
            self.show_blocked(
                "停止できません",
                "子プロセスを含めた停止はできません".into(),
                &effective_risk.reasons,
            );
            return KillResult {
                blocked: true,
                ..KillResult::failure(effective_risk.reasons.join(" / "))
            };
        }

        if effective_risk.level == RiskLevel::Danger {
            let lines: Vec<String> = effective_risk
                .reasons
                .iter()
                .map(|r| format!("・{r}"))
                .collect();
            let confirm = self.dialogs.show(&DialogOptions {
                kind: DialogKind::Warning,
                title: "確認".into(),
                message: "本当に停止しますか？".into(),
                detail: lines.join("\n"),
                buttons: buttons(&["キャンセル", "停止する"]),
                default_id: 0,
                cancel_id: 0,
                checkbox: None,
            });
            if confirm.response != 1 {
                return KillResult {
                    cancelled: true,
                    ..Default::default()
                };
            }
        }

        let base = KillResult {
            pid: Some(pid),
            process_name: Some(target.name.clone()),
            tree: Some(tree),
            ..Default::default()
        };

        if choice.response == BUTTON_GRACEFUL {
            let graceful = self.killer.stop_process(pid, false, tree);
            if graceful.exit_code == 0 && self.killer.wait_for_exit(pid, Duration::from_secs(5)) {
                return KillResult {
                    success: true,
                    method: Some(StopMethod::Graceful),
                    ..base
                };
            }
            let fallback = self.dialogs.show(&DialogOptions {
                kind: DialogKind::Warning,
                title: "通常停止できませんでした".into(),
                message: format!(
                    "{}（PID {pid}）は通常停止では終了しませんでした。強制停止しますか？",
                    target.name
                ),
                detail: if graceful.message.is_empty() {
                    "終了要求に応答しませんでした".into()
                } else {
                    graceful.message
                },
                buttons: buttons(&["キャンセル", "強制停止"]),
                default_id: 0,
                cancel_id: 0,
                checkbox: None,
            });
            if fallback.response != 1 {
                return KillResult {
                    cancelled: true,
                    graceful_failed: true,
                    ..base
                };
            }
        }

        let forced = self.killer.stop_process(pid, true, tree);
        if self.killer.wait_for_exit(pid, Duration::from_secs(3)) {
            return KillResult {
                success: true,
                method: Some(StopMethod::Force),
                ..base
            };
        }
        let error = if forced.message.is_empty() {
            "プロセスを停止できませんでした（管理者権限が必要な可能性があります）".to_string()
        } else {
            forced.message
        };
        KillResult {
            error: Some(error),
            ..base
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validation::Protocol;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    const USER: &str = "PC\\dev";

    fn entry(pid: u32, parent_pid: u32, name: &str) -> ProcessEntry {
        ProcessEntry {
            pid,
            parent_pid,
            name: name.into(),
        }
    }

    fn target(pid: u32, name: &str, command_line: &str) -> TargetProcess {
        TargetProcess {
            pid,
            name: name.into(),
            command_line: command_line.into(),
            session_id: Some(1),
        }
    }

    fn inspection() -> Inspection {
        Inspection {
            processes: vec![
                entry(300, 200, "node.exe"),
                entry(301, 300, "node.exe"),
                entry(900, 1, "port-manager-tool.exe"),
            ],
            target: Some(target(301, "node.exe", "node vite")),
            owner: Some(USER.into()),
            tcp_ports: vec![5173],
            udp_ports: vec![],
        }
    }

    #[derive(Default)]
    struct Fake {
        info: Option<Result<Inspection, String>>,
        responses: RefCell<VecDeque<DialogResponse>>,
        stop_results: RefCell<VecDeque<StopOutcome>>,
        exit_results: RefCell<VecDeque<bool>>,
        dialogs: RefCell<Vec<DialogOptions>>,
        stops: RefCell<Vec<(u32, bool, bool)>>,
    }

    impl Fake {
        fn new(responses: &[(usize, bool)]) -> Self {
            Fake {
                info: Some(Ok(inspection())),
                responses: RefCell::new(
                    responses
                        .iter()
                        .map(|&(response, checkbox_checked)| DialogResponse {
                            response,
                            checkbox_checked,
                        })
                        .collect(),
                ),
                ..Default::default()
            }
        }

        fn run(&self, request: &KillRequest) -> KillResult {
            KillFlow {
                killer: self,
                dialogs: self,
                self_pid: 900,
                current_user: Some(USER.into()),
            }
            .run(request)
        }
    }

    impl Killer for Fake {
        fn inspect_process(&self, _pid: u32) -> Result<Inspection, String> {
            self.info.clone().unwrap()
        }
        fn stop_process(&self, pid: u32, force: bool, tree: bool) -> StopOutcome {
            self.stops.borrow_mut().push((pid, force, tree));
            self.stop_results
                .borrow_mut()
                .pop_front()
                .unwrap_or(StopOutcome {
                    exit_code: 0,
                    message: String::new(),
                })
        }
        fn wait_for_exit(&self, _pid: u32, _timeout: Duration) -> bool {
            self.exit_results.borrow_mut().pop_front().unwrap_or(true)
        }
    }

    impl Dialogs for Fake {
        fn show(&self, options: &DialogOptions) -> DialogResponse {
            self.dialogs.borrow_mut().push(options.clone());
            self.responses
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| panic!("unexpected dialog: {}", options.message))
        }
    }

    fn request() -> KillRequest {
        KillRequest {
            pid: 301,
            port: Some(5173),
            protocol: Protocol::Tcp,
            process_name: "node".into(),
        }
    }

    #[test]
    fn cancel_does_not_stop() {
        let fake = Fake::new(&[(BUTTON_CANCEL, false)]);
        assert_eq!(
            fake.run(&request()),
            KillResult {
                cancelled: true,
                ..Default::default()
            }
        );
        assert!(fake.stops.borrow().is_empty());
    }

    #[test]
    fn graceful_stop_succeeds_when_process_exits() {
        let fake = Fake::new(&[(BUTTON_GRACEFUL, false)]);
        let result = fake.run(&request());
        assert!(result.success);
        assert_eq!(result.method, Some(StopMethod::Graceful));
        assert_eq!(*fake.stops.borrow(), vec![(301, false, false)]);
        assert!(
            fake.dialogs.borrow()[0].detail.contains("node vite"),
            "コマンドラインを確認ダイアログに表示する"
        );
    }

    #[test]
    fn rejected_graceful_stop_offers_force() {
        let fake = Fake::new(&[(BUTTON_GRACEFUL, false), (1, false)]);
        fake.stop_results.borrow_mut().extend([
            StopOutcome {
                exit_code: 1,
                message: "この処理は、/F オプションのみで強制終了できます。".into(),
            },
            StopOutcome {
                exit_code: 0,
                message: String::new(),
            },
        ]);
        let result = fake.run(&request());
        assert_eq!(result.method, Some(StopMethod::Force));
        assert_eq!(
            fake.stops.borrow().iter().map(|s| s.1).collect::<Vec<_>>(),
            vec![false, true]
        );
        assert!(fake.dialogs.borrow()[1]
            .detail
            .contains("/F オプションのみ"));
    }

    #[test]
    fn graceful_success_without_exit_offers_force() {
        let fake = Fake::new(&[(BUTTON_GRACEFUL, false), (0, false)]);
        fake.exit_results.borrow_mut().push_back(false);
        let result = fake.run(&request());
        assert!(!result.success);
        assert!(result.graceful_failed);
        assert!(result.cancelled);
    }

    #[test]
    fn force_stop_failure_returns_error() {
        let fake = Fake::new(&[(BUTTON_FORCE, false)]);
        fake.stop_results.borrow_mut().push_back(StopOutcome {
            exit_code: 1,
            message: "アクセスが拒否されました。".into(),
        });
        fake.exit_results.borrow_mut().push_back(false);
        let result = fake.run(&request());
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("アクセスが拒否されました。"));
    }

    #[test]
    fn children_show_checkbox_and_tree_stop() {
        let mut fake = Fake::new(&[(BUTTON_FORCE, true)]);
        let mut info = inspection();
        info.target = Some(target(300, "node.exe", ""));
        fake.info = Some(Ok(info));
        let result = fake.run(&KillRequest {
            pid: 300,
            ..request()
        });
        let dialogs = fake.dialogs.borrow();
        let (label, checked) = dialogs[0].checkbox.clone().unwrap();
        assert!(label.contains("子プロセス（1件）"));
        assert!(checked);
        assert_eq!(*fake.stops.borrow(), vec![(300, true, true)]);
        assert_eq!(result.tree, Some(true));
    }

    #[test]
    fn changed_process_is_stale() {
        let mut fake = Fake::new(&[(0, false)]);
        let mut info = inspection();
        info.target = Some(target(301, "chrome.exe", ""));
        fake.info = Some(Ok(info));
        let result = fake.run(&request());
        assert!(result.stale);
        assert_eq!(fake.dialogs.borrow()[0].kind, DialogKind::Error);
        assert!(fake.stops.borrow().is_empty());
    }

    #[test]
    fn blocked_process_shows_no_confirmation() {
        let mut fake = Fake::new(&[(0, false)]);
        let mut info = inspection();
        info.target = Some(target(900, "port-manager-tool.exe", ""));
        fake.info = Some(Ok(info));
        let result = fake.run(&KillRequest {
            pid: 900,
            process_name: "port-manager-tool".into(),
            ..request()
        });
        assert!(result.blocked);
        assert_eq!(fake.dialogs.borrow().len(), 1);
        assert_eq!(fake.dialogs.borrow()[0].kind, DialogKind::Error);
        assert!(fake.stops.borrow().is_empty());
    }

    #[test]
    fn danger_defaults_to_cancel_and_can_be_cancelled_on_confirmation() {
        let mut fake = Fake::new(&[(BUTTON_FORCE, false), (0, false)]);
        let mut info = inspection();
        info.owner = Some("PC\\other".into());
        fake.info = Some(Ok(info));
        let result = fake.run(&request());
        let dialogs = fake.dialogs.borrow();
        assert_eq!(dialogs[0].default_id, BUTTON_CANCEL);
        assert_eq!(dialogs[0].kind, DialogKind::Warning);
        assert_eq!(dialogs[1].message, "本当に停止しますか？");
        assert!(result.cancelled);
        assert!(fake.stops.borrow().is_empty());
    }

    #[test]
    fn inspection_failure_does_not_stop() {
        let mut fake = Fake::new(&[]);
        fake.info = Some(Err("snapshot failed".into()));
        let result = fake.run(&request());
        assert!(!result.success);
        assert!(result.error.unwrap().contains("snapshot failed"));
        assert!(fake.stops.borrow().is_empty());
    }

    #[test]
    fn result_serializes_like_the_electron_version() {
        let value = serde_json::to_value(KillResult {
            cancelled: true,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "success": false, "cancelled": true })
        );
        let value = serde_json::to_value(KillResult {
            success: true,
            method: Some(StopMethod::Graceful),
            pid: Some(1),
            process_name: Some("node.exe".into()),
            tree: Some(false),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "success": true, "method": "graceful", "pid": 1, "processName": "node.exe", "tree": false })
        );
    }
}
