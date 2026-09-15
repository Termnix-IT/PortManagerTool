const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../src/port-classifier');

const listen = (LocalPort, ProcessName, extra = {}) => ({ Protocol: 'TCP', State: 'Listen', LocalPort, ProcessName, ...extra });

test('classify: 開発プロセスは既知ポートのラベルを優先する', () => {
  assert.deepEqual(classify(listen(5173, 'node')), { category: 'dev', label: 'Vite' });
  assert.deepEqual(classify(listen(4567, 'node')), { category: 'dev', label: 'Node.js' });
  assert.deepEqual(classify(listen(8000, 'python.exe')), { category: 'dev', label: 'Django / FastAPI' });
});

test('classify: DBプロセスはポート番号に関係なくDB', () => {
  assert.deepEqual(classify(listen(15432, 'postgres')), { category: 'db', label: 'PostgreSQL' });
});

test('classify: プロセス名で判定できなければポート番号で判定する（Docker経由など）', () => {
  assert.deepEqual(classify(listen(5432, 'com.docker.backend')), { category: 'db', label: 'PostgreSQL' });
  assert.deepEqual(classify(listen(3000, 'wslrelay')), { category: 'dev', label: 'React / Next.js / Express' });
});

test('classify: OSプロセスはポート番号だけでは分類しない', () => {
  assert.equal(classify(listen(5000, 'svchost')), null);
  assert.equal(classify(listen(8080, '<unknown>')), null);
});

test('classify: TCPのEstablishedは対象外、UDPは対象', () => {
  assert.equal(classify(listen(3000, 'node', { State: 'Established' })), null);
  assert.deepEqual(classify({ Protocol: 'UDP', State: '--', LocalPort: 9229, ProcessName: 'node' }), { category: 'dev', label: 'Node Inspector' });
});

test('classify: 該当しないポートは null', () => {
  assert.equal(classify(listen(12345, 'chrome')), null);
});
