//! 一定間隔で処理を実行する専用スレッド。間隔の変更（restart）と停止に対応する。

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

enum Control {
    Restart,
    Stop,
}

pub struct Ticker {
    control: Sender<Control>,
}

impl Ticker {
    /// `interval` は待つたびに読み直す。`immediate` なら開始直後に1回実行する
    pub fn spawn(
        name: &str,
        immediate: bool,
        interval: impl Fn() -> Duration + Send + 'static,
        mut tick: impl FnMut() + Send + 'static,
    ) -> Self {
        let (control, receiver) = mpsc::channel();
        let spawned = thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                if immediate {
                    tick();
                }
                loop {
                    match receiver.recv_timeout(interval()) {
                        Err(RecvTimeoutError::Timeout) => tick(),
                        // 間隔を読み直して待ち直す
                        Ok(Control::Restart) => {}
                        Ok(Control::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
            });
        if let Err(err) = spawned {
            eprintln!("[{name}] スレッドを開始できませんでした: {err}");
        }
        Ticker { control }
    }

    /// 間隔の変更をすぐに反映する（次の実行は新しい間隔の経過後）
    pub fn restart(&self) {
        let _ = self.control.send(Control::Restart);
    }

    pub fn stop(&self) {
        let _ = self.control.send(Control::Stop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    fn wait_until(condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn runs_immediately_and_then_periodically_until_stopped() {
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let ticker = Ticker::spawn(
            "test",
            true,
            || Duration::from_millis(20),
            move || {
                counter.fetch_add(1, Ordering::SeqCst);
            },
        );
        wait_until(|| count.load(Ordering::SeqCst) >= 3);
        ticker.stop();
        thread::sleep(Duration::from_millis(50));
        let stopped_at = count.load(Ordering::SeqCst);
        thread::sleep(Duration::from_millis(100));
        assert_eq!(count.load(Ordering::SeqCst), stopped_at);
    }

    #[test]
    fn restart_rereads_the_interval() {
        let interval_ms = Arc::new(AtomicU64::new(60_000));
        let count = Arc::new(AtomicUsize::new(0));
        let (interval, counter) = (interval_ms.clone(), count.clone());
        let ticker = Ticker::spawn(
            "test",
            false,
            move || Duration::from_millis(interval.load(Ordering::SeqCst)),
            move || {
                counter.fetch_add(1, Ordering::SeqCst);
            },
        );
        thread::sleep(Duration::from_millis(50));
        assert_eq!(count.load(Ordering::SeqCst), 0);
        interval_ms.store(10, Ordering::SeqCst);
        ticker.restart();
        wait_until(|| count.load(Ordering::SeqCst) >= 2);
        ticker.stop();
    }
}
