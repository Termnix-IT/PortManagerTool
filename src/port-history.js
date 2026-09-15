const { normalizeProcessName } = require('./process-safety');

const DEFAULT_INTERVAL_MS = 10000;
const LIST_LIMIT = 500;
const MEMORY_LIMIT = 2000;

// 常駐するOSのサービスは履歴に残しても役に立たないため対象外にする
const IGNORED_PROCESSES = new Set(['system', 'idle', 'svchost', 'lsass', 'wininit', 'services', 'spoolsv']);

function listenerKey(listener) {
  // 同じプロセスが IPv4/IPv6 の両方で待ち受けても1件として扱う。
  // PID は再利用されるため、プロセス開始時刻も含めて区別する
  return `${listener.port}:${listener.pid}:${listener.processStartedAt || ''}`;
}

function shouldTrack(listener) {
  if (listener.pid === 0 || listener.pid === 4) return false;
  return !IGNORED_PROCESSES.has(normalizeProcessName(listener.processName));
}

function dedupeListeners(listeners) {
  const byKey = new Map();
  for (const listener of listeners.filter(shouldTrack)) {
    const key = listenerKey(listener);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.addresses.includes(listener.localAddress)) existing.addresses.push(listener.localAddress);
    } else {
      byKey.set(key, {
        port: listener.port,
        pid: listener.pid,
        processName: listener.processName,
        processStartedAt: listener.processStartedAt,
        category: listener.category || '',
        categoryLabel: listener.categoryLabel || '',
        addresses: listener.localAddress ? [listener.localAddress] : [],
        commandLine: listener.commandLine || '',
      });
    }
  }
  return byKey;
}

/**
 * ポートの使用開始・解放を検出して履歴に残す。
 *
 * @param {object} deps
 * @param {() => Promise<object[]>} deps.scanTcpListeners  失敗時は例外（解放と誤認しないため）
 * @param {(pids: number[]) => Promise<Map<number, string>>} deps.getCommandLines
 * @param {ReturnType<import('./history-storage').createHistoryStorage>} deps.storage
 * @param {() => Date} [deps.now]
 */
function createPortHistory({ scanTcpListeners, getCommandLines, storage, now = () => new Date() }) {
  let events = storage.loadEvents();
  let previous = null; // このセッションで最後に検出した待受（Map）
  let intervalId = null;
  let running = false;
  let sequence = 0;
  const listeners = { event: [], error: [] };
  let failing = false;

  function emit(type, payload) {
    for (const callback of listeners[type]) callback(payload);
  }

  function createEvent(type, fields) {
    sequence += 1;
    const at = now().toISOString();
    return { id: `${Date.parse(at)}-${sequence}`, type, at, protocol: 'TCP', ...fields };
  }

  function record(newEvents) {
    if (newEvents.length === 0) return;
    storage.appendEvents(newEvents);
    // ファイル側の件数上限は次回起動時の読み込みで整理される。メモリ上も同じ上限で保つ
    events = [...events, ...newEvents].slice(-MEMORY_LIMIT);
    for (const event of newEvents) emit('event', event);
  }

  function toEventFields(entry, detection) {
    return {
      port: entry.port,
      pid: entry.pid,
      processName: entry.processName,
      processStartedAt: entry.processStartedAt,
      category: entry.category,
      categoryLabel: entry.categoryLabel,
      addresses: entry.addresses,
      commandLine: entry.commandLine,
      detection,
    };
  }

  async function attachCommandLines(entries) {
    if (entries.length === 0) return;
    try {
      const commandLines = await getCommandLines(entries.map((entry) => entry.pid));
      for (const entry of entries) entry.commandLine = commandLines.get(entry.pid) || '';
    } catch {
      // コマンドラインが取れなくても使用開始の記録は残す
    }
  }

  /**
   * 1回分の検出。
   * - 起動後初回は前回保存したスナップショットと比較する（detection: 'startup'）
   * - スナップショットが無い初回起動時は、既存の待受を「起動時に検出」として記録する
   * @returns {Promise<object[]>} 追加したイベント
   */
  async function poll() {
    if (running) return [];
    running = true;
    try {
      let scanned;
      try {
        scanned = await scanTcpListeners();
      } catch (err) {
        if (!failing) emit('error', err);
        failing = true;
        return [];
      }
      failing = false;

      const current = dedupeListeners(scanned);
      const isFirstPoll = previous === null;
      const baseline = isFirstPoll
        ? new Map((storage.loadSnapshot() || []).map((entry) => [listenerKey(entry), entry]))
        : previous;
      const detection = isFirstPoll ? 'startup' : 'poll';

      const started = [...current.entries()].filter(([key]) => !baseline.has(key)).map(([, entry]) => entry);
      const stopped = [...baseline.entries()].filter(([key]) => !current.has(key)).map(([, entry]) => entry);

      // 継続中の待受は前回取得したコマンドラインを引き継ぎ、新しいものだけ問い合わせる
      for (const [key, entry] of current) {
        if (baseline.has(key)) entry.commandLine = baseline.get(key).commandLine || '';
      }
      await attachCommandLines(started);

      const newEvents = [
        ...stopped.map((entry) => createEvent('stopped', toEventFields(entry, detection))),
        ...started.map((entry) => createEvent('started', toEventFields(entry, detection))),
      ];

      previous = current;
      // 変化が無ければ書き込まない（10秒ごとのディスク書き込みを避ける）
      if (isFirstPoll || newEvents.length > 0) {
        storage.saveSnapshot([...current.values()]);
      }
      record(newEvents);
      return newEvents;
    } finally {
      running = false;
    }
  }

  /** アプリから停止したことを記録する（kill-flow の成功結果） */
  function recordKill({ pid, port, protocol, processName, method, tree }) {
    const event = createEvent('killed', {
      protocol: protocol || 'TCP',
      port: port || null,
      pid,
      processName,
      method,
      tree: Boolean(tree),
      detection: 'app',
    });
    record([event]);
    return event;
  }

  function list({ limit = LIST_LIMIT } = {}) {
    return events.slice(-limit).reverse();
  }

  function clear() {
    storage.clearEvents();
    events = [];
  }

  function on(type, callback) {
    listeners[type].push(callback);
  }

  function start(intervalMs = DEFAULT_INTERVAL_MS) {
    stop();
    poll();
    intervalId = setInterval(poll, intervalMs);
  }

  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { poll, recordKill, list, clear, on, start, stop };
}

module.exports = { createPortHistory, listenerKey };
