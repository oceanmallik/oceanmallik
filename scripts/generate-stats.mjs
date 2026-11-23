// scripts/generate-stats.mjs
// Generates streak-stats.svg and top-langs.svg straight from the GitHub GraphQL API.
// No third-party stat services. Requires Node 18+ and env GH_TOKEN.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const USERNAME = process.env.GH_USERNAME || "oceanmallik";
const TOKEN = process.env.GH_TOKEN;

const EXCLUDE_LANGS = new Set(["shell", "powershell", "html", "css"]);
const MAX_LANGS = 6;
const HEATMAP_WEEKS = 56;

const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif";

/* ------------------------------ GitHub API ------------------------------ */

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "stats-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchContributions() {
  const base = await gql(
    `query($login:String!){ user(login:$login){ createdAt } }`,
    { login: USERNAME }
  );
  const created = new Date(base.user.createdAt);
  const now = new Date();
  const map = new Map();

  for (let y = created.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = y === created.getUTCFullYear() ? created.toISOString() : `${y}-01-01T00:00:00Z`;
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    const data = await gql(
      `query($login:String!,$from:DateTime!,$to:DateTime!){
        user(login:$login){
          contributionsCollection(from:$from,to:$to){
            contributionCalendar{ weeks{ contributionDays{ date contributionCount } } }
          }
        }
      }`,
      { login: USERNAME, from, to }
    );
    for (const w of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const d of w.contributionDays) map.set(d.date, d.contributionCount);
    }
  }

  const days = [...map].map(([date, count]) => ({ date, count })).sort((a, b) => (a.date < b.date ? -1 : 1));
  return { created, days };
}

async function fetchLanguages() {
  const totals = new Map();
  let after = null;
  do {
    const data = await gql(
      `query($login:String!,$after:String){
        user(login:$login){
          repositories(first:100, after:$after, ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC){
            pageInfo{ hasNextPage endCursor }
            nodes{ languages(first:20, orderBy:{field:SIZE, direction:DESC}){ edges{ size node{ name color } } } }
          }
        }
      }`,
      { login: USERNAME, after }
    );
    const repos = data.user.repositories;
    for (const repo of repos.nodes) {
      for (const e of repo.languages.edges) {
        const name = e.node.name;
        if (EXCLUDE_LANGS.has(name.toLowerCase())) continue;
        const cur = totals.get(name) || { name, color: e.node.color || "#8b949e", size: 0 };
        cur.size += e.size;
        totals.set(name, cur);
      }
    }
    after = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
  } while (after);

  const all = [...totals.values()];
  const sum = all.reduce((s, l) => s + l.size, 0) || 1;
  return all
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_LANGS)
    .map((l) => ({ ...l, pct: (l.size / sum) * 100 }));
}

/* ------------------------------- Streak math ------------------------------ */

export function computeStreaks(days) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const list = days.filter((d) => d.date <= todayStr);
  const total = list.reduce((s, d) => s + d.count, 0);

  let longest = { len: 0, start: null, end: null };
  let run = 0;
  let runStart = null;
  for (const d of list) {
    if (d.count > 0) {
      if (run === 0) runStart = d.date;
      run++;
      if (run > longest.len) longest = { len: run, start: runStart, end: d.date };
    } else {
      run = 0;
    }
  }

  const current = { len: 0, start: null, end: null };
  let i = list.length - 1;
  if (i >= 0 && list[i].count === 0) i--; // today not contributed yet: streak is still alive
  while (i >= 0 && list[i].count > 0) {
    if (!current.end) current.end = list[i].date;
    current.start = list[i].date;
    current.len++;
    i--;
  }

  return { total, current, longest, list };
}

/* -------------------------------- Helpers -------------------------------- */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmtNum = (n) => n.toLocaleString("en-US");

function fmtDate(dateStr, withYear) {
  const d = typeof dateStr === "string" ? new Date(dateStr + "T00:00:00Z") : dateStr;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

function fmtRange(start, end) {
  if (!start || !end) return "No active streak";
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${fmtDate(start, !sameYear)} - ${fmtDate(end, !sameYear)}`;
}

/* --------------------------- Streak / stats card --------------------------- */

function heatmapCells(list, x0, y0) {
  const CELL = 8;
  const GAP = 2;
  const STEP = CELL + GAP;
  if (!list.length) return "";

  const dayNum = (s) => Math.floor(Date.parse(s + "T00:00:00Z") / 864e5);
  const dow = (dn) => (dn + 4) % 7; // 1970-01-01 was a Thursday
  const lastDn = dayNum(list[list.length - 1].date);
  const lastWeekStart = lastDn - dow(lastDn);

  const visible = [];
  for (const d of list) {
    const dn = dayNum(d.date);
    const col = HEATMAP_WEEKS - 1 - (lastWeekStart - (dn - dow(dn))) / 7;
    if (col >= 0) visible.push({ ...d, col, row: dow(dn) });
  }
  const max = Math.max(1, ...visible.map((d) => d.count));
  const levels = ["#164e63", "#0e7490", "#06b6d4", "#67e8f9"];

  return visible
    .map((d) => {
      let fill = "rgba(255,255,255,0.06)";
      if (d.count > 0) {
        const r = d.count / max;
        fill = levels[r > 0.75 ? 3 : r > 0.5 ? 2 : r > 0.25 ? 1 : 0];
      }
      return `<rect x="${x0 + d.col * STEP}" y="${y0 + d.row * STEP}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`;
    })
    .join("");
}

export function renderStreakCard({ total, current, longest, list, since }) {
  const W = 640;
  const H = 320;
  const R = 40;
  const C = +(2 * Math.PI * R).toFixed(2);
  const ratio = longest.len > 0 ? Math.min(current.len / longest.len, 1) : 0;
  const offset = +(C * (1 - ratio)).toFixed(2);

  const hmWidth = HEATMAP_WEEKS * 10 - 2;
  const hmX = (W - hmWidth) / 2;

  const col = (cx, number, label, sub, color) => `
  <g class="fade">
    <text x="${cx}" y="124" text-anchor="middle" font-size="38" font-weight="700" fill="#f8fafc">${esc(number)}</text>
    <text x="${cx}" y="186" text-anchor="middle" font-size="13" font-weight="600" fill="${color}">${esc(label)}</text>
    <text x="${cx}" y="205" text-anchor="middle" font-size="11" fill="#64748b">${esc(sub)}</text>
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" role="img" aria-label="GitHub contribution stats for ${esc(USERNAME)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1220"/>
      <stop offset="1" stop-color="#121a2e"/>
    </linearGradient>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0.55"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#a78bfa" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="flame" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fde047"/>
      <stop offset="0.5" stop-color="#fb923c"/>
      <stop offset="1" stop-color="#ef4444"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fb923c" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#fb923c" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="3"/>
    </filter>
  </defs>
  <style>
    text { font-family: ${FONT}; }
    .arc { stroke-dasharray: ${C}; stroke-dashoffset: ${offset}; animation: draw 1.4s ease-out 0.2s; }
    @keyframes draw { from { stroke-dashoffset: ${C}; } }
    .fade { animation: fade 0.9s ease-out; }
    @keyframes fade { from { opacity: 0; } }
  </style>

  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="url(#bg)" stroke="url(#border)"/>
  <circle cx="320" cy="112" r="120" fill="url(#glow)"/>

  <circle cx="32" cy="34" r="4" fill="#22d3ee"/>
  <text x="44" y="38" font-size="12" font-weight="600" letter-spacing="2" fill="#94a3b8">CONTRIBUTIONS</text>
  <text x="${W - 28}" y="38" text-anchor="end" font-size="12" fill="#64748b">@${esc(USERNAME)}</text>

  ${col(110, fmtNum(total), "Total Contributions", `${fmtDate(since, true)} - Present`, "#cbd5e1")}

  <g>
    <circle cx="320" cy="112" r="${R}" stroke="rgba(255,255,255,0.08)" stroke-width="7"/>
    <g transform="rotate(-90 320 112)">
      <circle class="arc" cx="320" cy="112" r="${R}" stroke="url(#flame)" stroke-width="7" stroke-linecap="round" filter="url(#blur)" opacity="0.55"/>
      <circle class="arc" cx="320" cy="112" r="${R}" stroke="url(#flame)" stroke-width="7" stroke-linecap="round"/>
    </g>
    <g transform="translate(310 80) scale(0.85)" stroke="url(#flame)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
    </g>
    <text x="320" y="126" text-anchor="middle" font-size="30" font-weight="700" fill="#f8fafc">${current.len}</text>
    <text x="320" y="186" text-anchor="middle" font-size="13" font-weight="600" fill="#fb923c">Current Streak</text>
    <text x="320" y="205" text-anchor="middle" font-size="11" fill="#64748b">${esc(fmtRange(current.start, current.end))}</text>
  </g>

  ${col(530, String(longest.len), "Longest Streak", fmtRange(longest.start, longest.end), "#cbd5e1")}

  <line x1="215" y1="72" x2="215" y2="205" stroke="rgba(255,255,255,0.08)"/>
  <line x1="425" y1="72" x2="425" y2="205" stroke="rgba(255,255,255,0.08)"/>

  <g class="fade">${heatmapCells(list, hmX, 230)}</g>
</svg>
`;
}

/* ------------------------------ Languages card ------------------------------ */

export function renderLangsCard(langs) {
  const W = 400;
  const H = 320;
  const PAD = 28;
  const trackW = W - PAD * 2;

  const rows = langs
    .map((l, i) => {
      const y = 84 + i * 38;
      const w = Math.max(4, +((trackW * l.pct) / 100).toFixed(2));
      const pct = l.pct < 0.1 ? "<0.1%" : `${l.pct.toFixed(1)}%`;
      const delay = (0.15 + i * 0.1).toFixed(2);
      return `
  <g>
    <circle cx="${PAD + 4}" cy="${y - 4}" r="5" fill="${esc(l.color)}"/>
    <text x="${PAD + 18}" y="${y}" font-size="14" font-weight="500" fill="#e2e8f0">${esc(l.name)}</text>
    <text x="${W - PAD}" y="${y}" text-anchor="end" font-size="13" fill="#94a3b8">${esc(pct)}</text>
    <rect x="${PAD}" y="${y + 10}" width="${trackW}" height="6" rx="3" fill="rgba(255,255,255,0.07)"/>
    <rect class="bar" style="animation-delay:${delay}s" x="${PAD}" y="${y + 10}" width="${w}" height="6" rx="3" fill="${esc(l.color)}"/>
  </g>`;
    })
    .join("");

  const empty = langs.length
    ? ""
    : `<text x="${W / 2}" y="170" text-anchor="middle" font-size="14" fill="#64748b">No language data yet</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" role="img" aria-label="Most used languages for ${esc(USERNAME)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1220"/>
      <stop offset="1" stop-color="#121a2e"/>
    </linearGradient>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a78bfa" stop-opacity="0.55"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#22d3ee" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: ${FONT}; }
    .bar { animation: grow 1s ease-out backwards; }
    @keyframes grow { from { width: 0; } }
  </style>

  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="url(#bg)" stroke="url(#border)"/>

  <circle cx="32" cy="34" r="4" fill="#a78bfa"/>
  <text x="44" y="38" font-size="12" font-weight="600" letter-spacing="2" fill="#94a3b8">TOP LANGUAGES</text>
  ${rows}
  ${empty}
</svg>
`;
}

/* ---------------------------------- Main ---------------------------------- */

async function main() {
  if (!TOKEN) throw new Error("GH_TOKEN is not set");

  const [{ created, days }, langs] = await Promise.all([fetchContributions(), fetchLanguages()]);
  const stats = computeStreaks(days);

  writeFileSync("streak-stats.svg", renderStreakCard({ ...stats, since: created }));
  writeFileSync("top-langs.svg", renderLangsCard(langs));
  console.log(`Done. total=${stats.total} current=${stats.current.len} longest=${stats.longest.len} langs=${langs.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}