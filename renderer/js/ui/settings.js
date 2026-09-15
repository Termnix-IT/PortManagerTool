import { state } from '../state.js';
import { byId, showToast } from './dom.js';
import { pushEvent } from './events.js';

const MIN_INTERVAL_SEC = 1;
const MAX_INTERVAL_SEC = 60;

export async function loadSettings() {
  state.settings = await window.portManager.getSettings();
  if (state.settings.monitorIntervalMs) {
    byId('mon-interval').value = Math.round(state.settings.monitorIntervalMs / 1000);
  }
}

async function applyInterval() {
  const sec = parseInt(byId('mon-interval').value, 10);
  if (!Number.isInteger(sec) || sec < MIN_INTERVAL_SEC || sec > MAX_INTERVAL_SEC) {
    alert(`監視間隔は${MIN_INTERVAL_SEC}〜${MAX_INTERVAL_SEC}秒で指定してください`);
    return;
  }
  await window.portManager.updateSettings({ monitorIntervalMs: sec * 1000 });
  pushEvent('ok', `監視間隔を ${sec} 秒に変更しました`);
  showToast(`監視間隔を ${sec} 秒に変更しました`);
  await loadSettings();
}

export function initSettings() {
  byId('btn-apply-interval').addEventListener('click', applyInterval);
}
