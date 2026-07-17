import { api, fmt } from '/web/app.js';

// Tabs pick which 100-row window the server returns (biggest-by-tokens vs
// newest). Clicking a column header then re-sorts that loaded window
// client-side, so sorting is instant and works for every column including
// the derived cost.
const SORTS = [
  { key: 'tokens', label: 'Most tokens' },
  { key: 'recent', label: 'Most recent' },
];

// Column definitions: how to render each cell and how to sort by it.
// type 'num' sorts numerically, 'str' sorts case-insensitively.
const COLS = [
  { id: 'when',    label: 'when',       cls: '',    type: 'str', get: r => r.timestamp || '',
    cell: r => `<td class="mono">${fmt.ts(r.timestamp)}</td>` },
  { id: 'prompt',  label: 'prompt',     cls: '',    type: 'num', get: r => r.prompt_chars || (r.prompt_text ? r.prompt_text.length : 0),
    cell: r => `<td class="blur-sensitive">${fmt.htmlSafe(fmt.short(r.prompt_text, 110))}</td>` },
  { id: 'model',   label: 'model',      cls: '',    type: 'str', get: r => r.model || '',
    cell: r => `<td><span class="badge ${fmt.modelClass(r.model)}">${fmt.htmlSafe(fmt.modelShort(r.model))}</span></td>` },
  { id: 'tokens',  label: 'tokens',     cls: 'num', type: 'num', get: r => r.billable_tokens || 0,
    cell: r => `<td class="num">${fmt.int(r.billable_tokens)}</td>` },
  { id: 'cacherd', label: 'cache rd',   cls: 'num', type: 'num', get: r => r.cache_read_tokens || 0,
    cell: r => `<td class="num">${fmt.int(r.cache_read_tokens)}</td>` },
  { id: 'cost',    label: 'cache cost', cls: 'num', type: 'num', get: r => r.estimated_cost_usd || 0,
    cell: r => `<td class="num mono">${fmt.usd4(r.estimated_cost_usd)}</td>` },
  { id: 'session', label: 'session',    cls: '',    type: 'str', get: r => r.session_id || '',
    cell: r => `<td><a href="#/sessions/${encodeURIComponent(r.session_id || '')}" class="mono" onclick="event.stopPropagation()">${fmt.htmlSafe((r.session_id || '').slice(0, 8))}…</a></td>` },
];

function readSort() {
  const q = (location.hash.split('?')[1] || '');
  const m = /(?:^|&)sort=([^&]+)/.exec(q);
  const k = m && decodeURIComponent(m[1]);
  return SORTS.find(s => s.key === k) || SORTS[0];
}

function writeSort(key) {
  const base = (location.hash.replace(/^#/, '').split('?')[0]) || '/prompts';
  location.hash = '#' + base + '?sort=' + encodeURIComponent(key);
}

function sortRows(rows, col, dir) {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = col.get(a), bv = col.get(b);
    let cmp;
    if (col.type === 'num') {
      cmp = (av || 0) - (bv || 0);
    } else {
      cmp = String(av).toLowerCase().localeCompare(String(bv).toLowerCase());
    }
    return cmp * factor;
  });
}

export default async function (root) {
  const sort = readSort();
  const rows = await api('/api/prompts?limit=100&sort=' + encodeURIComponent(sort.key));

  // Initial header-sort mirrors the fetch: biggest tokens first, or newest first.
  const active = sort.key === 'recent'
    ? { col: 'when',   dir: 'desc' }
    : { col: 'tokens', dir: 'desc' };

  const sortTabs = `
    <div class="range-tabs" role="tablist">
      ${SORTS.map(s => `<button data-sort="${s.key}" class="${s.key === sort.key ? 'active' : ''}">${s.label}</button>`).join('')}
    </div>`;

  const subtitle = 'The prompts that cost the most tokens (or the newest, via the toggle). Click any column header to re-sort; click a row to see the full prompt.';

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Prompts</h2>
      <div class="spacer"></div>
      ${sortTabs}
    </div>

    <div class="card">
      <p class="muted" style="margin:0 0 14px">${subtitle}</p>
      <table id="prompts">
        <thead><tr>
          ${COLS.map(c => `<th data-col="${c.id}" class="sortable ${c.cls}" style="cursor:pointer;user-select:none" title="Sort by ${c.label}">${c.label}<span class="sort-caret"></span></th>`).join('')}
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div id="drawer"></div>
  `;

  let view = rows;

  function renderBody() {
    const col = COLS.find(c => c.id === active.col) || COLS[3];
    view = sortRows(rows, col, active.dir);

    // Header carets
    root.querySelectorAll('#prompts thead th').forEach(th => {
      const caret = th.querySelector('.sort-caret');
      if (!caret) return;
      caret.textContent = th.dataset.col === active.col ? (active.dir === 'asc' ? ' ▲' : ' ▼') : '';
      th.classList.toggle('active', th.dataset.col === active.col);
    });

    const tbody = root.querySelector('#prompts tbody');
    tbody.innerHTML = view.map((r, i) => `
      <tr data-i="${i}" style="cursor:pointer">
        ${COLS.map(c => c.cell(r)).join('')}
      </tr>`).join('') || `<tr><td colspan="${COLS.length}" class="muted">no prompts yet</td></tr>`;

    tbody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => openDrawer(view[Number(tr.dataset.i)]));
    });
  }

  function openDrawer(r) {
    if (!r) return;
    const drawer = document.getElementById('drawer');
    drawer.innerHTML = `
      <div class="card">
        <h3 style="display:flex;align-items:center">
          <span>Prompt detail</span>
          <span class="spacer"></span>
          <span class="badge ${fmt.modelClass(r.model)}">${fmt.htmlSafe(fmt.modelShort(r.model))}</span>
        </h3>
        <pre class="blur-sensitive">${fmt.htmlSafe(r.prompt_text || '')}</pre>
        <div class="flex" style="margin-top:12px;flex-wrap:wrap;gap:14px">
          <span class="muted">${fmt.ts(r.timestamp)}</span>
          <span class="muted">${fmt.int(r.billable_tokens)} billable · ${fmt.int(r.cache_read_tokens)} cache rd · ~${fmt.usd4(r.estimated_cost_usd)} cache cost</span>
          <span class="spacer"></span>
          <a href="#/sessions/${encodeURIComponent(r.session_id)}">Open session →</a>
        </div>
      </div>`;
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Header click → sort. Same column toggles direction; new column starts
  // descending for numbers (biggest first) and ascending for text.
  root.querySelectorAll('#prompts thead th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const colId = th.dataset.col;
      if (active.col === colId) {
        active.dir = active.dir === 'asc' ? 'desc' : 'asc';
      } else {
        const col = COLS.find(c => c.id === colId);
        active.col = colId;
        active.dir = col && col.type === 'num' ? 'desc' : 'asc';
      }
      renderBody();
    });
  });

  // Tab click → re-fetch the other window.
  root.querySelectorAll('.range-tabs button').forEach(btn => {
    btn.addEventListener('click', () => writeSort(btn.dataset.sort));
  });

  renderBody();
}
