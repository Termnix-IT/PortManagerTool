const DEFAULT_INTERVAL_MS = 5000;

/**
 * @param {object} deps
 * @param {{ getMonitors: Function, updateMonitor: Function, getSettings: Function }} deps.store
 * @param {(targets: object[]) => Promise<Map>} deps.checkPorts
 */
function createMonitor({ store, checkPorts }) {
  let intervalId = null;
  let statusChangedCallback = null;
  let errorCallback = null;
  let running = false;
  let failing = false;

  function onStatusChanged(callback) {
    statusChangedCallback = callback;
  }

  // 連続失敗中は最初の1回だけ通知する（ログやUIを埋めないため）
  function onError(callback) {
    errorCallback = callback;
  }

  async function tick() {
    // PowerShellは数秒かかることがあり、間隔が短いと前回の確認と重なるためスキップする
    if (running) return;
    running = true;
    try {
      await runCheck();
    } finally {
      running = false;
    }
  }

  async function runCheck() {
    const monitors = store.getMonitors().filter((m) => m.enabled);
    if (monitors.length === 0) return;

    const targets = monitors.map((m) => ({ port: m.port, protocol: m.protocol || 'TCP' }));
    let portMap;
    try {
      portMap = await checkPorts(targets);
    } catch (err) {
      // 取得失敗時は状態を更新しない。空き扱いにすると誤った「解放」通知が出る
      if (!failing && errorCallback) errorCallback(err);
      failing = true;
      return;
    }
    failing = false;

    for (const mon of monitors) {
      const info = portMap.get(`${mon.protocol || 'TCP'}:${Number(mon.port)}`);
      if (!info) continue;

      const newState = info.occupied ? 'occupied' : 'free';
      if (newState === mon.lastKnownState) continue;

      const shouldNotify =
        (newState === 'occupied' && mon.notifyOnOccupied) ||
        (newState === 'free' && mon.notifyOnFreed);

      store.updateMonitor(mon.id, { lastKnownState: newState });

      if (shouldNotify && statusChangedCallback) {
        statusChangedCallback({
          monitorId: mon.id,
          port: mon.port,
          label: mon.label,
          oldState: mon.lastKnownState,
          newState,
          processName: info.processName,
          pid: info.pid,
        });
      }
    }
  }

  function start() {
    const settings = store.getSettings();
    const interval = settings.monitorIntervalMs || DEFAULT_INTERVAL_MS;
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(tick, interval);
  }

  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function restart() {
    stop();
    start();
  }

  return { onStatusChanged, onError, tick, start, stop, restart };
}

module.exports = { createMonitor };
