// app.js — router, state, fetch helpers

export const $  = (sel, root=document) => root.querySelector(sel);
export const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const fmt = {
  int:   n => (n ?? 0).toLocaleString(),
  compact: n => COMPACT.format(n ?? 0),
  usd:   n => n == null ? '—' : '$' + Number(n).toFixed(2),
  usd4:  n => n == null ? '—' : '$' + Number(n).toFixed(4),
  pct:   n => n == null ? '—' : (n * 100).toFixed(0) + '%',
  short: (s, n=80) => s == null ? '' : (s.length > n ? s.slice(0, n - 1) + '…' : s),
  htmlSafe: s => (s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  modelClass: m => {
    const s = (m || '').toLowerCase();
    if (s.includes('opus'))   return 'opus';
    if (s.includes('sonnet')) return 'sonnet';
    if (s.includes('haiku'))  return 'haiku';
    return '';
  },
  modelShort: m => (m || '').replace('claude-', ''),
  ts: t => (t || '').slice(0, 16).replace('T', ' '),
};

export async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export const state = { plan: 'api', pricing: null };

const ROUTES = {
  '/overview': () => import('/web/routes/overview.js'),
  '/prompts':  () => import('/web/routes/prompts.js'),
  '/sessions': () => import('/web/routes/sessions.js'),
  '/projects': () => import('/web/routes/projects.js'),
  '/skills':   () => import('/web/routes/skills.js'),
  '/tips':     () => import('/web/routes/tips.js'),
  '/settings': () => import('/web/routes/settings.js'),
};

function buildTopbar() {
  const wrap = document.createElement('header');
  wrap.className = 'topbar';
  wrap.innerHTML = `
    <div class="brand">Token Dashboard</div>
    <nav>
      ${Object.keys(ROUTES).map(p => `<a href="#${p}" data-route="${p}">${p.slice(1)}</a>`).join('')}
    </nav>
    <div class="spacer"></div>
    <span class="pill scan-status" id="scan-status" hidden></span>
    <span class="pill" id="plan-pill">api</span>
    <span class="pill muted" title="Cmd/Ctrl+B blurs sensitive text">⌘B blur</span>
  `;
  document.body.prepend(wrap);
}

function setActiveTab(routeKey) {
  $$('header.topbar nav a').forEach(a => a.classList.toggle('active', a.dataset.route === routeKey));
}

let _rendering = false;
let _renderQueued = false;

async function render() {
  // Coalesce overlapping renders: the SSE stream and the status poll can both
  // ask to re-render around the same moment. Without this guard two async
  // renders race to blank and repopulate #app, causing flicker.
  if (_rendering) { _renderQueued = true; return; }
  _rendering = true;
  try {
    const hash = location.hash.replace(/^#/, '') || '/overview';
    const path = hash.split('?')[0];
    let key = path;
    if (path.startsWith('/sessions/')) key = '/sessions';
    setActiveTab(key);
    const loader = ROUTES[key] || ROUTES['/overview'];
    const mod = await loader();
    $('#app').innerHTML = '';
    try {
      await mod.default($('#app'));
    } catch (e) {
      $('#app').innerHTML = `<div class="card"><h2>Error</h2><pre>${fmt.htmlSafe(String(e.stack || e))}</pre></div>`;
    }
  } finally {
    _rendering = false;
    if (_renderQueued) { _renderQueued = false; render(); }
  }
}

async function firstRun() {
  if (localStorage.getItem('td.plan-set')) return;
  const plans = Object.entries(state.pricing.plans);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Welcome — pick your plan</h2>
      <p>This sets how costs are displayed. Change it later in Settings.</p>
      <select id="firstplan" style="width:100%">
        ${plans.map(([k,v]) => `<option value="${k}">${v.label}${v.monthly ? ` — $${v.monthly}/mo` : ''}</option>`).join('')}
      </select>
      <div class="actions">
        <div class="spacer"></div>
        <button class="primary" id="firstsave">Continue</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  await new Promise(res => $('#firstsave', overlay).addEventListener('click', async () => {
    const plan = $('#firstplan', overlay).value;
    await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    localStorage.setItem('td.plan-set', '1');
    overlay.remove();
    res();
  }));
  state.plan = (await api('/api/plan')).plan;
}

async function boot() {
  buildTopbar();
  const planResp = await api('/api/plan');
  state.plan = planResp.plan;
  state.pricing = planResp.pricing;
  $('#plan-pill').textContent = state.plan;

  await firstRun();

  window.addEventListener('hashchange', render);
  await render();

  // Privacy blur (Cmd+B / Ctrl+B)
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      document.body.classList.toggle('privacy-on');
    }
  });

  // SSE diff stream: flip the indicator instantly on scan start/finish,
  // and re-render the current view when a scan brought in new data.
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = ev => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === 'scan_start') setScanIndicator(true);
        else if (evt.type === 'scan_done') setScanIndicator(false);
        else if (evt.type === 'scan') render();
      } catch {}
    };
  } catch {}

  // Poll status so the indicator shows live progress (session count climbing)
  // during a long first scan — SSE only fires at start/finish of each pass.
  pollStatus();
  setInterval(pollStatus, 2500);
}

let _scanningNow = false;
let _hideStatusTimer = null;

// Single source of truth for the indicator. Tracks the previous state itself
// so the "updated" flash and the refresh-on-finish fire on the true->false
// transition regardless of which caller (SSE or poll) observes it first.
function setScanIndicator(scanning, sessions) {
  const el = $('#scan-status');
  if (!el) return;
  const wasScanning = _scanningNow;
  _scanningNow = scanning;
  if (scanning) {
    if (_hideStatusTimer) { clearTimeout(_hideStatusTimer); _hideStatusTimer = null; }
    el.hidden = false;
    el.classList.add('scanning');
    const count = sessions != null ? ` · ${fmt.int(sessions)} sessions` : '';
    el.innerHTML = `<span class="spinner"></span>scanning${count}`;
  } else {
    el.classList.remove('scanning');
    if (wasScanning) {
      // A scan just finished: flash "updated", fade out, and refresh numbers.
      el.innerHTML = `updated ✓`;
      if (_hideStatusTimer) clearTimeout(_hideStatusTimer);
      _hideStatusTimer = setTimeout(() => { el.hidden = true; }, 4000);
      render();
    } else {
      el.hidden = true;
    }
  }
}

async function pollStatus() {
  try {
    const s = await api('/api/status');
    setScanIndicator(s.scanning, s.sessions);
  } catch {}
}

boot();
