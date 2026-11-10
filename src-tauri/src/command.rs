//! 外部コマンド（netsh / taskkill）の実行。コンソールウィンドウを出さず、時間制限を付ける。

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// CREATE_NO_WINDOW: GUI アプリから実行したときに黒い窓を一瞬出さない
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const POLL_INTERVAL: Duration = Duration::from_millis(25);

fn read_all(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    })
}

pub fn run_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|err| err.to_string())?;
    // 出力が多いとパイプが詰まって終了しないため、待つ間も読み続ける
    let stdout = read_all(child.stdout.take());
    let stderr = read_all(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait().map_err(|err| err.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("タイムアウトしました（{}秒）", timeout.as_secs()));
            }
            None => thread::sleep(POLL_INTERVAL),
        }
    };
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_output_and_exit_code() {
        let mut command = Command::new("cmd");
        command.args(["/C", "echo hello & exit 3"]);
        let output = run_with_timeout(command, Duration::from_secs(10)).unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hello");
    }

    #[test]
    fn kills_the_process_on_timeout() {
        let mut command = Command::new("ping");
        command.args(["-n", "30", "127.0.0.1"]);
        let started = Instant::now();
        let err = run_with_timeout(command, Duration::from_millis(500)).unwrap_err();
        assert!(err.contains("タイムアウト"));
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
