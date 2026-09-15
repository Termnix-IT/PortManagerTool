import { formatDateTime } from '../lib/format.js';
import { describeUpdateStatus } from '../lib/updates.js';
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
  renderUpdateStatus(await window.portManager.getUpdateStatus());
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

function renderUpdateStatus(status) {
  const view = describeUpdateStatus(status, formatDateTime);
  byId('update-current-version').textContent = `v${status.currentVersion}`;
  const pill = byId('update-state');
  pill.className = `state-pill ${view.pillClass}`;
  pill.textContent = view.label;
  const message = byId('update-message');
  message.hidden = !view.message;
  message.textContent = view.message;
  byId('btn-check-update').disabled = !view.canCheck;
  byId('btn-install-update').hidden = !view.canInstall;
}

export function initSettings() {
  byId('btn-apply-interval').addEventListener('click', applyInterval);

  byId('btn-check-update').addEventListener('click', async () => {
    renderUpdateStatus(await window.portManager.checkForUpdates());
  });
  byId('btn-install-update').addEventListener('click', async () => {
    const result = await window.portManager.installUpdate();
    if (!result.installed) showToast(result.message);
  });
  byId('btn-open-releases').addEventListener('click', () => window.portManager.openReleasesPage());

  window.portManager.onUpdateStatus((status) => {
    renderUpdateStatus(status);
    if (status.state === 'downloaded') {
      pushEvent('ok', `アップデート v${status.latestVersion} の準備ができました`);
    }
  });
}
