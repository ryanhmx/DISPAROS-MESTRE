/* ── Shared layout shell (sidebar + topbar) included in every page ── */

// The backend serves the frontend, so the API is always on the same origin
const BASE_URL = window.location.origin;
const API = `${BASE_URL}/api`;

// ── Toast ─────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg"></span>`;
  // textContent: messages can contain server/Telegram error text
  el.querySelector('.toast-msg').textContent = msg;
  const hide = () => { el.classList.add('hiding'); setTimeout(() => el.remove(), 300); };
  // Tap/click to dismiss (on phones toasts sit over the bottom buttons)
  el.title = 'Clique para fechar';
  el.addEventListener('click', hide);
  container.appendChild(el);
  // Errors stay longer so there's time to read them
  const duration = type === 'error' || type === 'warning' ? 7000 : 3500;
  setTimeout(hide, duration);
}

// ── Modal helpers ──────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = '';
  el.classList.add('open');
  const focusable = el.querySelector('input:not([type=hidden]), textarea, select');
  if (focusable) setTimeout(() => focusable.focus(), 50);
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  // A hidden modal would keep playing its video's audio
  el.querySelectorAll('video').forEach(v => v.pause());
  el.classList.remove('open');
  el.style.display = 'none';
}

// Closes a modal overlay, whether it's a static one (has an id) or created on the fly
function dismissOverlay(overlay) {
  if (overlay.id) return closeModal(overlay.id);
  // Dialogs created by showPrompt resolve their promise through their own cancel button
  const cancel = overlay.querySelector('[data-cancel]');
  if (cancel) cancel.click();
  else overlay.remove();
}

function toggleMenu(force) {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  const open = typeof force === 'boolean' ? force : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
}

// Mobile menu backdrop: sits right after the sidebar so CSS can show it with `.sidebar.open + .sidebar-backdrop`
(function setupSidebarBackdrop() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'sidebar-backdrop';
  backdrop.addEventListener('click', () => toggleMenu(false));
  sidebar.after(backdrop);
})();

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const overlays = [...document.querySelectorAll('.modal-overlay')]
    .filter(o => o.classList.contains('open') || o.style.display === 'flex');
  if (overlays.length) {
    dismissOverlay(overlays[overlays.length - 1]);
  } else {
    toggleMenu(false);
  }
});

// ── Pagination ─────────────────────────────────────────────────────────
function renderPagination(containerId, currentPage, totalPages, totalItems, onPageChange, pageSize = 15) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  let pages = '';
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && i > 2 && i < totalPages - 1 && Math.abs(i - currentPage) > 1) {
      if (i === 3 || i === totalPages - 2) pages += `<span style="padding:0 4px;color:var(--text-muted)">…</span>`;
      continue;
    }
    pages += `<button type="button" class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}" ${i === currentPage ? 'aria-current="page"' : ''}>${i}</button>`;
  }

  el.innerHTML = `
    <span class="pagination-info">Mostrando ${start}–${end} de ${totalItems}</span>
    <div class="pagination-controls">
      <button type="button" class="page-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>‹ Anterior</button>
      ${pages}
      <button type="button" class="page-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>Próximo ›</button>
    </div>
  `;

  // Event delegation keeps the callback's closure (no serializing it into onclick)
  el.onclick = e => {
    const btn = e.target.closest('button[data-page]');
    if (!btn || btn.disabled) return;
    const page = Number(btn.dataset.page);
    if (page >= 1 && page <= totalPages && page !== currentPage) onPageChange(page);
  };
}

function showConfirm(title, message, onConfirm, confirmLabel = 'Confirmar') {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.style.zIndex = '9999';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:440px">
      <div class="modal-header">
        <div class="modal-title">${escapeHtml(title)}</div>
        <button class="btn-icon" aria-label="Fechar" onclick="this.closest('.modal-overlay').remove()">✖</button>
      </div>
      <div class="modal-body">
        <p style="color:var(--text-secondary); white-space:pre-line">${escapeHtml(message)}</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
        <button class="btn btn-danger" data-confirm>${escapeHtml(confirmLabel)}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const confirmBtn = overlay.querySelector('[data-confirm]');
  confirmBtn.focus();
  confirmBtn.addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });
}

// In-app replacement for window.prompt(). fields: [{ label, value, placeholder, hint }]
// Resolves to an array of trimmed values, or null if cancelled.
function showPrompt(title, fields, confirmLabel = 'OK') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.zIndex = '9999';
    overlay.innerHTML = `
      <form class="modal" role="dialog" aria-modal="true" style="max-width:440px">
        <div class="modal-header">
          <div class="modal-title">${escapeHtml(title)}</div>
          <button type="button" class="btn-icon" aria-label="Fechar" data-cancel>✖</button>
        </div>
        <div class="modal-body">
          ${fields.map((f, i) => `
            <div class="form-group" style="margin-bottom:16px">
              <label class="form-label" for="prompt-field-${i}">${escapeHtml(f.label)}</label>
              <input id="prompt-field-${i}" class="form-control" value="${escapeHtml(f.value || '')}" placeholder="${escapeHtml(f.placeholder || '')}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}>
              ${f.hint ? `<div class="form-hint">${escapeHtml(f.hint)}</div>` : ''}
            </div>`).join('')}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-cancel>Cancelar</button>
          <button type="submit" class="btn btn-primary">${escapeHtml(confirmLabel)}</button>
        </div>
      </form>
    `;
    const finish = value => { overlay.remove(); resolve(value); };
    overlay.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => finish(null)));
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
    overlay.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      finish([...overlay.querySelectorAll('input')].map(i => i.value.trim()));
    });
    document.body.appendChild(overlay);
    const first = overlay.querySelector('input');
    first.focus();
    first.select();
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
    dismissOverlay(e.target);
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

// ── Bot status (sidebar footer) + token modal, shared by every page ────
function setupBotStatus() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar && !document.getElementById('bot-dot')) {
    const footer = document.createElement('div');
    footer.className = 'sidebar-footer';
    footer.innerHTML = `
      <button type="button" class="bot-status" onclick="openModal('bot-modal')">
        <div class="bot-status-dot" id="bot-dot"></div>
        <div class="bot-status-info">
          <div class="bot-status-name" id="bot-name">Sem Bot Configurado</div>
          <div class="bot-status-label">Clique para configurar</div>
        </div>
      </button>`;
    sidebar.appendChild(footer);
  }
  if (!document.getElementById('bot-modal')) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'bot-modal';
    modal.innerHTML = `
      <form class="modal" onsubmit="event.preventDefault(); saveToken()">
        <div class="modal-header">
          <h2 class="modal-title">Configuração do Bot Telegram</h2>
          <button type="button" class="btn-icon" aria-label="Fechar" onclick="closeModal('bot-modal')">✖</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label" for="bot-token-input">Token do Bot (BotFather)</label>
            <div style="display:flex; gap:8px">
              <input type="password" id="bot-token-input" class="form-control" placeholder="123456789:ABCDEF..." autocomplete="off">
              <button type="button" class="btn btn-secondary" aria-label="Mostrar token" title="Mostrar/ocultar"
                onclick="const i=document.getElementById('bot-token-input'); i.type = i.type === 'password' ? 'text' : 'password'">👁️</button>
            </div>
            <div class="form-hint">
              Abra o <a href="https://t.me/BotFather" target="_blank" rel="noopener" style="color:var(--accent)">@BotFather</a> no Telegram, crie um bot e cole o token aqui.
            </div>
          </div>
          <details class="advanced-box">
            <summary>Avançado: arquivos acima de 50 MB</summary>
            <div class="form-group">
              <label class="form-label" for="bot-api-url-input">Servidor Bot API local</label>
              <div style="display:flex; gap:8px">
                <input type="url" id="bot-api-url-input" class="form-control" placeholder="http://localhost:8081" autocomplete="off">
                <button type="button" class="btn btn-secondary" onclick="saveApiUrl()">Salvar</button>
              </div>
              <div class="form-hint">
                O Telegram aceita até 50 MB por arquivo enviado por bot. Com um
                <a href="https://github.com/tdlib/telegram-bot-api" target="_blank" rel="noopener" style="color:var(--accent)">servidor Bot API local</a>
                o limite sobe para 2 GB (útil para aulas em vídeo). Deixe vazio para usar o servidor oficial.
              </div>
            </div>
          </details>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" onclick="closeModal('bot-modal')">Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar e Conectar</button>
        </div>
      </form>`;
    document.body.appendChild(modal);
  }
}

async function saveToken() {
  const input = document.getElementById('bot-token-input');
  const token = input.value.trim();
  if (!token) return toast('Insira o token', 'warning');
  const btn = document.querySelector('#bot-modal button[type=submit]');
  btn.disabled = true;
  try {
    await apiPost('/stats/settings/token', { token });
    toast('Bot conectado com sucesso!');
    input.value = '';
    closeModal('bot-modal');
    loadBotStatus();
    if (typeof loadDashboard === 'function') loadDashboard();
  } catch (e) {
    toast(e.message, 'error');
  }
  btn.disabled = false;
}

async function saveApiUrl() {
  const input = document.getElementById('bot-api-url-input');
  try {
    const res = await apiPost('/stats/settings/api-url', { url: input.value.trim() });
    toast(res.url ? 'Servidor local salvo: arquivos de até 2 GB' : 'Usando o servidor oficial (até 50 MB)');
    if (typeof onApiUrlSaved === 'function') onApiUrlSaved();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Load bot status ────────────────────────────────────────────────────
async function loadBotStatus() {
  try {
    const s = await apiFetch('/stats/settings');
    const dot = document.getElementById('bot-dot');
    const name = document.getElementById('bot-name');
    const apiUrl = document.getElementById('bot-api-url-input');
    if (apiUrl) apiUrl.value = s.bot_api_url || '';
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

// ── Cron → human text (pt-BR) for the common patterns the editor generates ──
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
function cronToText(expr) {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return expr || '';
  const [min, hour, dom, mon, dow] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || mon !== '*') return expr;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom === '*' && dow === '*') return `Todo dia às ${time}`;
  if (dom === '*' && dow === '1-5') return `Dias úteis às ${time}`;
  if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) {
    const days = dow.split(',').map(d => WEEKDAYS[+d]);
    if (days.length === 1) {
      // "Todo domingo/sábado", "Toda segunda"
      return `${dow === '0' || dow === '6' ? 'Todo' : 'Toda'} ${days[0]} às ${time}`;
    }
    return `Toda semana (${days.slice(0, -1).join(', ')} e ${days[days.length - 1]}) às ${time}`;
  }
  if (/^\d+$/.test(dom) && dow === '*') return `Todo dia ${dom} do mês às ${time}`;
  return expr;
}

// ── Telegram HTML → safe preview HTML ──────────────────────────────────
// Keeps only the tags Telegram's HTML mode supports; everything else is reduced
// to its text, so a message can't run scripts or break the preview layout.
const TG_TAGS = {
  B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', INS: 'u', S: 's', STRIKE: 's', DEL: 's',
  CODE: 'code', PRE: 'pre', BLOCKQUOTE: 'blockquote', A: 'a', 'TG-SPOILER': 'span', 'TG-EMOJI': 'span', SPAN: 'span'
};

function telegramHtmlToSafeHtml(raw) {
  // DOMParser documents are inert: scripts and event handlers never run
  const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html');
  const out = document.createElement('div');
  const walk = (src, dst) => {
    for (const node of src.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        dst.appendChild(document.createTextNode(node.textContent));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = TG_TAGS[node.tagName];
        if (!tag) { walk(node, dst); continue; }
        const el = document.createElement(tag);
        if (node.tagName === 'A') {
          const href = node.getAttribute('href') || '';
          if (/^(https?:|tg:)/i.test(href)) {
            el.href = href;
            el.target = '_blank';
            el.rel = 'noopener';
          }
        }
        if (node.tagName === 'TG-SPOILER' || (node.tagName === 'SPAN' && node.classList.contains('tg-spoiler'))) {
          el.className = 'tg-spoiler';
        }
        walk(node, el);
        dst.appendChild(el);
      }
    }
  };
  walk(doc.body, out);
  return out.innerHTML;
}

// ── Telegram errors → actionable pt-BR text ───────────────────────────
const TELEGRAM_ERRORS = [
  [/bot is not a member|bot was kicked|CHANNEL_PRIVATE/i, 'O bot não está no canal. Adicione-o como administrador.'],
  [/not enough rights|need administrator rights|CHAT_WRITE_FORBIDDEN|have no rights to send/i, 'O bot não tem permissão para postar. Dê a ele permissão de administrador com "Publicar mensagens".'],
  [/message can't be deleted|MESSAGE_DELETE_FORBIDDEN/i, 'O bot não tem permissão para apagar mensagens neste canal.'],
  [/chat not found|PEER_ID_INVALID/i, 'Canal não encontrado. Confira o Chat ID (deve começar com -100).'],
  [/bot was blocked by the user/i, 'O destinatário bloqueou o bot.'],
  [/too many requests|retry after/i, 'O Telegram limitou os envios (muitas mensagens seguidas). Tente novamente em alguns minutos.'],
  [/caption is too long/i, 'A legenda passou de 1024 caracteres.'],
  [/message is too long/i, 'A mensagem passou de 4096 caracteres.'],
  [/can't parse entities|unsupported start tag|can't find end tag/i, 'Erro na formatação HTML do texto (tag inválida ou não fechada).'],
  [/wrong file|failed to get HTTP URL content|IMAGE_PROCESS_FAILED|PHOTO_INVALID/i, 'O Telegram não aceitou um dos arquivos de mídia.'],
  [/request entity too large|file is too big/i, 'Arquivo grande demais para o Telegram (máx. 50MB).'],
  [/BUTTON_URL_INVALID|wrong HTTP URL/i, 'Um dos botões tem URL inválida.'],
  [/Unauthorized|401/i, 'Token do bot inválido. Reconfigure o bot.'],
];

function friendlyError(msg) {
  if (!msg) return '';
  const hit = TELEGRAM_ERRORS.find(([re]) => re.test(msg));
  return hit ? hit[1] : msg;
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
    deleted:   ['badge-muted',   '🗑️ Apagado'],
    failed_delete: ['badge-danger', '⚠️ Falha ao apagar'],
    paused:    ['badge-warning', '⏸️ Pausado'],
    sending:   ['badge-accent',  '📤 Enviando'],
    skipped:   ['badge-muted',   '⏭️ Pulada'],
  };
  const [cls, label] = map[status] || ['badge-muted', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ── Responsive tables ──────────────────────────────────────────────────
// Copies each column header into its cells' data-label so .table-stack can show
// rows as labelled cards on phones. Call after re-rendering a tbody.
function labelTableCells(table) {
  if (!table) return;
  const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach(tr => {
    [...tr.children].forEach((td, i) => {
      if (!td.hasAttribute('colspan') && headers[i] && !td.classList.contains('cell-title') && !td.classList.contains('cell-actions')) {
        td.setAttribute('data-label', headers[i]);
      }
    });
  });
}

// Re-label automatically whenever a stacked table's body changes
document.querySelectorAll('table.table-stack').forEach(table => {
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  new MutationObserver(() => labelTableCells(table)).observe(tbody, { childList: true });
  labelTableCells(table);
});

// Init
setActiveNav();
setupBotStatus();
loadBotStatus();
