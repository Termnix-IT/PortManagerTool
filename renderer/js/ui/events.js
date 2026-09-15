import { escapeHtml, formatTime } from '../lib/format.js';
import { byId } from './dom.js';

const EVENT_LIMIT = 12;

let eventLog = [];

export function pushEvent(type, message) {
  eventLog = [{ type, message, time: new Date() }, ...eventLog].slice(0, EVENT_LIMIT);
  renderEvents();
}

export function renderEvents() {
  const list = byId('event-list');
  if (eventLog.length === 0) {
    list.innerHTML = '<p class="empty-message">イベントはまだありません</p>';
    return;
  }

  list.innerHTML = eventLog.map((event) => `
    <div class="event-item">
      <span class="event-type ${event.type === 'warn' ? 'warn' : 'ok'}">${event.type === 'warn' ? '!' : '✓'}</span>
      <span class="event-message">${escapeHtml(event.message)}</span>
      <span class="event-time">${formatTime(event.time)}</span>
    </div>
  `).join('');
}

export function initEvents() {
  byId('btn-clear-events').addEventListener('click', () => {
    eventLog = [];
    renderEvents();
  });
  renderEvents();
}
