//! Hyper-V / WSL / Docker 等が予約しているTCPポート範囲。
//! この範囲のポートは使用中のプロセスが無くても bind できない（EACCES 等）。
//! 取得する公開APIが無いため netsh を使う。見出しはロケール依存だが、範囲の行は「数値 数値 [*]」のため数値行だけを読む。

use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(60);
const NETSH_TIMEOUT: Duration = Duration::from_secs(10);
const FAMILIES: [&str; 2] = ["ipv4", "ipv6"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ExcludedRange {
    pub start: u16,
    pub end: u16,
    pub managed: bool,
}

fn parse_port(token: &str) -> Option<u32> {
    if token.is_empty() || token.len() > 5 || !token.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    token.parse().ok()
}

pub fn parse_excluded_port_ranges(output: &str) -> Vec<ExcludedRange> {
    let mut ranges = Vec::new();
    for line in output.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let managed = match tokens.as_slice() {
            [_, _] => false,
            [_, _, "*"] => true,
            _ => continue,
        };
        let (Some(start), Some(end)) = (parse_port(tokens[0]), parse_port(tokens[1])) else {
            continue;
        };
        if start < 1 || end > 65535 || start > end {
            continue;
        }
        ranges.push(ExcludedRange {
            start: start as u16,
            end: end as u16,
            managed,
        });
    }
    ranges
}

/// IPv4/IPv6 の結果は多くの場合同じなので、同一範囲をまとめて開始ポート順に並べる
pub fn merge_ranges(lists: Vec<Vec<ExcludedRange>>) -> Vec<ExcludedRange> {
    let mut by_key: BTreeMap<(u16, u16), ExcludedRange> = BTreeMap::new();
    for range in lists.into_iter().flatten() {
        by_key
            .entry((range.start, range.end))
            .and_modify(|existing| existing.managed |= range.managed)
            .or_insert(range);
    }
    by_key.into_values().collect()
}

pub type NetshRunner = dyn Fn(&str) -> Result<String, String> + Send + Sync;
pub type Clock = dyn Fn() -> Instant + Send + Sync;

pub struct ExcludedPortsProvider {
    run: Box<NetshRunner>,
    now: Arc<Clock>,
    ttl: Duration,
    cache: Mutex<Option<(Instant, Vec<ExcludedRange>)>>,
}

impl ExcludedPortsProvider {
    pub fn new(run: Box<NetshRunner>, now: Arc<Clock>, ttl: Duration) -> Self {
        ExcludedPortsProvider {
            run,
            now,
            ttl,
            cache: Mutex::new(None),
        }
    }

    pub fn windows() -> Self {
        Self::new(Box::new(run_netsh), Arc::new(Instant::now), CACHE_TTL)
    }

    /// 取得失敗はキャッシュせずエラーを返す
    pub fn get(&self) -> Result<Vec<ExcludedRange>, String> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, ranges)) = cache.as_ref() {
            if (self.now)().saturating_duration_since(*at) < self.ttl {
                return Ok(ranges.clone());
            }
        }
        let mut lists = Vec::new();
        for family in FAMILIES {
            lists.push(parse_excluded_port_ranges(&(self.run)(family)?));
        }
        let ranges = merge_ranges(lists);
        *cache = Some(((self.now)(), ranges.clone()));
        Ok(ranges)
    }
}

fn run_netsh(family: &str) -> Result<String, String> {
    let mut command = std::process::Command::new("netsh");
    command.args([
        "interface",
        family,
        "show",
        "excludedportrange",
        "protocol=tcp",
    ]);
    let output = crate::command::run_with_timeout(command, NETSH_TIMEOUT)
        .map_err(|err| format!("予約ポート範囲を取得できませんでした（{family}）: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "予約ポート範囲を取得できませんでした（{family}）: {}",
            crate::win::text::decode_console_output(&output.stderr)
        ));
    }
    // 必要なのは数値行だけなので、見出しの文字コードは問わない
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    // 日本語環境の netsh 出力（見出しはロケール依存、範囲行は数値のみ）
    const JA_OUTPUT: &str = "
プロトコル tcp ポート除外範囲

開始ポート    終了ポート
----------    --------
      5357        5357
     50000       50059     *
     55676       55775

* - 管理されている除外ポート。
";

    const EN_OUTPUT: &str = "
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      5357        5357
     49709       49808

* - Administered port exclusions.
";

    fn range(start: u16, end: u16, managed: bool) -> ExcludedRange {
        ExcludedRange {
            start,
            end,
            managed,
        }
    }

    #[test]
    fn parses_only_range_lines_regardless_of_locale() {
        assert_eq!(
            parse_excluded_port_ranges(JA_OUTPUT),
            vec![
                range(5357, 5357, false),
                range(50000, 50059, true),
                range(55676, 55775, false)
            ]
        );
        assert_eq!(
            parse_excluded_port_ranges(EN_OUTPUT)
                .iter()
                .map(|r| r.start)
                .collect::<Vec<_>>(),
            vec![5357, 49709]
        );
        assert_eq!(
            parse_excluded_port_ranges("5357\r\n  5357 5357\r\n"),
            vec![range(5357, 5357, false)]
        );
    }

    #[test]
    fn ignores_empty_output_and_invalid_ranges() {
        assert!(parse_excluded_port_ranges("").is_empty());
        assert!(parse_excluded_port_ranges("  70000  70001\n  900  100\n").is_empty());
    }

    #[test]
    fn merges_duplicates_and_sorts_by_start() {
        let merged = merge_ranges(vec![
            vec![range(55676, 55775, false), range(5357, 5357, false)],
            vec![range(5357, 5357, true)],
        ]);
        assert_eq!(
            merged,
            vec![range(5357, 5357, true), range(55676, 55775, false)]
        );
    }

    fn fake_provider(
        fail: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
        clock_ms: Arc<AtomicU64>,
    ) -> ExcludedPortsProvider {
        let base = Instant::now();
        ExcludedPortsProvider::new(
            Box::new(move |_family| {
                calls.fetch_add(1, Ordering::SeqCst);
                if fail.load(Ordering::SeqCst) > 0 {
                    Err("netsh failed".into())
                } else {
                    Ok(JA_OUTPUT.into())
                }
            }),
            Arc::new(move || base + Duration::from_millis(clock_ms.load(Ordering::SeqCst))),
            Duration::from_millis(1000),
        )
    }

    #[test]
    fn caches_for_ttl_and_refreshes_after_expiry() {
        let calls = Arc::new(AtomicUsize::new(0));
        let clock = Arc::new(AtomicU64::new(0));
        let provider = fake_provider(Arc::new(AtomicUsize::new(0)), calls.clone(), clock.clone());
        provider.get().unwrap();
        provider.get().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2, "ipv4 と ipv6 の2回だけ");
        clock.store(1500, Ordering::SeqCst);
        assert_eq!(provider.get().unwrap().len(), 3);
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn failures_are_not_cached() {
        let fail = Arc::new(AtomicUsize::new(1));
        let provider = fake_provider(
            fail.clone(),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicU64::new(0)),
        );
        assert_eq!(provider.get().unwrap_err(), "netsh failed");
        fail.store(0, Ordering::SeqCst);
        assert_eq!(provider.get().unwrap().len(), 3);
    }
}
