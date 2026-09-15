// 履歴イベントの表示用変換と絞り込み（DOMに依存しない）

export const HISTORY_TYPE_LABELS = {
  started: '使用開始',
  stopped: '解放',
  killed: 'アプリで停止',
};

export function historyTypeLabel(event) {
  if (event.detection === 'startup') {
    if (event.type === 'started') return '使用中を検出';
    if (event.type === 'stopped') return '解放を検出';
  }
  return HISTORY_TYPE_LABELS[event.type] || event.type;
}

export function historyTypeClass(event) {
  if (event.type === 'started') return 'active';
  if (event.type === 'killed') return 'busy';
  return 'muted';
}

/**
 * 表の「詳細」欄に出す説明。
 * 起動時の検出は発生時刻が分からないため、その旨とプロセス開始時刻を示す。
 */
export function describeHistoryEvent(event, formatDateTime) {
  if (event.type === 'killed') {
    const method = event.method === 'graceful' ? '通常停止' : '強制停止';
    return `${method}${event.tree ? '（子プロセスを含む）' : ''}`;
  }
  const notes = [];
  if (event.detection === 'startup' && event.type === 'started') {
    notes.push('アプリ起動時に使用中だったため、使用開始の正確な時刻は不明です');
  }
  if (event.detection === 'startup' && event.type === 'stopped') {
    notes.push('アプリを閉じている間に解放されました');
  }
  if (event.processStartedAt) {
    notes.push(`プロセス開始: ${formatDateTime(new Date(event.processStartedAt))}`);
  }
  return notes.join(' / ');
}

/**
 * @param {object[]} events
 * @param {{ type?: string, category?: string, text?: string }} filters
 */
export function filterHistory(events, { type = 'ALL', category = 'ALL', text = '' } = {}) {
  const query = text.trim().toLowerCase();
  return events.filter((event) => {
    if (type !== 'ALL' && event.type !== type) return false;
    if (category !== 'ALL' && event.category !== category) return false;
    if (query) {
      const haystack = [event.port, event.pid, event.processName, event.categoryLabel, event.commandLine]
        .map((value) => value ?? '')
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

// ダッシュボードの「最近のイベント」に流すのは、アプリ起動中に検出した開発/DBプロセスの出入りのみ。
// 常駐アプリの出入りや起動時のまとめて検出で埋まらないようにする。アプリからの停止は停止操作側で記録済み
export function isNotableHistoryEvent(event) {
  return event.type !== 'killed' && Boolean(event.category) && event.detection === 'poll';
}

export function summarizeHistoryEvent(event) {
  const who = `${event.processName}${event.categoryLabel ? `（${event.categoryLabel}）` : ''}`;
  if (event.type === 'started') return `ポート ${event.port} を ${who} が使い始めました`;
  if (event.type === 'stopped') return `ポート ${event.port} を ${who} が解放しました`;
  return `ポート ${event.port} の ${event.processName} を停止しました`;
}
