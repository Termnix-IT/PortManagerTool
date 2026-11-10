//! プロセス情報（Toolhelp / プロセストークン / NtQueryInformationProcess）。
//! 取得できない情報（権限不足・終了済み）は None を返し、呼び出し側で「不明」として扱う。

use super::text::from_wide;
use crate::system::ProcessEntry;
use std::mem::size_of;
use windows::core::{PCWSTR, PWSTR};
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, FILETIME, HANDLE, UNICODE_STRING, WAIT_TIMEOUT,
};
use windows::Win32::Security::{
    GetTokenInformation, LookupAccountSidW, TokenUser, PSID, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, OpenProcessToken, WaitForSingleObject, PROCESS_ACCESS_RIGHTS,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};

/// 閉じ忘れを防ぐためのハンドルの所有者
struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> windows::core::Result<Handle> {
    unsafe { OpenProcess(access, false, pid).map(Handle) }
}

/// 全プロセスの PID・親PID・実行ファイル名
pub fn snapshot() -> Result<Vec<ProcessEntry>, String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            .map(Handle)
            .map_err(|err| format!("プロセス一覧を取得できませんでした: {}", err.message()))?;
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        Process32FirstW(snapshot.0, &mut entry)
            .map_err(|err| format!("プロセス一覧を取得できませんでした: {}", err.message()))?;
        let mut result = Vec::new();
        loop {
            result.push(ProcessEntry {
                pid: entry.th32ProcessID,
                parent_pid: entry.th32ParentProcessID,
                name: from_wide(&entry.szExeFile),
            });
            if Process32NextW(snapshot.0, &mut entry).is_err() {
                break;
            }
        }
        Ok(result)
    }
}

/// プロセスの開始時刻（UTC、.NET の DateTime.ToString("o") と同じ7桁精度）
pub fn start_time(pid: u32) -> Option<String> {
    let process = open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
    let mut creation = FILETIME::default();
    let (mut exit, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    unsafe { GetProcessTimes(process.0, &mut creation, &mut exit, &mut kernel, &mut user) }.ok()?;
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if ticks == 0 {
        return None;
    }
    crate::timefmt::filetime_to_iso(ticks)
}

/// コマンドライン。Windows 8.1 以降は PROCESS_QUERY_LIMITED_INFORMATION だけで取得できる
pub fn command_line(pid: u32) -> Option<String> {
    let process = open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
    // UNICODE_STRING はポインタを含むため 8 バイト境界に揃える
    let mut buffer = vec![0u64; 128];
    for _ in 0..3 {
        let length = (buffer.len() * 8) as u32;
        let mut needed: u32 = 0;
        let status = unsafe {
            NtQueryInformationProcess(
                process.0,
                ProcessCommandLineInformation,
                buffer.as_mut_ptr().cast(),
                length,
                &mut needed,
            )
        };
        if status.is_ok() {
            let text = unsafe { &*buffer.as_ptr().cast::<UNICODE_STRING>() };
            let chars = usize::from(text.Length) / 2;
            if chars == 0 || text.Buffer.is_null() {
                return Some(String::new());
            }
            // 文字列の本体は同じバッファ内に書かれる。範囲外を指していれば読まない
            let base = buffer.as_ptr() as usize;
            let start = text.Buffer.0 as usize;
            if start < base || start + chars * 2 > base + buffer.len() * 8 {
                return None;
            }
            let slice = unsafe { std::slice::from_raw_parts(text.Buffer.0, chars) };
            return Some(String::from_utf16_lossy(slice));
        }
        if needed <= length {
            return None;
        }
        buffer = vec![0u64; (needed as usize).div_ceil(8)];
    }
    None
}

fn account_name(sid: PSID) -> Option<String> {
    let (mut name_len, mut domain_len) = (0u32, 0u32);
    let mut sid_use = SID_NAME_USE::default();
    unsafe {
        let _ = LookupAccountSidW(
            PCWSTR::null(),
            sid,
            None,
            &mut name_len,
            None,
            &mut domain_len,
            &mut sid_use,
        );
    }
    if name_len == 0 {
        return None;
    }
    let mut name = vec![0u16; name_len as usize];
    let mut domain = vec![0u16; domain_len.max(1) as usize];
    unsafe {
        LookupAccountSidW(
            PCWSTR::null(),
            sid,
            Some(PWSTR(name.as_mut_ptr())),
            &mut name_len,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut sid_use,
        )
    }
    .ok()?;
    let (name, domain) = (from_wide(&name), from_wide(&domain));
    Some(if domain.is_empty() {
        name
    } else {
        format!("{domain}\\{name}")
    })
}

/// 実行ユーザー（"DOMAIN\user"）。管理者権限のプロセスなど、トークンを開けなければ None
pub fn owner(pid: u32) -> Option<String> {
    let process = open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token) }.ok()?;
    let token = Handle(token);
    let mut length = 0u32;
    unsafe {
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut length);
    }
    if length == 0 {
        return None;
    }
    let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
    unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            length,
            &mut length,
        )
    }
    .ok()?;
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    account_name(user.User.Sid)
}

pub fn current_user() -> Option<String> {
    owner(std::process::id())
}

/// セッションID。0 は Windows サービス
pub fn session_id(pid: u32) -> Option<u32> {
    let mut session = 0u32;
    unsafe { ProcessIdToSessionId(pid, &mut session) }.ok()?;
    Some(session)
}

/// プロセスが動作中か。権限不足で開けない場合は「存在する」とみなす
pub fn is_alive(pid: u32) -> bool {
    match open(pid, PROCESS_SYNCHRONIZE) {
        Ok(process) => (unsafe { WaitForSingleObject(process.0, 0) }) == WAIT_TIMEOUT,
        Err(err) => err.code() == ERROR_ACCESS_DENIED.to_hresult(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_this_process() {
        let pid = std::process::id();
        let exe = std::env::current_exe().unwrap();
        let exe_name = exe.file_name().unwrap().to_string_lossy().to_string();
        let processes = snapshot().unwrap();
        let me = processes
            .iter()
            .find(|p| p.pid == pid)
            .expect("自分自身がいること");
        assert!(
            me.name.eq_ignore_ascii_case(&exe_name),
            "{} != {exe_name}",
            me.name
        );
        assert!(processes.iter().any(|p| p.pid == 4));
    }

    #[test]
    fn reads_details_of_this_process() {
        let pid = std::process::id();
        let started = start_time(pid).expect("開始時刻");
        let parsed = crate::timefmt::parse_iso(&started).expect("ISO 8601 として読めること");
        assert!(parsed <= time::OffsetDateTime::now_utc());
        assert_eq!(started.len(), "2026-01-01T00:00:00.0000000Z".len());

        let exe = std::env::current_exe().unwrap();
        let stem = exe.file_stem().unwrap().to_string_lossy().to_string();
        assert!(command_line(pid).unwrap().contains(&stem));

        let user = owner(pid).expect("実行ユーザー");
        assert!(user.contains('\\'));
        assert_eq!(current_user().as_deref(), Some(user.as_str()));
        assert!(session_id(pid).is_some());
        assert!(is_alive(pid));
    }

    #[test]
    fn exited_process_is_not_alive() {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        // 親（このテスト）がハンドルを閉じた後でも、終了済みとして判定できること
        drop(child);
        assert!(!is_alive(pid));
    }
}
