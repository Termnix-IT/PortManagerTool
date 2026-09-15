const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortHistory } = require('../src/port-history');

function memoryStorage({ events = [], snapshot = null } = {}) {
  const state = { events: [...events], snapshot, snapshotWrites: 0 };
  return {
    state,
    loadEvents: () => [...state.events],
    appendEvents: (list) => { state.events.push(...list); },
    loadSnapshot: () => state.snapshot,
    saveSnapshot: (listeners) => { state.snapshot = listeners; state.snapshotWrites += 1; },
    clearEvents: () => { state.events = []; },
  };
}

const vite = { port: 5173, pid: 100, processName: 'node', processStartedAt: '2026-09-16T01:00:00Z', localAddress: '::1', category: 'dev', categoryLabel: 'Vite' };
const viteV4 = { ...vite, localAddress: '127.0.0.1' };
const django = { port: 8000, pid: 200, processName: 'python', processStartedAt: '2026-09-16T02:00:00Z', localAddress: '0.0.0.0', category: 'dev', categoryLabel: 'Django / FastAPI' };
const svchost = { port: 135, pid: 900, processName: 'svchost', processStartedAt: null, localAddress: '0.0.0.0', category: '', categoryLabel: '' };

function setup({ scans, storage = memoryStorage(), commandLines = { 100: 'node vite', 200: 'python manage.py runserver' } }) {
  const queue = [...scans];
  const commandLineCalls = [];
  const history = createPortHistory({
    scanTcpListeners: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    getCommandLines: async (pids) => {
      commandLineCalls.push(pids);
      return new Map(pids.map((pid) => [pid, commandLines[pid] || '']));
    },
    storage,
    now: () => new Date('2026-09-16T03:00:00Z'),
  });
  return { history, storage, commandLineCalls };
}

test('poll: 初回起動（スナップショット無し）は既存の待受を「起動時に検出」として記録する', async () => {
  const { history, storage } = setup({ scans: [[vite, viteV4, svchost]] });

  const events = await history.poll();

  assert.equal(events.length, 1, 'IPv4/IPv6 の重複と svchost は除外');
  assert.equal(events[0].type, 'started');
  assert.equal(events[0].detection, 'startup');
  assert.equal(events[0].commandLine, 'node vite');
  assert.deepEqual(events[0].addresses, ['::1', '127.0.0.1']);
  assert.equal(storage.state.events.length, 1);
  assert.equal(storage.state.snapshot.length, 1);
});

test('poll: 2回目以降は差分から使用開始/解放を記録し、新しいプロセスだけコマンドラインを問い合わせる', async () => {
  const { history, commandLineCalls } = setup({ scans: [[vite], [vite, django], [django]] });

  await history.poll();
  const second = await history.poll();
  const third = await history.poll();

  assert.deepEqual(second.map((e) => [e.type, e.port, e.detection]), [['started', 8000, 'poll']]);
  assert.equal(second[0].commandLine, 'python manage.py runserver');
  assert.deepEqual(third.map((e) => [e.type, e.port]), [['stopped', 5173]]);
  assert.equal(third[0].commandLine, 'node vite', '解放時は検出済みのコマンドラインを残す');
  assert.deepEqual(commandLineCalls, [[100], [200]]);
});

test('poll: 再起動後は保存済みスナップショットと比較し、継続中の待受は記録しない', async () => {
  const storage = memoryStorage({ snapshot: [{ ...vite, addresses: ['::1'], commandLine: 'node vite' }] });
  const { history } = setup({ scans: [[vite, django]], storage });

  const events = await history.poll();

  assert.deepEqual(events.map((e) => [e.type, e.port, e.detection]), [['started', 8000, 'startup']]);
});

test('poll: アプリ停止中に解放されたものは起動時に「解放」として記録する', async () => {
  const storage = memoryStorage({ snapshot: [{ ...django, addresses: ['0.0.0.0'], commandLine: 'python manage.py runserver' }] });
  const { history } = setup({ scans: [[]], storage });

  const events = await history.poll();

  assert.deepEqual(events.map((e) => [e.type, e.port, e.detection]), [['stopped', 8000, 'startup']]);
});

test('poll: PID が同じでもプロセス開始時刻が違えば別のプロセスとして扱う（PID再利用）', async () => {
  const reused = { ...vite, processName: 'java', processStartedAt: '2026-09-16T02:30:00Z' };
  const { history } = setup({ scans: [[vite], [reused]] });

  await history.poll();
  const events = await history.poll();

  assert.deepEqual(events.map((e) => [e.type, e.processName]), [['stopped', 'node'], ['started', 'java']]);
});

test('poll: スキャン失敗時は何も記録せず、次に成功したとき差分を取る', async () => {
  const { history, storage } = setup({ scans: [[vite], new Error('timeout'), [vite]] });
  const errors = [];
  history.on('error', (err) => errors.push(err));

  await history.poll();
  const failed = await history.poll();
  const recovered = await history.poll();

  assert.deepEqual(failed, []);
  assert.deepEqual(recovered, [], '失敗を「全ポート解放」と誤認しない');
  assert.equal(errors.length, 1);
  assert.equal(storage.state.events.length, 1);
});

test('poll: 変化が無ければスナップショットを書き込まない', async () => {
  const { history, storage } = setup({ scans: [[vite], [vite], [vite]] });
  await history.poll();
  await history.poll();
  await history.poll();
  assert.equal(storage.state.snapshotWrites, 1);
});

test('poll: コマンドラインが取れなくても使用開始は記録する', async () => {
  const history = createPortHistory({
    scanTcpListeners: async () => [django],
    getCommandLines: async () => { throw new Error('access denied'); },
    storage: memoryStorage(),
  });
  const events = await history.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].commandLine, '');
});

test('recordKill / list / clear / on(event)', async () => {
  const { history, storage } = setup({ scans: [[vite]] });
  const emitted = [];
  history.on('event', (event) => emitted.push(event.type));

  await history.poll();
  history.recordKill({ pid: 100, port: 5173, protocol: 'TCP', processName: 'node.exe', method: 'force', tree: true });

  const listed = history.list();
  assert.deepEqual(listed.map((e) => e.type), ['killed', 'started'], '新しい順');
  assert.equal(listed[0].method, 'force');
  assert.equal(listed[0].tree, true);
  assert.deepEqual(emitted, ['started', 'killed']);
  assert.equal(new Set(listed.map((e) => e.id)).size, 2, 'id は一意');

  history.clear();
  assert.deepEqual(history.list(), []);
  assert.deepEqual(storage.state.events, []);
});

test('list: 保存済みのイベントも新しい順で返し、件数を制限できる', () => {
  const storage = memoryStorage({ events: [{ id: '1', type: 'started' }, { id: '2', type: 'stopped' }, { id: '3', type: 'started' }] });
  const history = createPortHistory({ scanTcpListeners: async () => [], getCommandLines: async () => new Map(), storage });
  assert.deepEqual(history.list({ limit: 2 }).map((e) => e.id), ['3', '2']);
});
