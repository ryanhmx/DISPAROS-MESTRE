/* ── Shared layout shell (sidebar + topbar) included in every page ── */

// Dynamic API URL: uses same host in production, localhost in dev
const API = window.location.hostname === 'localhost'
  ? 'http://localhost:3131/api'
  : `${window.location.origin}/api`;

// ── Toast ─────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('hiding'); setTimeout(() => el.remove(), 300); }, 3500);
}

// ── Modal helpers ──────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = '';
  el.classList.add('open');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
  el.style.display = 'none';
}

function toggleMenu() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.classList.toggle('open');
}

// ── Pagination ─────────────────────────────────────────────────────────
function renderPagination(containerId, currentPage, totalPages, totalItems, onPageChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const start = (currentPage - 1) * 15 + 1;
  const end = Math.min(currentPage * 15, totalItems);

  let pages = '';
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && i > 2 && i < totalPages - 1 && Math.abs(i - currentPage) > 1) {
      if (i === 3 || i === totalPages - 2) pages += `<span style="padding:0 4px;color:var(--text-muted)">…</span>`;
      continue;
    }
    pages += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="(${onPageChange.toString()})(${i})">${i}</button>`;
  }

  el.innerHTML = `
    <span class="pagination-info">Mostrando ${start}–${end} de ${totalItems}</span>
    <div class="pagination-controls">
      <button class="page-btn" onclick="(${onPageChange.toString()})(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>‹ Anterior</button>
      ${pages}
      <button class="page-btn" onclick="(${onPageChange.toString()})(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>Próximo ›</button>
    </div>
  `;
}

function showConfirm(title, message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.style.zIndex = '9999';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">${escapeHtml(title)}</div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✖</button>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:20px; color:var(--text-secondary)">${escapeHtml(message)}</p>
        <div class="flex" style="gap:10px; justify-content:flex-end;">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-danger" id="confirm-btn">Confirmar</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#confirm-btn').addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });
}

// ── HTML Escaping (XSS Prevention) ─────────────
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Close modals on overlay click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

// ── API helpers ────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro desconhecido');
  return data;
}

async function apiPost(path, body) {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function apiDelete(path) {
  return apiFetch(path, { method: 'DELETE' });
}

async function apiPut(path, body) {
  return apiFetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// ── Set active nav ─────────────────────────────────────────────────────
function setActiveNav() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-link').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (href === page || (page === '' && href === 'index.html')) {
      a.classList.add('active');
    }
  });
}

// ── Load bot status ────────────────────────────────────────────────────
async function loadBotStatus() {
  try {
    const s = await apiFetch('/stats/settings');
    const dot = document.getElementById('bot-dot');
    const name = document.getElementById('bot-name');
    if (s.bot_token) {
      dot?.classList.add('connected');
      if (name) name.textContent = s.bot_username ? '@' + s.bot_username : 'Bot Conectado';
    }
  } catch (_) {}
}

// ── Format date ────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Truncate ───────────────────────────────────────────────────────────
function trunc(str, n = 60) {
  return str && str.length > n ? str.slice(0, n) + '…' : (str || '');
}

// ── Status badge ───────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    success:   ['badge-success', '✅ Sucesso'],
    failed:    ['badge-danger',  '❌ Falha'],
    pending:   ['badge-warning', '⏳ Pendente'],
    running:   ['badge-accent',  '🔄 Executando'],
    done:      ['badge-success', '✅ Concluído'],
    cancelled: ['badge-muted',   '🚫 Cancelado'],
    draft:     ['badge-muted',   '📝 Rascunho'],
    scheduled: ['badge-warning', '⏰ Agendado'],
    sent:      ['badge-success', '📤 Enviado'],
  };
  const [cls, label] = map[status] || ['badge-muted', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

// Init
setActiveNav();
loadBotStatus();
