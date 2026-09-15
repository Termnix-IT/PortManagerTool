export const byId = (id) => document.getElementById(id);

export function emptyRow(colspan, message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = colspan;
  cell.className = 'empty-cell';
  cell.textContent = message;
  row.appendChild(cell);
  return row;
}

export function showEmptyRow(tbody, colspan, message) {
  tbody.replaceChildren(emptyRow(colspan, message));
}

export function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 260);
  }, 2200);
}
