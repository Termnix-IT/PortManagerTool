import { byId } from './dom.js';

const MIN_WIDTH = 172;
const MAX_WIDTH = 340;

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても表示は変える
  }
}

export function initSidebar() {
  const appShell = byId('app-shell');
  const toggleButton = byId('btn-toggle-sidebar');
  const resizer = byId('sidebar-resizer');
  let resizing = false;

  function setWidth(width) {
    const nextWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
    appShell.style.setProperty('--sidebar-width', `${nextWidth}px`);
    writeStorage('sidebarWidth', String(nextWidth));
  }

  function setCollapsed(collapsed) {
    appShell.classList.toggle('sidebar-collapsed', collapsed);
    writeStorage('sidebarCollapsed', String(collapsed));
    const label = collapsed ? 'サイドバーを開く' : 'サイドバーを折りたたむ';
    toggleButton.setAttribute('aria-label', label);
    toggleButton.setAttribute('title', label);
  }

  toggleButton.addEventListener('click', () => {
    setCollapsed(!appShell.classList.contains('sidebar-collapsed'));
  });

  resizer.addEventListener('mousedown', (event) => {
    if (appShell.classList.contains('sidebar-collapsed')) return;
    resizing = true;
    document.body.classList.add('is-resizing-sidebar');
    event.preventDefault();
  });

  document.addEventListener('mousemove', (event) => {
    if (resizing) setWidth(event.clientX);
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.classList.remove('is-resizing-sidebar');
  });

  const savedWidth = Number(readStorage('sidebarWidth'));
  if (savedWidth) setWidth(savedWidth);
  setCollapsed(readStorage('sidebarCollapsed') === 'true');

  window.portManager.getAppInfo().then((info) => {
    byId('app-version').textContent = `v${info.version}`;
  });
}
