const fsDefault = require('fs');
const path = require('path');

const EVENTS_FILE = 'port-history.jsonl';
const SNAPSHOT_FILE = 'port-history-snapshot.json';

/**
 * ポート履歴の永続化。
 * - イベントは1行1件のJSONL（追記のみで済むため、件数が増えてもファイル全体を書き直さない）
 * - 前回検出した待受の一覧（スナップショット）は、アプリ再起動後の差分検出に使う
 *
 * @param {{ dir: string, fs?: typeof import('fs'), maxEvents?: number, retentionDays?: number, now?: () => Date }} options
 */
function createHistoryStorage({ dir, fs = fsDefault, maxEvents = 2000, retentionDays = 30, now = () => new Date() }) {
  const eventsPath = path.join(dir, EVENTS_FILE);
  const snapshotPath = path.join(dir, SNAPSHOT_FILE);

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * 保持期間・件数を超えた分を捨てて返す。捨てた場合はファイルを書き直す。
   * 壊れた行（書き込み途中の終了など）は読み飛ばす。
   */
  function loadEvents() {
    let text;
    try {
      text = fs.readFileSync(eventsPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const lines = text.split('\n').filter((line) => line.trim());
    const parsed = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // 壊れた行は捨てる
      }
    }

    const cutoff = now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const kept = parsed.filter((event) => Date.parse(event.at) >= cutoff).slice(-maxEvents);
    if (kept.length !== lines.length) {
      writeAll(kept);
    }
    return kept;
  }

  function writeAll(events) {
    ensureDir();
    const body = events.map((event) => JSON.stringify(event)).join('\n');
    const tmpPath = `${eventsPath}.tmp`;
    fs.writeFileSync(tmpPath, body ? `${body}\n` : '', 'utf8');
    fs.renameSync(tmpPath, eventsPath);
  }

  function appendEvents(events) {
    if (events.length === 0) return;
    ensureDir();
    fs.appendFileSync(eventsPath, events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
  }

  function loadSnapshot() {
    try {
      const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      return Array.isArray(data.listeners) ? data.listeners : null;
    } catch {
      // 無い・壊れている場合は「前回の状態が不明」として扱う
      return null;
    }
  }

  function saveSnapshot(listeners) {
    ensureDir();
    const tmpPath = `${snapshotPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ savedAt: now().toISOString(), listeners }), 'utf8');
    fs.renameSync(tmpPath, snapshotPath);
  }

  function clearEvents() {
    writeAll([]);
  }

  return { loadEvents, appendEvents, writeAll, loadSnapshot, saveSnapshot, clearEvents, eventsPath };
}

module.exports = { createHistoryStorage };
