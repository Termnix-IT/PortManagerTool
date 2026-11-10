//! Win32 API との文字列の受け渡し

use windows::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS};

/// NUL 終端の UTF-16 にする
pub fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// NUL 終端（または末尾まで）の UTF-16 を文字列にする
pub fn from_wide(buffer: &[u16]) -> String {
    let length = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
}

/// コンソールアプリ（taskkill 等）の出力を文字列にする。
/// UTF-8 として読めなければ OEM コードページ（日本語環境では Shift_JIS）として読む。
pub fn decode_console_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.trim().to_string(),
        Err(_) => decode_oem(bytes).trim().to_string(),
    }
}

fn decode_oem(bytes: &[u8]) -> String {
    let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
    unsafe {
        let length = MultiByteToWideChar(CP_OEMCP, flags, bytes, None);
        if length <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut wide = vec![0u16; length as usize];
        let written = MultiByteToWideChar(CP_OEMCP, flags, bytes, Some(&mut wide));
        String::from_utf16_lossy(&wide[..written.max(0) as usize])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_round_trip() {
        let wide = to_wide("ポート");
        assert_eq!(wide.last(), Some(&0));
        assert_eq!(from_wide(&wide), "ポート");
        assert_eq!(from_wide(&[0x41, 0x42]), "AB");
    }

    #[test]
    fn decodes_utf8_and_trims() {
        assert_eq!(
            decode_console_output("成功: PID 1\r\n".as_bytes()),
            "成功: PID 1"
        );
        assert_eq!(decode_console_output(b""), "");
    }

    #[test]
    fn non_utf8_falls_back_to_oem_code_page() {
        // OEM コードページに依存するため、ASCII 部分が残り、パニックしないことだけを確認する
        let decoded = decode_console_output(b"ERROR: \x83\x76\x83\x8D\x83\x5A\x83\x58");
        assert!(decoded.starts_with("ERROR:"));
    }
}
