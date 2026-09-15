const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonitor } = require('../src/monitor');

function createFakeStore(monitors) {
  const state = monitors.map((m) => ({ ...m }));
  return {
    state,
    getMonitors: () => state.map((m) => ({ ...m })),
    updateMonitor: (id, data) => {
      const target = state.find((m) => m.id === id);
      Object.assign(target, data);
      return target;
    },
    getSettings: () => ({ monitorIntervalMs: 5000 }),
  };
}

const baseMonitor = {
  id: 'mon_1',
  port: 3000,
  protocol: 'TCP',
  label: 'Next.js',
  enabled: true,
  notifyOnOccupied: true,
  notifyOnFreed: true,
  lastKnownState: 'free',
};

function occupiedMap() {
  return new Map([['TCP:3000', { occupied: true, processName: 'node', pid: 100 }]]);
}

test('tick: 状態変化で store を更新し、通知コールバックを呼ぶ', async () => {
  const store = createFakeStore([baseMonitor]);
  const monitor = createMonitor({ store, checkPorts: async () => occupiedMap() });
  const events = [];
  monitor.onStatusChanged((data) => events.push(data));

  await monitor.tick();

  assert.equal(store.state[0].lastKnownState, 'occupied');
  assert.equal(events.length, 1);
  assert.equal(events[0].oldState, 'free');
  assert.equal(events[0].newState, 'occupied');
  assert.equal(events[0].pid, 100);
});

test('tick: 状態が変わらなければ通知しない', async () => {
  const store = createFakeStore([{ ...baseMonitor, lastKnownState: 'occupied' }]);
  const monitor = createMonitor({ store, checkPorts: async () => occupiedMap() });
  const events = [];
  monitor.onStatusChanged((data) => events.push(data));

  await monitor.tick();

  assert.equal(events.length, 0);
});

test('tick: 通知OFFの方向は状態だけ更新して通知しない', async () => {
  const store = createFakeStore([{ ...baseMonitor, notifyOnOccupied: false }]);
  const monitor = createMonitor({ store, checkPorts: async () => occupiedMap() });
  const events = [];
  monitor.onStatusChanged((data) => events.push(data));

  await monitor.tick();

  assert.equal(store.state[0].lastKnownState, 'occupied');
  assert.equal(events.length, 0);
});

test('tick: 取得失敗時は状態を更新せず「解放」通知も出さない', async () => {
  const store = createFakeStore([{ ...baseMonitor, lastKnownState: 'occupied' }]);
  const monitor = createMonitor({ store, checkPorts: async () => { throw new Error('PowerShell timeout'); } });
  const events = [];
  const errors = [];
  monitor.onStatusChanged((data) => events.push(data));
  monitor.onError((err) => errors.push(err));

  await monitor.tick();
  await monitor.tick();

  assert.equal(store.state[0].lastKnownState, 'occupied');
  assert.equal(events.length, 0);
  assert.equal(errors.length, 1, '連続失敗中のエラー通知は1回だけ');
});

test('tick: 復旧後に再び失敗したらエラーを通知する', async () => {
  const store = createFakeStore([baseMonitor]);
  let fail = true;
  const monitor = createMonitor({
    store,
    checkPorts: async () => {
      if (fail) throw new Error('failed');
      return occupiedMap();
    },
  });
  const errors = [];
  monitor.onError((err) => errors.push(err));

  await monitor.tick();
  fail = false;
  await monitor.tick();
  fail = true;
  await monitor.tick();

  assert.equal(errors.length, 2);
});

test('tick: 前回の確認が終わる前の呼び出しはスキップする', async () => {
  const store = createFakeStore([baseMonitor]);
  let calls = 0;
  let release;
  const monitor = createMonitor({
    store,
    checkPorts: () => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve(occupiedMap()); });
    },
  });

  const first = monitor.tick();
  await monitor.tick();
  release();
  await first;

  assert.equal(calls, 1);
});

test('tick: 有効な監視がなければ確認しない', async () => {
  const store = createFakeStore([{ ...baseMonitor, enabled: false }]);
  let calls = 0;
  const monitor = createMonitor({ store, checkPorts: async () => { calls += 1; return new Map(); } });

  await monitor.tick();

  assert.equal(calls, 0);
});
