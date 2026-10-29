const REASONS = {
  dup: ["Exact duplicate", "dup"], near: ["Same page, other params", "near"],
  stale: ["Not viewed recently", "stale"],
  merged: ["PR merged", "gh"], closed: ["Issue/PR closed", "gh"],
  auth: ["Login/auth page", "auth"], junk: ["Blank/internal/search", "junk"], meet: ["Meeting link", "meet"]
};
const GH_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/;
const AUTH_RE = /(^|\.)(login|auth|accounts|signin)\.|\/(login|signin|sign-in|oauth|auth)(\/|$)/i;
const OPEN_TTL = 30 * 60 * 1000;
const SELF = chrome.runtime.getURL("dashboard.html");

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const host = u => { try { return new URL(u).hostname.replace(/^www\./, "") || u.split(":")[0]; } catch { return u; } };
const base = u => { try { const p = new URL(u); return p.origin + p.pathname.replace(/\/$/, ""); } catch { return u; } };
const ghKey = u => { const m = u.match(GH_RE); return m && m.slice(1).join("/"); };

function ago(ms) {
  if (!ms) return "never viewed";
  const m = (Date.now() - ms) / 60000;
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

let tabs = [];
let gh = {};
const checked = new Set();
const openGroups = new Set();
const filters = { reason: "" };

async function load() {
  const [all, wins] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
  const winNo = new Map(wins.map(w => w.id).sort((a, b) => a - b).map((id, i) => [id, i + 1]));
  const incognito = new Set(wins.filter(w => w.incognito).map(w => w.id));
  tabs = all.filter(t => t.url !== SELF).map(t => ({
    id: t.id, windowId: t.windowId, w: winNo.get(t.windowId), i: t.index + 1,
    title: t.title, url: t.url || t.pendingUrl || "", active: t.active, pinned: t.pinned,
    lastAccessed: t.lastAccessed, incognito: incognito.has(t.windowId)
  }));
  const live = new Set(tabs.map(t => t.id));
  [...checked].forEach(id => live.has(id) || checked.delete(id));

  const sel = $("win"), cur = sel.value;
  sel.length = 1;
  [...new Set(tabs.map(t => t.w))].sort((a, b) => a - b).forEach(w =>
    sel.add(new Option(`Window ${w} (${tabs.filter(t => t.w === w).length})`, w)));
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : "";

  classify();
  render();
  refreshGitHub();
}

function classify() {
  const staleMs = +$("stale").value * 86400000;
  const bases = new Map();
  tabs.forEach(t => bases.set(base(t.url), (bases.get(base(t.url)) || 0) + 1));
  const seen = new Set(), seenBase = new Set();
  for (const t of tabs) {
    const r = [], b = base(t.url);
    let p; try { p = new URL(t.url); } catch { p = null; }
    if (seen.has(t.url)) r.push("dup");
    else if (bases.get(b) > 1 && seenBase.has(b)) r.push("near");
    seen.add(t.url); seenBase.add(b);
    if (!t.active && !t.pinned && t.lastAccessed && Date.now() - t.lastAccessed > staleMs) r.push("stale");
    const k = ghKey(t.url);
    t.gh = k && gh[k] ? gh[k].state : undefined;
    if (t.gh === "merged") r.push("merged");
    if (t.gh === "closed") r.push("closed");
    if (p && /^https?:$/.test(p.protocol) && AUTH_RE.test(p.hostname + p.pathname)) r.push("auth");
    if (!p || /^(chrome|about):/.test(t.url) && /newtab|blank/.test(t.url) ||
        (p.hostname.endsWith("google.com") && p.pathname === "/search") ||
        (p.hostname === "x.com" && p.pathname.startsWith("/search"))) r.push("junk");
    if (p && (p.hostname === "meet.google.com" || /zoom\.us\/j\//.test(t.url))) r.push("meet");
    t.reasons = r;
  }
}

async function refreshGitHub() {
  const { ghCache = {}, ghToken = "" } = await chrome.storage.local.get(["ghCache", "ghToken"]);
  gh = ghCache;
  const keys = [...new Set(tabs.map(t => ghKey(t.url)).filter(Boolean))];
  const todo = keys.filter(k => !gh[k] || gh[k].state === "open" && Date.now() - gh[k].t > OPEN_TTL);
  const status = $("ghStatus");
  if (!todo.length) { status.textContent = `GitHub: ${keys.length} items (cached)`; classify(); render(); return; }
  status.textContent = `GitHub: checking ${todo.length}...`;
  const headers = { Accept: "application/vnd.github+json" };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
  let failed = 0, remaining = "?";
  const queue = [...todo];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let k; (k = queue.shift());) {
      const [o, r, , n] = k.split("/");
      try {
        const res = await fetch(`https://api.github.com/repos/${o}/${r}/issues/${n}`, { headers });
        remaining = res.headers.get("x-ratelimit-remaining") ?? remaining;
        if (!res.ok) { failed++; continue; }
        const d = await res.json();
        gh[k] = { state: d.pull_request?.merged_at ? "merged" : d.state, t: Date.now() };
      } catch { failed++; }
    }
  }));
  await chrome.storage.local.set({ ghCache: gh });
  status.textContent = `GitHub: ${keys.length} items` +
    (failed ? `, ${failed} failed (private repo or rate limit; add a token)` : "") +
    `, ${remaining} API calls left`;
  classify();
  render();
}

function visible() {
  let re; const q = $("q").value.trim();
  try { re = q ? new RegExp(q, "i") : null; } catch { re = { test: s => s.toLowerCase().includes(q.toLowerCase()) }; }
  const w = $("win").value, only = $("onlyCand").checked, r = filters.reason;
  return tabs.filter(t =>
    (!re || re.test(t.title) || re.test(t.url)) && (!w || t.w == w) &&
    (!only || t.reasons.length) &&
    (!r || (r === "any" ? t.reasons.length : t.reasons.includes(r))));
}

function renderStats() {
  const cand = tabs.filter(t => t.reasons.length).length;
  const items = [["", tabs.length, "all tabs"], ["any", cand, "candidates"]]
    .concat(Object.entries(REASONS).map(([k, [l]]) => [k, tabs.filter(t => t.reasons.includes(k)).length, l]))
    .filter(x => x[1] > 0);
  $("stats").innerHTML = items.map(([k, n, l]) =>
    `<div class="stat ${filters.reason === k ? "on" : ""}" data-k="${k}"><b>${n}</b>${esc(l)}</div>`).join("");
  $("summary").textContent = `- ${tabs.length} tabs, ${new Set(tabs.map(t => t.w)).size} windows`;
}

function row(t) {
  const tags = t.reasons.map(r => `<span class="tag ${REASONS[r][1]}">${REASONS[r][0]}</span>`);
  if (t.gh === "open") tags.push(`<span class="tag">open</span>`);
  if (t.active) tags.push(`<span class="tag act">active</span>`);
  if (t.pinned) tags.push(`<span class="tag">pinned</span>`);
  if (t.incognito) tags.push(`<span class="tag">incognito</span>`);
  tags.push(`<span class="tag">${ago(t.lastAccessed)}</span>`, `<span class="tag">W${t.w} #${t.i}</span>`);
  return `<div class="row"><input type="checkbox" data-id="${t.id}" ${checked.has(t.id) ? "checked" : ""}>
    <div><button class="title" data-id="${t.id}" title="Switch to this tab">${esc(t.title || "(untitled)")}</button>
    <div class="url">${esc(t.url)}</div></div><div class="meta">${tags.join("")}</div></div>`;
}

function render() {
  renderStats();
  const v = visible(), g = $("group").value;
  if ($("sort").value === "oldest") v.sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
  const groups = new Map();
  for (const t of v) {
    const keys = g === "domain" ? [host(t.url)] : g === "window" ? [`Window ${t.w}`]
      : g === "reason" ? (t.reasons.length ? t.reasons.map(r => REASONS[r][0]) : ["No obvious reason"]) : ["All"];
    keys.forEach(k => (groups.get(k) || groups.set(k, []).get(k)).push(t));
  }
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
  const autoOpen = sorted.length <= 6 || g === "none";
  $("list").innerHTML = sorted.map(([k, ts]) => {
    const c = ts.filter(t => t.reasons.length).length;
    return `<details class="group" data-k="${esc(k)}" ${autoOpen || openGroups.has(k) ? "open" : ""}>
      <summary><b>${esc(k)}</b><span class="n">${ts.length}</span>
      ${c && g !== "reason" ? `<span class="c">${c} candidate${c > 1 ? "s" : ""}</span>` : ""}</summary>${ts.map(row).join("")}</details>`;
  }).join("") || `<p class="note">No tabs match.</p>`;
  updCopy();
}

const updCopy = () => $("copy").textContent = `Copy checked URLs (${checked.size})`;

async function focusTab(id) {
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  await chrome.tabs.update(id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
}

$("list").addEventListener("click", e => {
  const b = e.target.closest(".title");
  if (b) focusTab(+b.dataset.id);
});
$("list").addEventListener("change", e => {
  const cb = e.target.closest("input[type=checkbox]");
  if (!cb) return;
  cb.checked ? checked.add(+cb.dataset.id) : checked.delete(+cb.dataset.id);
  updCopy();
});
$("list").addEventListener("toggle", e => {
  const k = e.target.dataset.k;
  if (k !== undefined) e.target.open ? openGroups.add(k) : openGroups.delete(k);
}, true);
$("stats").addEventListener("click", e => {
  const s = e.target.closest(".stat");
  if (s) { filters.reason = s.dataset.k; render(); }
});
["q", "group", "sort", "onlyCand"].forEach(id => $(id).addEventListener("input", render));
$("win").addEventListener("change", render);
$("stale").addEventListener("change", () => { classify(); render(); });
$("refresh").addEventListener("click", load);
$("checkVis").addEventListener("click", () => { visible().forEach(t => checked.add(t.id)); render(); });
$("clear").addEventListener("click", () => { checked.clear(); render(); });
$("copy").addEventListener("click", async () => {
  const txt = tabs.filter(t => checked.has(t.id)).map(t => `${t.title}\n${t.url}`).join("\n\n");
  try {
    await navigator.clipboard.writeText(txt);
    $("copy").textContent = `Copied ${checked.size}`;
  } catch {
    $("copy").textContent = "Copy failed";
  }
  setTimeout(updCopy, 1500);
});

chrome.storage.local.get("ghToken").then(({ ghToken = "" }) => { $("token").value = ghToken; });
$("token").addEventListener("change", async () => {
  await chrome.storage.local.set({ ghToken: $("token").value.trim(), ghCache: {} });
  refreshGitHub();
});

// Keep the list live as tabs open, close, or navigate elsewhere.
let pending;
const schedule = () => { clearTimeout(pending); pending = setTimeout(load, 800); };
chrome.tabs.onCreated.addListener(schedule);
chrome.tabs.onRemoved.addListener(schedule);
chrome.tabs.onMoved.addListener(schedule);
chrome.tabs.onAttached.addListener(schedule);
chrome.tabs.onUpdated.addListener((id, info) => { if (info.url || info.title) schedule(); });

load();
