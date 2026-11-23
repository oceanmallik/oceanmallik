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

const FONT = "Inter, 'Segoe UI', system-ui, Ubuntu, 'Helvetica Neue', Arial, sans-serif";

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
        const cur = totals.get(name) || { name, color: e.node.color || "#a3a3a3", size: 0 };
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

  return { total, longest, current, list };
}

/* -------------------------------- Helpers -------------------------------- */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmtNum = (n) => n.toLocaleString("en-US");

function fmtDate(dateStr, mode) {
  // mode: "none" -> Mar 14, "short" -> Mar 14 '25, "full" -> Mar 14, 2025
  const d = typeof dateStr === "string" ? new Date(dateStr + "T00:00:00Z") : dateStr;
  const base = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const y = d.getUTCFullYear();
  if (mode === "full") return `${base}, ${y}`;
  if (mode === "short") return `${base} '${String(y).slice(2)}`;
  return base;
}

function fmtRange(start, end) {
  if (!start || !end) return "no active streak";
  const mode = start.slice(0, 4) === end.slice(0, 4) ? "none" : "short";
  return `${fmtDate(start, mode)} - ${fmtDate(end, mode)}`;
}

/* ------------------------------ Shared card UI ------------------------------ */

const GH_MARK =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z";

// Neutral dark card shell: border, faded GitHub logo + concentric squares, header (icon + title).
function shell({ W, H, title, right, logoX, logoY, body, extraDefs = "", extraCss = "" }) {
  const squares = [76, 118, 160, 202]
    .map(
      (s) =>
        `<rect x="${logoX - s / 2}" y="${logoY - s / 2}" width="${s}" height="${s}" rx="${Math.round(s * 0.2)}" stroke="#ffffff" stroke-opacity="0.05"/>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" role="img" aria-label="${esc(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#181818"/>
      <stop offset="1" stop-color="#121212"/>
    </linearGradient>${extraDefs}
  </defs>
  <style>
    text { font-family: ${FONT}; }
    .fade { animation: fade 0.9s ease-out; }
    @keyframes fade { from { opacity: 0; } }${extraCss}
  </style>

  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="20" fill="url(#bg)" stroke="#ffffff" stroke-opacity="0.1"/>

  ${squares}
  <path d="${GH_MARK}" transform="translate(${logoX - 32} ${logoY - 32}) scale(4)" fill="#ffffff" fill-opacity="0.07"/>

  <path d="${GH_MARK}" transform="translate(28 26) scale(1.25)" fill="#f5f5f5"/>
  <text x="60" y="42" font-size="18" font-weight="600" fill="#ffffff">${esc(title)}</text>
  ${right ? `<text x="${W - 28}" y="42" text-anchor="end" font-size="12.5" fill="#737373">${esc(right)}</text>` : ""}
${body}
</svg>
`;
}

/* ------------------------------ Streak card ------------------------------ */

function heatmapCells(list, x0, y0) {
  const CELL = 8;
  const STEP = 10;
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
  const levels = [0.28, 0.5, 0.75, 1];

  return visible
    .map((d) => {
      let fill = "#ffffff";
      let op = 0.06;
      if (d.count > 0) {
        const r = d.count / max;
        op = levels[r > 0.75 ? 3 : r > 0.5 ? 2 : r > 0.25 ? 1 : 0];
      }
      return `<rect x="${x0 + d.col * STEP}" y="${y0 + d.row * STEP}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}" fill-opacity="${op}"/>`;
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

  const col = (cx, number, label, sub) => `
  <g class="fade">
    <text x="${cx}" y="134" text-anchor="middle" font-size="38" font-weight="700" fill="#ffffff">${esc(number)}</text>
    <text x="${cx}" y="196" text-anchor="middle" font-size="13" font-weight="600" fill="#d4d4d4">${esc(label)}</text>
    <text x="${cx}" y="215" text-anchor="middle" font-size="11" fill="#737373">${esc(sub)}</text>
  </g>`;

  const body = `
  <circle cx="320" cy="122" r="120" fill="url(#glow)"/>

  ${col(110, fmtNum(total), "Total Contributions", `${fmtDate(since, "full")} - Present`)}

  <g>
    <circle cx="320" cy="122" r="${R}" stroke="#ffffff" stroke-opacity="0.08" stroke-width="7"/>
    <g transform="rotate(-90 320 122)">
      <circle class="arc" cx="320" cy="122" r="${R}" stroke="url(#flame)" stroke-width="7" stroke-linecap="round" filter="url(#blur)" opacity="0.5"/>
      <circle class="arc" cx="320" cy="122" r="${R}" stroke="url(#flame)" stroke-width="7" stroke-linecap="round"/>
    </g>
    <g transform="translate(310 90) scale(0.85)" stroke="url(#flame)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
    </g>
    <text x="320" y="136" text-anchor="middle" font-size="30" font-weight="700" fill="#ffffff">${current.len}</text>
    <text x="320" y="196" text-anchor="middle" font-size="13" font-weight="600" fill="#fb923c">Current Streak</text>
    <text x="320" y="215" text-anchor="middle" font-size="11" fill="#737373">${esc(fmtRange(current.start, current.end))}</text>
  </g>

  ${col(530, String(longest.len), "Longest Streak", fmtRange(longest.start, longest.end))}

  <line x1="215" y1="80" x2="215" y2="215" stroke="#ffffff" stroke-opacity="0.08"/>
  <line x1="425" y1="80" x2="425" y2="215" stroke="#ffffff" stroke-opacity="0.08"/>

  <g class="fade">${heatmapCells(list, hmX, 238)}</g>`;

  const extraDefs = `
    <linearGradient id="flame" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fde047"/>
      <stop offset="0.5" stop-color="#fb923c"/>
      <stop offset="1" stop-color="#ef4444"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fb923c" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#fb923c" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="3"/>
    </filter>`;

  const extraCss = `
    .arc { stroke-dasharray: ${C}; stroke-dashoffset: ${offset}; animation: draw 1.4s ease-out 0.2s; }
    @keyframes draw { from { stroke-dashoffset: ${C}; } }`;

  return shell({
    W, H, title: "Contributions", right: `@${USERNAME}`,
    logoX: 540, logoY: 170, body, extraDefs, extraCss,
  });
}

/* ------------------------------ Languages card ------------------------------ */

function visibleColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#a3a3a3";
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 90 ? "#a3a3a3" : hex;
}

export function renderLangsCard(langs) {
  const W = 400;
  const H = 320;
  const PAD = 28;
  const trackW = W - PAD * 2;

  const rows = langs
    .map((l, i) => {
      const y = 94 + i * 37;
      const color = visibleColor(l.color);
      const w = Math.max(4, +((trackW * l.pct) / 100).toFixed(2));
      const pct = l.pct < 0.1 ? "<0.1%" : `${l.pct.toFixed(1)}%`;
      const delay = (0.15 + i * 0.1).toFixed(2);
      return `
  <g>
    <circle cx="${PAD + 4}" cy="${y - 4}" r="5" fill="${esc(color)}"/>
    <text x="${PAD + 18}" y="${y}" font-size="14" font-weight="500" fill="#e5e5e5">${esc(l.name)}</text>
    <text x="${W - PAD}" y="${y}" text-anchor="end" font-size="13" fill="#a3a3a3">${esc(pct)}</text>
    <rect x="${PAD}" y="${y + 10}" width="${trackW}" height="6" rx="3" fill="#ffffff" fill-opacity="0.08"/>
    <rect class="bar" style="animation-delay:${delay}s" x="${PAD}" y="${y + 10}" width="${w}" height="6" rx="3" fill="${esc(color)}"/>
  </g>`;
    })
    .join("");

  const empty = langs.length
    ? ""
    : `<text x="${W / 2}" y="180" text-anchor="middle" font-size="14" fill="#737373">No language data yet</text>`;

  const extraCss = `
    .bar { animation: grow 1s ease-out backwards; }
    @keyframes grow { from { width: 0; } }`;

  return shell({
    W, H, title: "Top Languages", right: "",
    logoX: 290, logoY: 190, body: rows + empty, extraCss,
  });
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