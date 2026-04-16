const Store = require('electron-store');

const store = new Store({
  defaults: {
    favorites: [],
    monitors: [],
    settings: {
      monitorIntervalMs: 5000,
      showUdp: true,
      showEstablished: false,
    },
  },
});

// --- Favorites ---

function getFavorites() {
  return store.get('favorites');
}

function addFavorite(data) {
  const favorites = getFavorites();
  const entry = {
    id: `fav_${Date.now()}`,
    port: data.port,
    label: data.label || `ポート ${data.port}`,
    description: data.description || '',
    protocol: data.protocol || 'TCP',
    createdAt: new Date().toISOString(),
  };
  favorites.push(entry);
  store.set('favorites', favorites);
  return entry;
}

function removeFavorite(id) {
  const favorites = getFavorites().filter((f) => f.id !== id);
  store.set('favorites', favorites);
  return { success: true };
}

// --- Monitors ---

function getMonitors() {
  return store.get('monitors');
}

function addMonitor(data) {
  const monitors = getMonitors();
  const entry = {
    id: `mon_${Date.now()}`,
    port: data.port,
    protocol: data.protocol || 'TCP',
    label: data.label || `ポート ${data.port}`,
    enabled: true,
    notifyOnOccupied: data.notifyOnOccupied !== false,
    notifyOnFreed: data.notifyOnFreed !== false,
    lastKnownState: 'free',
  };
  monitors.push(entry);
  store.set('monitors', monitors);
  return entry;
}

function updateMonitor(id, data) {
  const monitors = getMonitors();
  const idx = monitors.findIndex((m) => m.id === id);
  if (idx === -1) return { success: false, error: 'Not found' };
  monitors[idx] = { ...monitors[idx], ...data };
  store.set('monitors', monitors);
  return monitors[idx];
}

function removeMonitor(id) {
  const monitors = getMonitors().filter((m) => m.id !== id);
  store.set('monitors', monitors);
  return { success: true };
}

// --- Settings ---

function getSettings() {
  return store.get('settings');
}

function updateSettings(data) {
  const settings = { ...getSettings(), ...data };
  store.set('settings', settings);
  return settings;
}

module.exports = {
  getFavorites, addFavorite, removeFavorite,
  getMonitors, addMonitor, updateMonitor, removeMonitor,
  getSettings, updateSettings,
};
