//! 日時の文字列表現。renderer は JavaScript の Date で読むため ISO 8601（UTC）で渡す。

use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::{OffsetDateTime, UtcOffset};

/// JavaScript の Date#toISOString と同じ形式（UTC、ミリ秒3桁）
pub fn to_iso_millis(at: OffsetDateTime) -> String {
    at.to_offset(UtcOffset::UTC)
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .unwrap_or_default()
}

pub fn unix_millis(at: OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}

pub fn parse_iso(text: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(text, &Rfc3339).ok()
}

/// 1601-01-01 から 1970-01-01 までの 100ns 単位の差
const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;

/// FILETIME（1601年からの100ns単位）を .NET の DateTime.ToUniversalTime().ToString("o") と同じ形式にする。
/// Electron 版（PowerShell の Get-Process）が保存した履歴のスナップショットと比較できるよう、7桁精度で揃える。
pub fn filetime_to_iso(ticks: u64) -> Option<String> {
    let since_epoch = ticks.checked_sub(FILETIME_UNIX_EPOCH)?;
    let seconds = i64::try_from(since_epoch / 10_000_000).ok()?;
    let fraction = since_epoch % 10_000_000;
    let at = OffsetDateTime::from_unix_timestamp(seconds).ok()?;
    let base = at
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second]"
        ))
        .ok()?;
    Some(format!("{base}.{fraction:07}Z"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn formats_like_javascript_to_iso_string() {
        assert_eq!(
            to_iso_millis(datetime!(2026-09-16 03:00:00.5 UTC)),
            "2026-09-16T03:00:00.500Z"
        );
        assert_eq!(
            to_iso_millis(datetime!(2026-09-16 12:00:00 +09:00)),
            "2026-09-16T03:00:00.000Z"
        );
        assert_eq!(unix_millis(datetime!(1970-01-01 00:00:01.25 UTC)), 1250);
    }

    #[test]
    fn parses_both_millisecond_and_dotnet_precision() {
        assert_eq!(
            parse_iso("2026-09-16T03:00:00.000Z"),
            Some(datetime!(2026-09-16 03:00:00 UTC))
        );
        assert_eq!(
            parse_iso("2026-09-16T01:00:00.4567890Z"),
            Some(datetime!(2026-09-16 01:00:00.456789 UTC))
        );
        assert_eq!(parse_iso("broken"), None);
    }

    #[test]
    fn filetime_matches_dotnet_round_trip_format() {
        // 2026-09-16T01:00:00.4567890Z
        let seconds = datetime!(2026-09-16 01:00:00 UTC).unix_timestamp() as u64;
        let ticks = FILETIME_UNIX_EPOCH + seconds * 10_000_000 + 4_567_890;
        assert_eq!(
            filetime_to_iso(ticks).as_deref(),
            Some("2026-09-16T01:00:00.4567890Z")
        );
        assert_eq!(filetime_to_iso(0), None);
    }
}
