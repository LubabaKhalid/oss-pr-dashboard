/* Open Source PR Dashboard
 * Static site: loads PRs live from the GitHub search API, falls back to a cached
 * copy or the committed snapshot, and renders an overview + per-project pages.
 */
(function () {
  'use strict';

  const CACHE_KEY = 'oss-dash:cache';
  const THEME_KEY = 'oss-dash:theme';
  const STATES = ['merged', 'open', 'closed'];
  const STATE_LABEL = { merged: 'Merged', open: 'Open', closed: 'Closed' };

  const app = document.getElementById('app');
  const statusEl = document.getElementById('status');
  const refreshBtn = document.getElementById('refresh');
  const themeBtn = document.getElementById('theme');
  const tooltip = document.getElementById('tooltip');

  let config = { username: '', title: 'Open Source PR Dashboard', exclude: [] };
  let summaries = {};
  let prs = [];
  let meta = { source: 'none', fetchedAt: null, error: null };

  /* ---------- helpers ---------- */
  const el = (tag, attrs, ...children) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v; // only used with trusted static markup (icons)
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) n.append(c);
    return n;
  };
  const svgEl = (tag, attrs, ...children) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    for (const c of children.flat()) if (c != null) n.append(c);
    return n;
  };
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : '—';
  const repoKey = (pr) => `${pr.repo}#${pr.number}`;

  const ICONS = {
    merged: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/></svg>',
    open: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>',
    closed: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>',
  };
  const badge = (state) => el('span', { class: `badge ${state}` }, el('span', { html: ICONS[state] }), STATE_LABEL[state]);

  /* ---------- data ---------- */
  const excluded = (repo) => (config.exclude || []).some((pat) => {
    if (pat.endsWith('/*')) return repo.toLowerCase().startsWith(pat.slice(0, -1).toLowerCase());
    return repo.toLowerCase() === pat.toLowerCase();
  });

  function normalize(item) {
    const repo = item.repository_url.replace(/.*\/repos\//, '');
    const merged = !!(item.pull_request && item.pull_request.merged_at);
    return {
      repo,
      number: item.number,
      title: item.title,
      url: item.html_url,
      state: merged ? 'merged' : item.state === 'open' ? 'open' : 'closed',
      created: item.created_at,
      closed: item.closed_at,
      draft: !!item.draft,
    };
  }

  async function fetchLive(user) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const q = encodeURIComponent(`author:${user} type:pr`);
      const url = `https://api.github.com/search/issues?q=${q}&per_page=100&page=${page}&sort=created&order=desc`;
      const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) {
        if (r.status === 403 || r.status === 429) {
          const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
          const when = reset ? ` Try again after ${new Date(reset).toLocaleTimeString()}.` : ' Try again in a minute.';
          throw new Error('GitHub API rate limit reached.' + when);
        }
        throw new Error(`GitHub API error ${r.status}`);
      }
      const j = await r.json();
      out.push(...j.items.map(normalize));
      if (j.items.length < 100 || out.length >= j.total_count) break;
    }
    return out;
  }

  function readCache() {
    try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c && Array.isArray(c.prs)) return c; } catch (e) {}
    return null;
  }
  function writeCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  async function loadData({ live }) {
    app.setAttribute('aria-busy', 'true');
    refreshBtn.disabled = true; refreshBtn.classList.add('spinning');
    setStatus('Fetching latest from GitHub…');
    let data = null; let error = null;
    if (live) {
      try {
        const list = await fetchLive(config.username);
        data = { fetchedAt: new Date().toISOString(), prs: list, source: 'live' };
        writeCache({ fetchedAt: data.fetchedAt, prs: list });
      } catch (e) { error = e.message || String(e); }
    }
    if (!data) {
      const c = readCache();
      if (c) data = { ...c, source: 'cache' };
    }
    if (!data) {
      try {
        const r = await fetch('data/snapshot.json', { cache: 'no-cache' });
        const s = await r.json();
        data = { ...s, source: 'snapshot' };
      } catch (e) { error = error || 'Could not load snapshot data.'; }
    }
    if (data) {
      prs = data.prs.filter((p) => !excluded(p.repo));
      meta = { source: data.source, fetchedAt: data.fetchedAt, error };
    } else {
      meta = { source: 'none', fetchedAt: null, error };
    }
    refreshBtn.disabled = false; refreshBtn.classList.remove('spinning');
    app.setAttribute('aria-busy', 'false');
    updateStatus();
    render();
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', !!isError);
  }
  function updateStatus() {
    if (meta.source === 'live') setStatus(`Live from GitHub · updated ${ago(meta.fetchedAt)}`);
    else if (meta.source === 'cache') setStatus(`${meta.error || 'Offline'} Showing saved copy from ${ago(meta.fetchedAt)}.`, true);
    else if (meta.source === 'snapshot') setStatus(`${meta.error || ''} Showing snapshot from ${fmtDate(meta.fetchedAt)}.`.trim(), !!meta.error);
    else setStatus(meta.error || 'No data', true);
  }

  /* ---------- aggregation ---------- */
  function byProject(list) {
    const map = new Map();
    for (const p of list) {
      if (!map.has(p.repo)) map.set(p.repo, { repo: p.repo, owner: p.repo.split('/')[0], name: p.repo.split('/')[1], merged: [], open: [], closed: [], total: 0, prs: [] });
      const g = map.get(p.repo);
      g[p.state].push(p); g.prs.push(p); g.total++;
    }
    const sortNum = (a, b) => b.number - a.number;
    for (const g of map.values()) { for (const s of STATES) g[s].sort(sortNum); g.prs.sort(sortNum); }
    return [...map.values()].sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));
  }
  const counts = (list) => ({
    total: list.length,
    merged: list.filter((p) => p.state === 'merged').length,
    open: list.filter((p) => p.state === 'open').length,
    closed: list.filter((p) => p.state === 'closed').length,
  });

  /* ---------- tooltip ---------- */
  function showTip(evt, contentNode) {
    tooltip.replaceChildren(contentNode);
    tooltip.hidden = false;
    moveTip(evt);
  }
  function moveTip(evt) {
    const pad = 12; const w = tooltip.offsetWidth; const h = tooltip.offsetHeight;
    let x = evt.clientX + pad; let y = evt.clientY + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = evt.clientY - h - pad;
    tooltip.style.left = `${x}px`; tooltip.style.top = `${y}px`;
  }
  function hideTip() { tooltip.hidden = true; }
  function attachTip(node, build) {
    node.addEventListener('pointerenter', (e) => showTip(e, build()));
    node.addEventListener('pointermove', moveTip);
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => {
      const r = node.getBoundingClientRect();
      showTip({ clientX: r.left + r.width / 2, clientY: r.top }, build());
    });
    node.addEventListener('blur', hideTip);
  }
  const tipRows = (title, rows) => el('div', null,
    el('strong', { text: title }),
    ...rows.map(([state, n]) => el('div', { class: 'row' }, el('i', { class: state }), el('b', { text: String(n) }), el('span', { text: STATE_LABEL[state] }))));

  /* ---------- charts ---------- */
  // Rounded right-end rectangle path (data-end rounding only).
  function rightRoundedRect(x, y, w, h, r) {
    r = Math.min(r, w, h / 2);
    return `M${x},${y} H${x + w - r} a${r},${r} 0 0 1 ${r},${r} V${y + h - r} a${r},${r} 0 0 1 -${r},${r} H${x} Z`;
  }
  function topRoundedRect(x, y, w, h, r) {
    r = Math.min(r, h, w / 2);
    return `M${x},${y + h} V${y + r} a${r},${r} 0 0 1 ${r},-${r} H${x + w - r} a${r},${r} 0 0 1 ${r},${r} V${y + h} Z`;
  }

  function stackedBarChart(groups, width) {
    const labelW = Math.min(200, Math.max(120, width * 0.28));
    const rowH = 28, barH = 14, top = 8, right = 44, bottom = 24;
    const plotW = Math.max(60, width - labelW - right);
    const max = Math.max(1, ...groups.map((g) => g.total));
    const height = top + groups.length * rowH + bottom;
    const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Pull requests per project, split into merged, open and closed' });
    const x = (v) => labelW + (v / max) * plotW;

    // Gridlines: a few round ticks.
    const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 20 ? 5 : 10;
    for (let v = 0; v <= max; v += step) {
      svg.append(svgEl('line', { class: 'grid', x1: x(v), x2: x(v), y1: top, y2: height - bottom }));
      svg.append(svgEl('text', { class: 'tick', x: x(v), y: height - 8, 'text-anchor': 'middle' }, String(v)));
    }
    svg.append(svgEl('line', { class: 'axis', x1: labelW, x2: labelW, y1: top, y2: height - bottom }));

    groups.forEach((g, i) => {
      const y = top + i * rowH + (rowH - barH) / 2;
      const label = svgEl('text', { class: 'cat', x: labelW - 10, y: y + barH / 2 + 4, 'text-anchor': 'end' });
      const a = svgEl('a', { href: `#/project/${g.repo}` });
      a.append(document.createTextNode(truncate(g.name, labelW / 7.2)));
      a.append(svgEl('title', null, g.repo));
      label.append(a); svg.append(label);

      let cursor = 0;
      STATES.forEach((s, si) => {
        const n = g[s].length; if (!n) return;
        const x0 = x(cursor) + (cursor > 0 ? 2 : 0);
        const x1 = x(cursor + n);
        const w = Math.max(0, x1 - x0);
        const isLast = cursor + n === g.total;
        const seg = isLast
          ? svgEl('path', { class: `seg ${s}`, d: rightRoundedRect(x0, y, w, barH, 4), tabindex: 0 })
          : svgEl('rect', { class: `seg ${s}`, x: x0, y, width: w, height: barH, tabindex: 0 });
        seg.append(svgEl('title', null, `${g.repo}: ${n} ${STATE_LABEL[s].toLowerCase()}`));
        attachTip(seg, () => tipRows(g.repo, STATES.map((st) => [st, g[st].length])));
        svg.append(seg);
        cursor += n;
      });
      svg.append(svgEl('text', { class: 'lbl', x: x(g.total) + 8, y: y + barH / 2 + 4 }, String(g.total)));
    });
    return svg;
  }

  function truncate(s, maxChars) {
    maxChars = Math.floor(maxChars);
    return s.length > maxChars ? s.slice(0, Math.max(3, maxChars - 1)) + '…' : s;
  }

  function monthlyChart(list, width) {
    // Count PRs opened per month over the last 12 months (or fewer if history is shorter).
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString(undefined, { month: 'short' }), year: d.getFullYear(), merged: 0, open: 0, closed: 0, total: 0 });
    }
    const idx = new Map(months.map((m, i) => [m.key, i]));
    for (const p of list) {
      const k = p.created.slice(0, 7);
      if (idx.has(k)) { const m = months[idx.get(k)]; m[p.state]++; m.total++; }
    }
    const top = 18, bottom = 26, left = 28, right = 8;
    const height = 220;
    const plotW = width - left - right, plotH = height - top - bottom;
    const max = Math.max(1, ...months.map((m) => m.total));
    const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Pull requests opened per month, last 12 months' });
    const y = (v) => top + plotH - (v / max) * plotH;
    const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 20 ? 5 : 10;
    for (let v = 0; v <= max; v += step) {
      svg.append(svgEl('line', { class: 'grid', x1: left, x2: width - right, y1: y(v), y2: y(v) }));
      svg.append(svgEl('text', { class: 'tick', x: left - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
    }
    svg.append(svgEl('line', { class: 'axis', x1: left, x2: width - right, y1: y(0), y2: y(0) }));
    const slot = plotW / months.length;
    const barW = Math.max(6, Math.min(28, slot - 8));
    const maxIdx = months.reduce((b, m, i) => (m.total > months[b].total ? i : b), 0);
    months.forEach((m, i) => {
      const cx = left + slot * i + slot / 2;
      const x0 = cx - barW / 2;
      if (m.total > 0) {
        const col = svgEl('path', { class: 'col', d: topRoundedRect(x0, y(m.total), barW, y(0) - y(m.total), 4), tabindex: 0 });
        col.append(svgEl('title', null, `${m.label} ${m.year}: ${m.total} opened`));
        attachTip(col, () => tipRows(`${m.label} ${m.year} · ${m.total} opened`, STATES.map((st) => [st, m[st]])));
        svg.append(col);
        if (i === maxIdx || i === months.length - 1) {
          svg.append(svgEl('text', { class: 'lbl', x: cx, y: y(m.total) - 5, 'text-anchor': 'middle' }, String(m.total)));
        }
      }
      // Wide hit area so hover doesn't need pinpoint aim.
      const hit = svgEl('rect', { x: left + slot * i, y: top, width: slot, height: plotH, fill: 'transparent' });
      attachTip(hit, () => tipRows(`${m.label} ${m.year} · ${m.total} opened`, STATES.map((st) => [st, m[st]])));
      svg.append(hit);
      if (slot >= 34 || (months.length - 1 - i) % 2 === 0) {
        svg.append(svgEl('text', { class: 'tick', x: cx, y: height - 8, 'text-anchor': 'middle' }, m.label));
      }
    });
    return svg;
  }

  /* ---------- views ---------- */
  function tile(label, value, note, state) {
    return el('div', { class: 'card tile' },
      el('div', { class: 'label' }, state ? el('i', { class: `dot ${state}` }) : null, label),
      el('div', { class: 'value', text: String(value) }),
      note ? el('div', { class: 'note', text: note }) : null);
  }

  function kpiRow(list, projectCount) {
    const c = counts(list);
    const decided = c.merged + c.closed;
    const tiles = [
      tile('Total PRs', c.total, projectCount != null ? `across ${projectCount} project${projectCount === 1 ? '' : 's'}` : null),
      tile('Merged', c.merged, `${pct(c.merged, decided)} of decided PRs`, 'merged'),
      tile('Open', c.open, 'waiting for review', 'open'),
      tile('Closed', c.closed, 'closed without merge', 'closed'),
    ];
    return el('div', { class: 'kpis' }, tiles);
  }

  const legend = () => el('div', { class: 'legend' }, STATES.map((s) => el('span', null, el('i', { class: s }), STATE_LABEL[s])));

  function chipList(items, state) {
    if (!items.length) return el('span', { class: 'none', text: '—' });
    return el('div', { class: 'chips' }, items.map((p) =>
      el('a', { class: `chip ${state}`, href: p.url, target: '_blank', rel: 'noopener', title: p.title, text: `#${p.number}` })));
  }

  function renderOverview() {
    const groups = byProject(prs);
    const c = counts(prs);
    const frag = document.createDocumentFragment();

    frag.append(el('div', { class: 'hero' },
      el('div', null,
        el('h1', { text: config.title || 'Open Source PR Dashboard' }),
        el('p', null, 'Pull requests by ', el('a', { href: `https://github.com/${config.username}`, target: '_blank', rel: 'noopener', text: `@${config.username}` }), ` to ${groups.length} open source projects.`))));

    const holds = el('div', { class: 'holds' });
    holds.append(kpiRow(prs, groups.length));

    // Charts
    const chartA = el('div', { class: 'card' }, el('h2', { text: 'PRs by project' }), el('p', { class: 'sub', text: 'Each bar is one project. Click a project name to open it.' }), legend());
    const chartB = el('div', { class: 'card' }, el('h2', { text: 'PRs opened per month' }), el('p', { class: 'sub', text: 'Last 12 months, by the month the PR was opened.' }));
    const mountA = el('div'), mountB = el('div');
    chartA.append(mountA); chartB.append(mountB);
    holds.append(el('div', { class: 'charts' }, chartA, chartB));

    // Project chooser
    holds.append(el('section', { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', { text: 'Choose a project' }), el('span', { class: 'hint', text: 'Open a project to read what each PR fixed.' })),
      el('div', { class: 'chooser' }, groups.map((g) =>
        el('button', { class: 'proj-btn', type: 'button', onclick: () => { location.hash = `#/project/${g.repo}`; } },
          el('span', { class: 'owner', text: g.owner }),
          el('span', { class: 'name', text: g.name }),
          el('span', { class: 'counts' },
            el('span', null, el('i', { class: 'dot merged' }), `${g.merged.length} merged`),
            el('span', null, el('i', { class: 'dot open' }), `${g.open.length} open`),
            el('span', null, el('i', { class: 'dot closed' }), `${g.closed.length} closed`)))))));

    // Table
    const table = el('table', null,
      el('thead', null, el('tr', null,
        el('th', { text: 'Project' }), el('th', { class: 'num', text: 'Total' }),
        el('th', { class: 'num', text: 'Merged' }), el('th', { class: 'num', text: 'Open' }), el('th', { class: 'num', text: 'Closed' }),
        el('th', { text: 'Merged PRs' }), el('th', { text: 'Open PRs' }), el('th', { text: 'Closed PRs' }))),
      el('tbody', null, groups.map((g) => el('tr', null,
        el('td', { class: 'proj' }, el('a', { href: `#/project/${g.repo}`, text: g.name }), el('span', { class: 'owner', text: g.owner })),
        el('td', { class: 'num', text: String(g.total) }),
        el('td', { class: 'num', text: String(g.merged.length) }),
        el('td', { class: 'num', text: String(g.open.length) }),
        el('td', { class: 'num', text: String(g.closed.length) }),
        el('td', null, chipList(g.merged, 'merged')),
        el('td', null, chipList(g.open, 'open')),
        el('td', null, chipList(g.closed, 'closed'))))),
      el('tfoot', null, el('tr', null,
        el('td', { text: 'All projects' }), el('td', { class: 'num', text: String(c.total) }),
        el('td', { class: 'num', text: String(c.merged) }), el('td', { class: 'num', text: String(c.open) }), el('td', { class: 'num', text: String(c.closed) }),
        el('td', { colspan: 3 }))));
    holds.append(el('section', { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', { text: 'Dashboard' }), el('span', { class: 'hint', text: 'Links open the PR on GitHub.' })),
      el('div', { class: 'card table-wrap' }, groups.length ? table : el('div', { class: 'empty', text: 'No pull requests found.' }))));

    frag.append(holds);
    app.replaceChildren(frag);

    const draw = () => {
      const wA = Math.max(280, mountA.clientWidth || chartA.clientWidth - 36);
      const wB = Math.max(240, mountB.clientWidth || chartB.clientWidth - 36);
      mountA.replaceChildren(groups.length ? stackedBarChart(groups, wA) : el('div', { class: 'empty', text: 'Nothing to chart yet.' }));
      mountB.replaceChildren(monthlyChart(prs, wB));
    };
    draw();
    currentResize = draw;
  }

  function prCard(p) {
    const s = summaries[repoKey(p)];
    const dates = [el('span', { text: `Opened ${fmtDate(p.created)}` })];
    if (p.state === 'merged') dates.push(el('span', { text: `Merged ${fmtDate(p.closed)}` }));
    else if (p.state === 'closed') dates.push(el('span', { text: `Closed ${fmtDate(p.closed)}` }));
    if (p.draft) dates.push(el('span', { text: 'Draft' }));
    return el('article', { class: 'card pr' },
      el('div', { class: 'pr-top' },
        el('div', { class: 'pr-title' }, el('a', { href: p.url, target: '_blank', rel: 'noopener', text: p.title }), el('span', { class: 'num', text: `#${p.number}` })),
        badge(p.state)),
      el('div', { class: 'pr-meta' }, dates),
      el('div', { class: 'pr-summary' },
        el('div', null, el('h4', { text: 'What was the issue' }), s ? el('p', { text: s.issue }) : el('p', { class: 'pending', text: 'Summary not written yet. Open the PR on GitHub for details.' })),
        el('div', null, el('h4', { text: 'What was done' }), s ? el('p', { text: s.done }) : el('p', { class: 'pending', text: 'Summary not written yet.' }))));
  }

  function renderProject(repo) {
    const g = byProject(prs).find((x) => x.repo === repo);
    const frag = document.createDocumentFragment();
    frag.append(el('a', { class: 'back', href: '#/' }, '← All projects'));
    if (!g) {
      frag.append(el('div', { class: 'card empty', text: `No pull requests found for ${repo}.` }));
      app.replaceChildren(frag); currentResize = null; return;
    }
    const [owner, name] = repo.split('/');
    frag.append(el('div', { class: 'proj-head' },
      el('div', null,
        el('h1', null, el('span', { class: 'owner', text: `${owner} / ` }), name),
        el('p', { class: 'sub', text: `${g.total} pull request${g.total === 1 ? '' : 's'} by @${config.username}` })),
      el('div', { class: 'links' },
        el('a', { class: 'btn', href: `https://github.com/${repo}`, target: '_blank', rel: 'noopener', text: 'Repository' }),
        el('a', { class: 'btn', href: `https://github.com/${repo}/pulls?q=${encodeURIComponent(`is:pr author:${config.username}`)}`, target: '_blank', rel: 'noopener', text: 'All my PRs on GitHub' }))));

    const holds = el('div', { class: 'holds' });
    holds.append(el('div', { class: 'section' }, kpiRow(g.prs, null)));

    holds.append(el('div', { class: 'jump' }, STATES.map((s) =>
      el('a', { class: 'btn', href: `#${s}`, onclick: (e) => { e.preventDefault(); const t = document.getElementById(`grp-${s}`); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
        el('i', { class: `dot ${s}` }), `${STATE_LABEL[s]} (${g[s].length})`))));

    for (const s of STATES) {
      const list = g[s];
      const ghQuery = `is:pr author:${config.username} ${s === 'merged' ? 'is:merged' : s === 'open' ? 'is:open' : 'is:closed is:unmerged'}`;
      holds.append(el('h2', { class: 'group-title', id: `grp-${s}` },
        el('i', { class: `dot ${s}` }), `${STATE_LABEL[s]} PRs`, el('span', { class: 'count', text: `(${list.length})` }),
        el('a', { class: 'ext', href: `https://github.com/${repo}/pulls?q=${encodeURIComponent(ghQuery)}`, target: '_blank', rel: 'noopener', text: 'View on GitHub' })));
      holds.append(list.length
        ? el('div', { class: 'prlist' }, list.map(prCard))
        : el('div', { class: 'card empty', text: `No ${STATE_LABEL[s].toLowerCase()} PRs.` }));
    }
    frag.append(holds);
    app.replaceChildren(frag);
    currentResize = null;
    window.scrollTo(0, 0);
  }

  let currentResize = null;
  function render() {
    const h = location.hash || '#/';
    const m = h.match(/^#\/project\/([^/]+\/[^/?#]+)/);
    if (m) renderProject(decodeURIComponent(m[1]));
    else renderOverview();
  }

  /* ---------- wiring ---------- */
  window.addEventListener('hashchange', render);
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => currentResize && currentResize(), 120); });
  refreshBtn.addEventListener('click', () => loadData({ live: true }));
  themeBtn.addEventListener('click', () => {
    const root = document.documentElement;
    const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const cur = root.getAttribute('data-theme') || (osDark ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  });

  async function init() {
    app.replaceChildren(el('div', { class: 'empty', text: 'Loading pull requests…' }));
    try {
      const [c, s] = await Promise.all([
        fetch('data/config.json', { cache: 'no-cache' }).then((r) => r.json()),
        fetch('data/summaries.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({})),
      ]);
      config = { ...config, ...c }; summaries = s || {};
      document.title = config.title || document.title;
      document.getElementById('brand-title').textContent = config.title || 'Open Source PR Dashboard';
    } catch (e) {
      setStatus('Could not load data/config.json', true);
    }
    await loadData({ live: true });
  }
  init();
})();
