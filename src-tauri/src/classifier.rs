//! 開発環境で残りがちなポートを「dev」「db」に分類する。
//! 判定はプロセス名を優先し、該当しない場合にポート番号のカタログで補う。

use crate::validation::Protocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Dev,
    Db,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Dev => "dev",
            Category::Db => "db",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Classification {
    pub category: Category,
    pub label: &'static str,
}

fn dev_process(name: &str) -> Option<&'static str> {
    Some(match name {
        "node" => "Node.js",
        "deno" => "Deno",
        "bun" => "Bun",
        "python" | "pythonw" | "py" => "Python",
        "uvicorn" => "Uvicorn",
        "gunicorn" => "Gunicorn",
        "flask" => "Flask",
        "ruby" => "Ruby",
        "php" => "PHP",
        "java" => "Java",
        "dotnet" => ".NET",
        "hugo" => "Hugo",
        _ => return None,
    })
}

fn db_process(name: &str) -> Option<&'static str> {
    Some(match name {
        "mysqld" => "MySQL",
        "mariadbd" => "MariaDB",
        "postgres" => "PostgreSQL",
        "redis-server" => "Redis",
        "mongod" | "mongos" => "MongoDB",
        "sqlservr" => "SQL Server",
        "memcached" => "Memcached",
        "elasticsearch" => "Elasticsearch",
        "influxd" => "InfluxDB",
        "couchdb" => "CouchDB",
        "cockroach" => "CockroachDB",
        _ => return None,
    })
}

fn dev_port(port: u16) -> Option<&'static str> {
    Some(match port {
        3000 => "React / Next.js / Express",
        3001..=3003 => "Node.js",
        4000 => "Phoenix / Gatsby",
        4173 => "Vite Preview",
        4200 => "Angular",
        4321 => "Astro",
        5000 => "Flask",
        5173 | 5174 => "Vite",
        5500 => "Live Server",
        6006 => "Storybook",
        8000 => "Django / FastAPI",
        8001 => "Python",
        8080 => "Dev Server",
        8081 => "Metro / Dev Server",
        8888 => "Jupyter",
        9229 => "Node Inspector",
        _ => return None,
    })
}

fn db_port(port: u16) -> Option<&'static str> {
    Some(match port {
        1433 => "SQL Server",
        3306 => "MySQL",
        5432 => "PostgreSQL",
        5984 => "CouchDB",
        6379 => "Redis",
        8086 => "InfluxDB",
        9042 => "Cassandra",
        9200 => "Elasticsearch",
        11211 => "Memcached",
        26257 => "CockroachDB",
        27017 => "MongoDB",
        _ => return None,
    })
}

/// ポート番号だけで判定するとOS常駐サービスを誤検出するため除外する
fn is_system_process(name: &str) -> bool {
    matches!(
        name,
        "system" | "idle" | "svchost" | "lsass" | "wininit" | "services" | "spoolsv" | "<unknown>"
    )
}

/// 比較用のプロセス名（小文字、`.exe` なし）
pub fn normalize_process_name(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    match lower.strip_suffix(".exe") {
        Some(stripped) => stripped.to_string(),
        None => lower,
    }
}

/// `is_listen` は TCP の待受かどうか。Established はクライアント側の接続なので「残っているサーバー」ではない
pub fn classify(
    protocol: Protocol,
    is_listen: bool,
    port: u16,
    process_name: &str,
) -> Option<Classification> {
    if protocol == Protocol::Tcp && !is_listen {
        return None;
    }
    let name = normalize_process_name(process_name);
    if let Some(label) = db_process(&name) {
        return Some(Classification {
            category: Category::Db,
            label,
        });
    }
    if let Some(process_label) = dev_process(&name) {
        return Some(Classification {
            category: Category::Dev,
            label: dev_port(port).unwrap_or(process_label),
        });
    }
    if is_system_process(&name) {
        return None;
    }
    if let Some(label) = db_port(port) {
        return Some(Classification {
            category: Category::Db,
            label,
        });
    }
    dev_port(port).map(|label| Classification {
        category: Category::Dev,
        label,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listen(port: u16, name: &str) -> Option<(&'static str, &'static str)> {
        classify(Protocol::Tcp, true, port, name).map(|c| (c.category.as_str(), c.label))
    }

    #[test]
    fn dev_process_prefers_known_port_label() {
        assert_eq!(listen(5173, "node"), Some(("dev", "Vite")));
        assert_eq!(listen(4567, "node"), Some(("dev", "Node.js")));
        assert_eq!(
            listen(8000, "python.exe"),
            Some(("dev", "Django / FastAPI"))
        );
    }

    #[test]
    fn db_process_is_db_regardless_of_port() {
        assert_eq!(listen(15432, "postgres"), Some(("db", "PostgreSQL")));
    }

    #[test]
    fn falls_back_to_port_catalog() {
        assert_eq!(
            listen(5432, "com.docker.backend"),
            Some(("db", "PostgreSQL"))
        );
        assert_eq!(
            listen(3000, "wslrelay"),
            Some(("dev", "React / Next.js / Express"))
        );
    }

    #[test]
    fn os_processes_are_not_classified_by_port() {
        assert_eq!(listen(5000, "svchost"), None);
        assert_eq!(listen(8080, "<unknown>"), None);
    }

    #[test]
    fn tcp_established_is_ignored_but_udp_is_classified() {
        assert_eq!(classify(Protocol::Tcp, false, 3000, "node"), None);
        assert_eq!(
            classify(Protocol::Udp, false, 9229, "node").map(|c| (c.category.as_str(), c.label)),
            Some(("dev", "Node Inspector"))
        );
    }

    #[test]
    fn unknown_ports_are_none() {
        assert_eq!(listen(12345, "chrome"), None);
    }
}
