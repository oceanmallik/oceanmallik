// scripts/generate-stats.mjs
// Generates streak-stats.svg and top-langs.svg straight from the GitHub GraphQL API.
// No third-party stat services. Requires Node 18+ and env GH_TOKEN.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const USERNAME = process.env.GH_USERNAME || "oceanmallik";
const TOKEN = process.env.GH_TOKEN;

const EXCLUDE_LANGS = new Set(["shell", "powershell", "html", "css"]);
const MAX_LANGS = 6;

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
  const year = todayStr.slice(0, 4);
  const thisYear = list.filter((d) => d.date.startsWith(year)).reduce((s, d) => s + d.count, 0);
  const activeDays = list.filter((d) => d.count > 0).length;
  const best = list.reduce((b, d) => (d.count > b.count ? d : b), { date: null, count: 0 });

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

  return { total, thisYear, activeDays, dayCount: list.length, best, current, longest };
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

const W = 460;
const H = 330;
const PAD = 28;

const GH_MARK =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z";

function cardShell({ title, ariaLabel, descLines, rows }) {
  const rowsSvg = rows
    .map((r, i) => {
      const y = 152 + i * 30;
      const delay = (0.05 + i * 0.07).toFixed(2);
      return `
  <g class="row" style="animation-delay:${delay}s">
    <path d="M3.5 8.5l3 3 6-6.5" transform="translate(${PAD} ${y - 13})" stroke="${esc(r.color || "#d4d4d4")}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="${PAD + 26}" y="${y}" font-size="14.5"><tspan fill="#d4d4d4">${esc(r.label)}:</tspan> <tspan fill="#ffffff" font-weight="600">${esc(r.value)}</tspan>${
      r.extra ? ` <tspan fill="#737373">• ${esc(r.extra)}</tspan>` : ""
    }</text>
  </g>`;
    })
    .join("");

  const cx = 352;
  const cy = 218;
  const squares = [76, 118, 160, 202]
    .map(
      (s) =>
        `<rect x="${cx - s / 2}" y="${cy - s / 2}" width="${s}" height="${s}" rx="${Math.round(s * 0.2)}" stroke="#ffffff" stroke-opacity="0.05"/>`
    )
    .join("");

  const [l1, l2] = descLines;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" role="img" aria-label="${esc(ariaLabel)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#181818"/>
      <stop offset="1" stop-color="#121212"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: ${FONT}; }
    .row { animation: fade 0.6s ease-out backwards; }
    @keyframes fade { from { opacity: 0; transform: translateY(4px); } }
  </style>

  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="20" fill="url(#bg)" stroke="#ffffff" stroke-opacity="0.1"/>

  ${squares}
  <path d="${GH_MARK}" transform="translate(${cx - 32} ${cy - 32}) scale(4)" fill="#ffffff" fill-opacity="0.07"/>

  <path d="${GH_MARK}" transform="translate(${PAD} 30) scale(1.25)" fill="#f5f5f5"/>
  <text x="${PAD + 32}" y="46" font-size="18" font-weight="600" fill="#ffffff">${esc(title)}</text>

  <text x="${PAD}" y="86" font-size="14.5" fill="#8a8a8a">${l1}</text>
  <text x="${PAD}" y="106" font-size="14.5" fill="#8a8a8a">${l2}</text>
  ${rowsSvg}
</svg>
`;
}

/* --------------------------------- Cards --------------------------------- */

export function renderStreakCard(s) {
  const { total, thisYear, activeDays, dayCount, best, current, longest, since } = s;
  const rows = [
    { label: "Contributions", value: fmtNum(total), extra: `since ${fmtDate(since, "full")}` },
    { label: "This year", value: fmtNum(thisYear) },
    { label: "Current streak", value: `${current.len} days`, extra: fmtRange(current.start, current.end) },
    { label: "Longest streak", value: `${longest.len} days`, extra: fmtRange(longest.start, longest.end) },
    { label: "Active days", value: fmtNum(activeDays), extra: `of ${fmtNum(dayCount)}` },
    { label: "Best day", value: fmtNum(best.count), extra: best.date ? fmtDate(best.date, "full") : undefined },
  ];
  return cardShell({
    title: USERNAME,
    ariaLabel: `GitHub contribution stats for ${USERNAME}`,
    descLines: [
      `<tspan fill="#ffffff">Contribution streaks</tspan> and activity from`,
      `my GitHub profile, updated every hour.`,
    ],
    rows,
  });
}

function visibleColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#a3a3a3";
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 90 ? "#a3a3a3" : hex;
}

export function renderLangsCard(langs) {
  const rows = langs.map((l) => ({
    label: l.name,
    value: l.pct < 0.1 ? "<0.1%" : `${l.pct.toFixed(1)}%`,
    color: visibleColor(l.color),
  }));
  if (!rows.length) rows.push({ label: "No language data yet", value: "-" });
  return cardShell({
    title: "Top Languages",
    ariaLabel: `Most used languages for ${USERNAME}`,
    descLines: [
      `<tspan fill="#ffffff">Most used languages</tspan> across my public`,
      `repositories. Forks and markup are excluded.`,
    ],
    rows,
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