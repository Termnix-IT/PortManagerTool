const store = require('./store');
const { checkPorts } = require('./port-scanner');

let intervalId = null;
let statusChangedCallback = null;

function onStatusChanged(callback) {
  statusChangedCallback = callback;
}

async function tick() {
  const monitors = store.getMonitors().filter((m) => m.enabled);
  if (monitors.length === 0) return;

  const ports = [...new Set(monitors.map((m) => m.port))];
  const portMap = await checkPorts(ports);

  for (const mon of monitors) {
    const info = portMap.get(mon.port);
    if (!info) continue;

    const newState = info.occupied ? 'occupied' : 'free';
    if (newState === mon.lastKnownState) continue;

    // State changed
    const shouldNotify =
      (newState === 'occupied' && mon.notifyOnOccupied) ||
      (newState === 'free' && mon.notifyOnFreed);

    // Update stored state
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
  const interval = settings.monitorIntervalMs || 5000;
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

module.exports = { onStatusChanged, start, stop, restart };
