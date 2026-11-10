//! TCP/UDP のエンドポイント一覧（IP Helper API）。
//! PowerShell の Get-NetTCPConnection / Get-NetUDPEndpoint と同じ情報を、プロセスを起動せずに取得する。

use crate::system::{TcpRow, TcpState, UdpRow};
use std::ffi::c_void;
use std::mem::{offset_of, size_of};
use std::net::{Ipv4Addr, Ipv6Addr};
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID,
    MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, MIB_UDP6ROW_OWNER_PID, MIB_UDP6TABLE_OWNER_PID,
    MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

/// 表の取得中に接続が増えるとバッファが足りなくなるため、数回までやり直す
const MAX_ATTEMPTS: usize = 5;

/// テーブルを取得する。行に u32 を含むため、4バイト境界に揃うよう u32 の配列で確保する
fn fetch_table(
    name: &str,
    fetch: impl Fn(Option<*mut c_void>, *mut u32) -> u32,
) -> Result<(Vec<u32>, usize), String> {
    let mut size: u32 = 0;
    for _ in 0..MAX_ATTEMPTS {
        let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
        let pointer = if buffer.is_empty() {
            None
        } else {
            Some(buffer.as_mut_ptr().cast::<c_void>())
        };
        let code = fetch(pointer, &mut size);
        if code == NO_ERROR.0 && !buffer.is_empty() {
            let bytes = buffer.len() * 4;
            return Ok((buffer, bytes));
        }
        if code != ERROR_INSUFFICIENT_BUFFER.0 && code != NO_ERROR.0 {
            return Err(format!(
                "{name}の一覧を取得できませんでした（エラーコード {code}）"
            ));
        }
    }
    Err(format!(
        "{name}の一覧を取得できませんでした（接続数の変化が続いたため）"
    ))
}

/// `dwNumEntries` の後に行が続く可変長テーブルから、行のスライスを取り出す
///
/// # Safety
/// `buffer` は `Row` の行を持つテーブルとして OS が書き込んだものであり、`rows_offset` はその行の開始位置であること
unsafe fn rows<Row>(buffer: &[u32], bytes: usize, rows_offset: usize) -> Result<&[Row], String> {
    let count = buffer.first().copied().unwrap_or(0) as usize;
    let needed = count
        .checked_mul(size_of::<Row>())
        .and_then(|n| n.checked_add(rows_offset));
    if needed.is_none_or(|n| n > bytes) {
        return Err("取得した一覧の大きさが不正です".into());
    }
    let first = buffer.as_ptr().cast::<u8>().add(rows_offset).cast::<Row>();
    Ok(std::slice::from_raw_parts(first, count))
}

/// ポート番号はネットワークバイトオーダーで下位16ビットに入っている
fn port(value: u32) -> u16 {
    u16::from_be(value as u16)
}

/// IPv4 アドレスはネットワークバイトオーダーの u32 として格納されている
fn ipv4(value: u32) -> String {
    Ipv4Addr::from(value.to_ne_bytes()).to_string()
}

fn ipv6(bytes: [u8; 16], scope_id: u32) -> String {
    let address = Ipv6Addr::from(bytes);
    if scope_id != 0 {
        format!("{address}%{scope_id}")
    } else {
        address.to_string()
    }
}

fn tcp_table_for(family: u16) -> Result<(Vec<u32>, usize), String> {
    fetch_table("TCP", |pointer, size| unsafe {
        GetExtendedTcpTable(
            pointer,
            size,
            false,
            u32::from(family),
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    })
}

fn udp_table_for(family: u16) -> Result<(Vec<u32>, usize), String> {
    fetch_table("UDP", |pointer, size| unsafe {
        GetExtendedUdpTable(
            pointer,
            size,
            false,
            u32::from(family),
            UDP_TABLE_OWNER_PID,
            0,
        )
    })
}

pub fn tcp_table() -> Result<Vec<TcpRow>, String> {
    let mut result = Vec::new();

    let (buffer, bytes) = tcp_table_for(AF_INET.0)?;
    let v4 = unsafe {
        rows::<MIB_TCPROW_OWNER_PID>(&buffer, bytes, offset_of!(MIB_TCPTABLE_OWNER_PID, table))?
    };
    result.extend(v4.iter().map(|row| TcpRow {
        local_address: ipv4(row.dwLocalAddr),
        local_port: port(row.dwLocalPort),
        remote_address: ipv4(row.dwRemoteAddr),
        remote_port: port(row.dwRemotePort),
        state: TcpState::from_mib(row.dwState),
        pid: row.dwOwningPid,
    }));

    let (buffer, bytes) = tcp_table_for(AF_INET6.0)?;
    let v6 = unsafe {
        rows::<MIB_TCP6ROW_OWNER_PID>(&buffer, bytes, offset_of!(MIB_TCP6TABLE_OWNER_PID, table))?
    };
    result.extend(v6.iter().map(|row| TcpRow {
        local_address: ipv6(row.ucLocalAddr, row.dwLocalScopeId),
        local_port: port(row.dwLocalPort),
        remote_address: ipv6(row.ucRemoteAddr, row.dwRemoteScopeId),
        remote_port: port(row.dwRemotePort),
        state: TcpState::from_mib(row.dwState),
        pid: row.dwOwningPid,
    }));

    Ok(result)
}

pub fn udp_table() -> Result<Vec<UdpRow>, String> {
    let mut result = Vec::new();

    let (buffer, bytes) = udp_table_for(AF_INET.0)?;
    let v4 = unsafe {
        rows::<MIB_UDPROW_OWNER_PID>(&buffer, bytes, offset_of!(MIB_UDPTABLE_OWNER_PID, table))?
    };
    result.extend(v4.iter().map(|row| UdpRow {
        local_address: ipv4(row.dwLocalAddr),
        local_port: port(row.dwLocalPort),
        pid: row.dwOwningPid,
    }));

    let (buffer, bytes) = udp_table_for(AF_INET6.0)?;
    let v6 = unsafe {
        rows::<MIB_UDP6ROW_OWNER_PID>(&buffer, bytes, offset_of!(MIB_UDP6TABLE_OWNER_PID, table))?
    };
    result.extend(v6.iter().map(|row| UdpRow {
        local_address: ipv6(row.ucLocalAddr, row.dwLocalScopeId),
        local_port: port(row.dwLocalPort),
        pid: row.dwOwningPid,
    }));

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream, UdpSocket};

    #[test]
    fn converts_network_byte_order() {
        assert_eq!(port(u32::from(80u16.to_be())), 80);
        assert_eq!(ipv4(u32::from_ne_bytes([127, 0, 0, 1])), "127.0.0.1");
        assert_eq!(ipv6(Ipv6Addr::LOCALHOST.octets(), 0), "::1");
        assert_eq!(
            ipv6("fe80::1".parse::<Ipv6Addr>().unwrap().octets(), 12),
            "fe80::1%12"
        );
    }

    #[test]
    fn finds_own_tcp_listener_and_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let listen_port = listener.local_addr().unwrap().port();
        let _client = TcpStream::connect(("127.0.0.1", listen_port)).unwrap();
        let pid = std::process::id();

        let rows = tcp_table().unwrap();
        let listening = rows
            .iter()
            .find(|r| r.local_port == listen_port && r.state == TcpState::Listen)
            .expect("待受が一覧にあること");
        assert_eq!(listening.pid, pid);
        assert_eq!(listening.local_address, "127.0.0.1");
        assert!(rows.iter().any(|r| r.remote_port == listen_port
            && r.state == TcpState::Established
            && r.pid == pid));
    }

    #[test]
    fn finds_own_udp_endpoints_for_ipv4_and_ipv6() {
        let v4 = UdpSocket::bind("127.0.0.1:0").unwrap();
        let v6 = UdpSocket::bind("[::1]:0").unwrap();
        let rows = udp_table().unwrap();
        let pid = std::process::id();
        for (socket, address) in [(&v4, "127.0.0.1"), (&v6, "::1")] {
            let local_port = socket.local_addr().unwrap().port();
            assert!(
                rows.iter().any(|r| r.local_port == local_port
                    && r.pid == pid
                    && r.local_address == address),
                "{address}:{local_port} が一覧にあること"
            );
        }
    }
}
