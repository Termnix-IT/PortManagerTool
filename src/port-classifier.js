// 開発環境で残りがちなポートを「dev」「db」に分類する。
// 判定はプロセス名を優先し、該当しない場合にポート番号のカタログで補う。

const DEV_PROCESSES = {
  node: 'Node.js',
  deno: 'Deno',
  bun: 'Bun',
  python: 'Python',
  pythonw: 'Python',
  py: 'Python',
  uvicorn: 'Uvicorn',
  gunicorn: 'Gunicorn',
  flask: 'Flask',
  ruby: 'Ruby',
  php: 'PHP',
  java: 'Java',
  dotnet: '.NET',
  hugo: 'Hugo',
};

const DB_PROCESSES = {
  mysqld: 'MySQL',
  mariadbd: 'MariaDB',
  postgres: 'PostgreSQL',
  'redis-server': 'Redis',
  mongod: 'MongoDB',
  mongos: 'MongoDB',
  sqlservr: 'SQL Server',
  memcached: 'Memcached',
  elasticsearch: 'Elasticsearch',
  influxd: 'InfluxDB',
  couchdb: 'CouchDB',
  cockroach: 'CockroachDB',
};

const DEV_PORTS = {
  3000: 'React / Next.js / Express',
  3001: 'Node.js',
  3002: 'Node.js',
  3003: 'Node.js',
  4000: 'Phoenix / Gatsby',
  4173: 'Vite Preview',
  4200: 'Angular',
  4321: 'Astro',
  5000: 'Flask',
  5173: 'Vite',
  5174: 'Vite',
  5500: 'Live Server',
  6006: 'Storybook',
  8000: 'Django / FastAPI',
  8001: 'Python',
  8080: 'Dev Server',
  8081: 'Metro / Dev Server',
  8888: 'Jupyter',
  9229: 'Node Inspector',
};

const DB_PORTS = {
  1433: 'SQL Server',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  5984: 'CouchDB',
  6379: 'Redis',
  8086: 'InfluxDB',
  9042: 'Cassandra',
  9200: 'Elasticsearch',
  11211: 'Memcached',
  26257: 'CockroachDB',
  27017: 'MongoDB',
};

// ポート番号だけで判定するとOS常駐サービスを誤検出するため除外する
const SYSTEM_PROCESSES = new Set(['system', 'idle', 'svchost', 'lsass', 'wininit', 'services', 'spoolsv', '<unknown>']);

function normalizeName(processName) {
  return String(processName || '').toLowerCase().replace(/\.exe$/, '');
}

/**
 * @returns {{ category: 'dev' | 'db', label: string } | null}
 */
function classify(port) {
  // Established はクライアント側の接続なので「残っているサーバー」ではない
  if (port.Protocol === 'TCP' && port.State !== 'Listen') return null;

  const name = normalizeName(port.ProcessName);
  const portNumber = Number(port.LocalPort);

  if (DB_PROCESSES[name]) {
    return { category: 'db', label: DB_PROCESSES[name] };
  }
  if (DEV_PROCESSES[name]) {
    return { category: 'dev', label: DEV_PORTS[portNumber] || DEV_PROCESSES[name] };
  }
  if (SYSTEM_PROCESSES.has(name)) return null;
  if (DB_PORTS[portNumber]) {
    return { category: 'db', label: DB_PORTS[portNumber] };
  }
  if (DEV_PORTS[portNumber]) {
    return { category: 'dev', label: DEV_PORTS[portNumber] };
  }
  return null;
}

module.exports = { classify };
