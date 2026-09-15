// IPC経由でrendererから受け取る値の検証。
// rendererの入力チェックは利便性のためのもので、ここが信頼境界になる。

const LIMITS = {
  labelMaxLength: 64,
  descriptionMaxLength: 200,
  idMaxLength: 64,
  monitorIntervalMinMs: 1000,
  monitorIntervalMaxMs: 60000,
  maxPid: 0xffffffff,
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toInteger(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value);
  return NaN;
}

function validatePid(value) {
  const pid = toInteger(value);
  if (!Number.isInteger(pid) || pid < 1 || pid > LIMITS.maxPid) {
    throw new ValidationError('PIDが不正です');
  }
  return pid;
}

function validatePort(value) {
  const port = toInteger(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('ポート番号は1〜65535の整数で指定してください');
  }
  return port;
}

function validateProtocol(value) {
  if (value === undefined || value === null || value === '') return 'TCP';
  const protocol = String(value).toUpperCase();
  if (protocol !== 'TCP' && protocol !== 'UDP') {
    throw new ValidationError('プロトコルはTCPまたはUDPで指定してください');
  }
  return protocol;
}

function validateText(value, { field, maxLength }) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ValidationError(`${field}は文字列で指定してください`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new ValidationError(`${field}は${maxLength}文字以内で指定してください`);
  }
  return text;
}

function validateBoolean(value, options) {
  const { field, defaultValue } = options;
  if (value === undefined && 'defaultValue' in options) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field}は真偽値で指定してください`);
  }
  return value;
}

function validateId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.idMaxLength || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ValidationError('IDが不正です');
  }
  return value;
}

function requireObject(value) {
  if (!isPlainObject(value)) {
    throw new ValidationError('入力データが不正です');
  }
  return value;
}

function rejectUnknownKeys(data, allowedKeys) {
  const unknown = Object.keys(data).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(`変更できない項目が含まれています: ${unknown.join(', ')}`);
  }
}

function validateFavoriteInput(value) {
  const data = requireObject(value);
  return {
    port: validatePort(data.port),
    protocol: validateProtocol(data.protocol),
    label: validateText(data.label, { field: '名前', maxLength: LIMITS.labelMaxLength }),
    description: validateText(data.description, { field: '説明', maxLength: LIMITS.descriptionMaxLength }),
  };
}

function validateMonitorInput(value) {
  const data = requireObject(value);
  return {
    port: validatePort(data.port),
    protocol: validateProtocol(data.protocol),
    label: validateText(data.label, { field: '名前', maxLength: LIMITS.labelMaxLength }),
    notifyOnOccupied: validateBoolean(data.notifyOnOccupied, { field: '使用開始通知', defaultValue: true }),
    notifyOnFreed: validateBoolean(data.notifyOnFreed, { field: '解放通知', defaultValue: true }),
  };
}

// port/protocol/lastKnownState 等はrendererから書き換えさせない
function validateMonitorUpdate(value) {
  const data = requireObject(value);
  rejectUnknownKeys(data, ['label', 'enabled', 'notifyOnOccupied', 'notifyOnFreed']);
  const result = {};
  if ('label' in data) result.label = validateText(data.label, { field: '名前', maxLength: LIMITS.labelMaxLength });
  if ('enabled' in data) result.enabled = validateBoolean(data.enabled, { field: '有効/無効' });
  if ('notifyOnOccupied' in data) result.notifyOnOccupied = validateBoolean(data.notifyOnOccupied, { field: '使用開始通知' });
  if ('notifyOnFreed' in data) result.notifyOnFreed = validateBoolean(data.notifyOnFreed, { field: '解放通知' });
  return result;
}

function validateSettingsUpdate(value) {
  const data = requireObject(value);
  rejectUnknownKeys(data, ['monitorIntervalMs', 'showUdp', 'showEstablished']);
  const result = {};
  if ('monitorIntervalMs' in data) {
    const interval = toInteger(data.monitorIntervalMs);
    if (!Number.isInteger(interval) || interval < LIMITS.monitorIntervalMinMs || interval > LIMITS.monitorIntervalMaxMs) {
      throw new ValidationError('監視間隔は1〜60秒で指定してください');
    }
    result.monitorIntervalMs = interval;
  }
  if ('showUdp' in data) result.showUdp = validateBoolean(data.showUdp, { field: 'UDP表示' });
  if ('showEstablished' in data) result.showEstablished = validateBoolean(data.showEstablished, { field: '接続済み表示' });
  return result;
}

module.exports = {
  LIMITS,
  ValidationError,
  validatePid,
  validatePort,
  validateProtocol,
  validateId,
  validateFavoriteInput,
  validateMonitorInput,
  validateMonitorUpdate,
  validateSettingsUpdate,
};
