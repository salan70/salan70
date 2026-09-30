// プロフィール README の TUI 風 SVG を GitHub API の統計から生成する。
// 使い方: GITHUB_TOKEN=... FONT_DIR=<HackGen の ttf があるディレクトリ> node scripts/generate.mjs <出力ディレクトリ>
// 出力ディレクトリに前回までの history.json があれば、前日比を計算して追記する。
// フォントは SVG で使う文字だけに pyftsubset で絞って埋め込む。PYFTSUBSET でコマンドを差し替えられる。
import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOGIN = "salan70";
const TAGLINE = "# deps: chiba-lotte-marines, mapo-tofu, pokemon-sleep (pinned in flake.lock)";
// 実際に打つと、この README が端末に表示される。
const BOOT_COMMAND = `gh repo view ${LOGIN}/${LOGIN}`;
const COMMAND = `${LOGIN} stats --all-time`;
// repos ペインのツリー。SELECTED の行を選択状態にする。
// 非公開リポジトリも名前は出し、鍵アイコンを付ける。
const TREE = [
  { dir: "tools", repos: ["repomonk", "docbridge", "keysync"] },
  { dir: "mobile_apps", repos: ["389-app", "440", "baseball_player_journey", "share-expenses", "MyRecipee", "teigiii_app"] },
  { dir: "others", repos: ["uiux-numa", "atcoder"] },
];
const SELECTED = "repomonk";
// 生成物が大半を占め、書いた量を表さない言語は集計から外す。
const EXCLUDED_LANGUAGES = new Set(["HTML"]);
const STACK = "nix, rust, ts, dart";
const HISTORY_DAYS = 14;
const LOG_LINES = 3;

const FONT_FILES = { 400: "HackGen35ConsoleNF-Regular.ttf", 700: "HackGen35ConsoleNF-Bold.ttf" };
// HackGen35 の半角幅は 618/1024 em、全角幅は 1030/1024 em。
const HALF = 618 / 1024;
const FULL = 1030 / 1024;
const CHAR = 13 * HALF;

// Nerd Font のアイコン。
const ICON = {
  folder: "\uF07C",
  repo: "\uF401",
  lock: "\uF023",
  clock: "\uF017",
  nix: "\uF313",
  calendar: "\uF073",
  sepRight: "\uE0B0",
};
const LANG_ICON = {
  Rust: "\uE7A8",
  TypeScript: "\uE628",
  Dart: "\uE798",
  Swift: "\uE755",
  Python: "\uE73C",
  Java: "\uE738",
  JavaScript: "\uE74E",
  HTML: "\uE736",
  Shell: "\uF489",
  "C++": "\uE61D",
};

// kanagawa.nvim のパレット。ダークは Wave、ライトは Lotus。
// 言語の色も GitHub の色相に近いパレット内の色へ寄せ、画面全体の色数を抑える。
const THEMES = {
  dark: {
    bg: "#1F1F28", // sumiInk3
    bar: "#2A2A37", // sumiInk4
    line: "#363646", // sumiInk5
    text: "#DCD7BA", // fujiWhite
    dim: "#727169", // fujiGray
    accent: "#7E9CD8", // crystalBlue
    onAccent: "#16161D", // sumiInk0
    sel: "#2D4F67", // waveBlue2
    onSel: "#DCD7BA", // fujiWhite
    prompt: "#98BB6C", // springGreen
    hash: "#E6C384", // carpYellow
    up: "#98BB6C", // springGreen
    cursor: "#C8C093", // oldWhite
    lang: {
      TypeScript: "#7E9CD8", // crystalBlue
      Swift: "#E46876", // waveRed
      Dart: "#7AA89F", // waveAqua2
      JavaScript: "#E6C384", // carpYellow
      Rust: "#FFA066", // surimiOrange
      Python: "#7FB4CA", // springBlue
      Java: "#C0A36E", // boatYellow2
      HTML: "#D27E99", // sakuraPink
      Shell: "#98BB6C", // springGreen
      "C++": "#957FB8", // oniViolet
    },
  },
  light: {
    bg: "#F2ECBC", // lotusWhite3
    bar: "#E5DDB0", // lotusWhite2
    line: "#C7C0A0", // lotusWhite0 と lotusGray3 の中間。lotusWhite0 では背景に溶ける
    text: "#545464", // lotusInk1
    dim: "#8A8980", // lotusGray3
    accent: "#4D699B", // lotusBlue4
    onAccent: "#F2ECBC", // lotusWhite3
    sel: "#B5CBD2", // lotusBlue2
    onSel: "#43436C", // lotusInk2
    prompt: "#6F894E", // lotusGreen
    hash: "#77713F", // lotusYellow
    up: "#6F894E", // lotusGreen
    cursor: "#43436C", // lotusInk2
    lang: {
      TypeScript: "#4D699B", // lotusBlue4
      Swift: "#C84053", // lotusRed
      Dart: "#597B75", // lotusAqua
      JavaScript: "#DE9800", // lotusYellow3
      Rust: "#CC6D00", // lotusOrange
      Python: "#4E8CA2", // lotusTeal1
      Java: "#77713F", // lotusYellow
      HTML: "#B35B79", // lotusPink
      Shell: "#6F894E", // lotusGreen
      "C++": "#624C83", // lotusViolet4
    },
  },
};

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN が必要です");

async function graphql(query) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchStats() {
  const { user } = await graphql(`{
    user(login: "${LOGIN}") {
      id
      createdAt
      pullRequests { totalCount }
      issues { totalCount }
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
        totalCount
        nodes {
          name
          isPrivate
          primaryLanguage { name color }
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }`);

  // contributionsCollection のコミット数は、トークンから見えない非公開リポジトリの分を
  // restrictedContributionsCount へ回して数えない。検索 API はトークンから見える全リポジトリを数える。
  const commits = (await rest(`/search/commits?q=author:${LOGIN}&per_page=1`)).total_count;

  // git log ペインは、非公開リポジトリの名前やメッセージを出さないよう公開リポジトリだけから引く。
  // 1 つのリポジトリで埋まらないよう、リポジトリごとに merge 以外の最新コミットを 1 件ずつ出す。
  const { user: pub } = await graphql(`{
    user(login: "${LOGIN}") {
      repositories(first: 10, privacy: PUBLIC, ownerAffiliations: OWNER, isFork: false, orderBy: { field: PUSHED_AT, direction: DESC }) {
        nodes {
          name
          defaultBranchRef { target { ... on Commit {
            history(first: 5, author: { id: "${user.id}" }) { nodes { abbreviatedOid messageHeadline committedDate } }
          } } }
        }
      }
    }
  }`);
  const log = pub.repositories.nodes
    .filter((r) => r.name !== LOGIN)
    .flatMap((r) => {
      const latest = (r.defaultBranchRef?.target.history.nodes ?? []).find((c) => !c.messageHeadline.startsWith("Merge "));
      return latest ? [{ ...latest, repo: r.name }] : [];
    })
    .sort((a, b) => b.committedDate.localeCompare(a.committedDate))
    .slice(0, LOG_LINES);

  const repos = user.repositories.nodes;
  const bytes = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      if (EXCLUDED_LANGUAGES.has(node.name)) continue;
      const cur = bytes.get(node.name) ?? { size: 0, color: node.color };
      cur.size += size;
      bytes.set(node.name, cur);
    }
  }
  const total = [...bytes.values()].reduce((n, l) => n + l.size, 0);
  const languages = [...bytes.entries()]
    .map(([name, { size, color }]) => ({ name, color: color ?? "#888888", ratio: size / total }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5);

  return {
    createdAt: new Date(user.createdAt),
    counts: {
      commits,
      pullRequests: user.pullRequests.totalCount,
      issues: user.issues.totalCount,
      repos: user.repositories.totalCount,
    },
    languages,
    repoByName: new Map(repos.map((r) => [r.name, r])),
    log,
  };
}

// 前日比は、今日より前の日付で最も新しい記録と比べる。同じ日に何度実行しても基準は動かない。
async function withHistory(outDir, today, counts) {
  const path = join(outDir, "history.json");
  const history = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
  const base = Object.keys(history)
    .filter((d) => d < today)
    .sort()
    .at(-1);
  history[today] = counts;
  const kept = Object.fromEntries(Object.entries(history).sort().slice(-HISTORY_DAYS));
  await writeFile(path, `${JSON.stringify(kept, null, 2)}\n`);
  return base ? Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v - (history[base][k] ?? v)])) : null;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => n.toLocaleString("en-US");
const isWide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch);
// 表示幅を半角 1 として数える。
const cells = (s) => [...s].reduce((n, ch) => n + (isWide(ch) ? FULL / HALF : 1), 0);

function truncate(s, max) {
  let out = "";
  for (const ch of s) {
    if (cells(out + ch) > max - 1) return `${out}…`;
    out += ch;
  }
  return out;
}

function uptime(from, to) {
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  return `${Math.floor(months / 12)}y ${months % 12}m`;
}

// SMIL で begin 秒まで要素を隠す。非対応の環境では最初から見える。
const hideUntil = (begin) => `<set attributeName="visibility" to="hidden" begin="0s" dur="${begin.toFixed(2)}s"/>`;

// 1 文字ずつ打つ。clipPath の幅とカーソル位置を文字単位で進める。
function typing(t, { id, x, y, text, begin, perChar, cursorFrom = 0, cursorUntil }) {
  const n = text.length;
  const dur = n * perChar;
  const steps = (offset) => Array.from({ length: n + 1 }, (_, i) => (offset + i * CHAR).toFixed(1)).join(";");
  return {
    end: begin + dur,
    defs: `<clipPath id="${id}"><rect x="${x}" y="${y - 16}" height="24" width="${n * CHAR}">
      <set attributeName="width" to="0" begin="0s" dur="${begin.toFixed(2)}s"/>
      <animate attributeName="width" begin="${begin.toFixed(2)}s" dur="${dur.toFixed(2)}s" calcMode="discrete" values="${steps(0)}" fill="freeze"/>
    </rect></clipPath>`,
    body: `<text x="${x}" y="${y}" fill="${t.text}" clip-path="url(#${id})">${esc(text)}</text>
    <rect x="${x + n * CHAR + 2}" y="${y - 13}" width="8" height="17" fill="${t.cursor}" visibility="hidden">
      <set attributeName="visibility" to="visible" begin="${cursorFrom.toFixed(2)}s" dur="${(cursorUntil - cursorFrom).toFixed(2)}s"/>
      <set attributeName="x" to="${x + 2}" begin="0s" dur="${begin.toFixed(2)}s"/>
      <animate attributeName="x" begin="${begin.toFixed(2)}s" dur="${dur.toFixed(2)}s" calcMode="discrete" values="${steps(x + 2)}" fill="freeze"/>
    </rect>`,
  };
}

// SMIL で数値をカウントアップする。各コマに <text> を置き、そのコマの間だけ見せる。
// SMIL 非対応の環境では最終コマだけが見える。
function countUp(value, { x, y, cls, fill, begin, dur, frames = 24 }) {
  const easeOut = (p) => 1 - (1 - p) ** 3;
  const step = dur / frames;
  const parts = [];
  for (let i = 0; i < frames; i++) {
    const v = Math.round(value * easeOut(i / frames));
    parts.push(
      `<text x="${x}" y="${y}" class="${cls}" fill="${fill}" visibility="hidden">${fmt(v)}<set attributeName="visibility" to="visible" begin="${(begin + i * step).toFixed(3)}s" dur="${step.toFixed(3)}s"/></text>`,
    );
  }
  parts.push(`<text x="${x}" y="${y}" class="${cls}" fill="${fill}">${fmt(value)}${hideUntil(begin + dur)}</text>`);
  return parts.join("");
}

// ペイン。罫線の上辺にタイトルを埋め込む。
function pane(t, { x, y, w, h, title, active = false }) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="none" stroke="${active ? t.accent : t.line}"/>
  <rect x="${x + 10}" y="${y - 1}" width="${cells(title) * CHAR + 12}" height="2" fill="${t.bg}"/>
  <text x="${x + 16}" y="${y + 4}" fill="${active ? t.accent : t.dim}" ${active ? 'font-weight="700"' : ""}>${esc(title)}</text>`;
}

function render(stats, delta, t, today) {
  const W = 1000;
  const TOP = 48;
  const LEFT_X = 16;
  const LEFT_W = 296;
  const RX = LEFT_X + LEFT_W + 12;
  const RW = W - 16 - RX;
  const ROW = 20;

  // 起動: 素のシェルで nix run を打つと TUI が立ち上がる
  const boot = typing(t, {
    id: "boot",
    x: 24 + 2 * CHAR,
    y: TOP + 24,
    text: BOOT_COMMAND,
    begin: 0.5,
    perChar: 0.04,
    cursorUntil: 0.5 + BOOT_COMMAND.length * 0.04 + 0.35,
  });
  const T0 = boot.end + 0.35;

  // 右列: zsh, langs, git log を上から積む。左列の repos はその高さに合わせる。
  const zshH = 286;
  const langTop = TOP + zshH + 16;
  const langH = 68;
  const logH = 40 + LOG_LINES * ROW;
  const logTop = langTop + langH + 16;
  const BAR = logTop + logH + 12;
  const H = BAR + 30;

  // repos ペイン: ディレクトリ単位のツリー
  const TREE_ROW = 22;
  const treeRows = [];
  TREE.forEach(({ dir, repos }, di) => {
    const lastDir = di === TREE.length - 1;
    treeRows.push({ prefix: lastDir ? "└─" : "├─", icon: ICON.folder, iconColor: t.dim, name: `${dir}/`, dir: true });
    repos.forEach((name, ri) => {
      const repo = stats.repoByName.get(name);
      const lang = repo?.primaryLanguage;
      treeRows.push({
        prefix: `${lastDir ? "  " : "│ "}${ri === repos.length - 1 ? "└─" : "├─"}`,
        icon: LANG_ICON[lang?.name] ?? ICON.repo,
        iconColor: t.lang[lang?.name] ?? lang?.color ?? t.dim,
        name,
        isPrivate: repo?.isPrivate ?? false,
        selected: name === SELECTED,
      });
    });
  });
  const reposH = BAR - 12 - TOP;
  const repoRows = treeRows
    .map((row, i) => {
      const y = TOP + 50 + i * TREE_ROW;
      const fg = row.selected ? t.onSel : row.dir ? t.dim : t.text;
      return `${row.selected ? `<rect x="${LEFT_X + 6}" y="${y - 15}" width="${LEFT_W - 12}" height="21" fill="${t.sel}"/>` : ""}
      <text x="${LEFT_X + 14}" y="${y}"><tspan fill="${row.selected ? t.onSel : t.line}">${row.prefix}</tspan> <tspan fill="${row.iconColor}">${row.icon}</tspan> <tspan fill="${fg}" ${row.selected ? 'font-weight="700"' : ""}>${esc(row.name)}</tspan></text>
      ${row.isPrivate ? `<text x="${LEFT_X + LEFT_W - 14}" y="${y}" fill="${row.selected ? t.onSel : t.dim}" text-anchor="end">${ICON.lock}</text>` : ""}`;
    })
    .join("\n");
  const reposFooter = `<text x="${LEFT_X + 14}" y="${TOP + reposH - 16}" fill="${t.dim}">${ICON.lock} private</text>
  <text x="${LEFT_X + LEFT_W - 14}" y="${TOP + reposH - 16}" fill="${t.dim}" text-anchor="end">${treeRows.filter((r) => !r.dir).length} of ${stats.counts.repos} repos</text>`;

  // langs ペイン: 言語ごとに列を分け、btop 風の区切りメーターを並べる
  const SEGMENTS = 8;
  const langColW = (RW - 40) / stats.languages.length;
  const langRows = stats.languages
    .map((l, i) => {
      const x = RX + 20 + i * langColW;
      const color = t.lang[l.name] ?? l.color;
      // 上位の言語でも 4 割前後なので、メーターは 50% で満タンにする。
      const on = Math.max(1, Math.round(Math.min(l.ratio * 2, 1) * SEGMENTS));
      const segs = Array.from(
        { length: SEGMENTS },
        (_, s) => `<rect x="${x + s * 8}" y="${langTop + 43}" width="6" height="9" fill="${s < on ? color : t.line}"/>`,
      ).join("");
      return `<text x="${x}" y="${langTop + 30}"><tspan fill="${color}">${LANG_ICON[l.name] ?? ICON.repo}</tspan> <tspan fill="${t.text}">${esc(l.name)}</tspan></text>
      ${segs}
      <text x="${x + langColW - 20}" y="${langTop + 52}" fill="${t.dim}" text-anchor="end">${Math.round(l.ratio * 100)}%</text>`;
    })
    .join("\n");

  // git log ペイン
  const logRows = stats.log
    .map((c, i) => {
      const y = logTop + 32 + i * ROW;
      const date = new Date(new Date(c.committedDate).getTime() + 9 * 3600 * 1000).toISOString().slice(5, 10);
      const right = `${c.repo}  ${date}`;
      const room = Math.floor((RW - 40) / CHAR) - 9 - cells(right) - 2;
      const message = c.messageHeadline.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").trim();
      return `<text x="${RX + 20}" y="${y}"><tspan fill="${t.hash}">${c.abbreviatedOid.slice(0, 7)}</tspan>  <tspan fill="${t.text}">${esc(truncate(message, room))}</tspan></text>
      <text x="${RX + RW - 20}" y="${y}" fill="${t.dim}" text-anchor="end">${esc(right)}</text>`;
    })
    .join("\n");

  // zsh ペイン: コマンドを打ち、出力として統計が出る
  const promptY = TOP + 128;
  const typeBegin = T0 + 0.8;
  const stats$ = typing(t, {
    id: "type",
    x: RX + 20 + 2 * CHAR,
    y: promptY,
    text: COMMAND,
    begin: typeBegin,
    perChar: 0.05,
    cursorFrom: T0,
    cursorUntil: typeBegin + COMMAND.length * 0.05 + 0.35,
  });
  const outBegin = stats$.end + 0.35;

  const items = [
    ["commits", "COMMITS"],
    ["pullRequests", "PULL REQUESTS"],
    ["issues", "ISSUES"],
    ["repos", "REPOSITORIES"],
  ];
  const outX = RX + 20;
  const outY = promptY + 46;
  const NUM_CHAR = 28 * HALF;
  const deltaOf = (d) => (d == null ? "" : d > 0 ? `(+${fmt(d)})` : d < 0 ? `(${fmt(d)})` : "(±0)");
  // 前日比の桁が増えても隣の列へ食い込まないよう、列幅を中身の幅から決め、余りを均等に配る。
  const widths = items.map(([key, label]) =>
    Math.max(label.length * (11 * HALF + 2), fmt(stats.counts[key]).length * NUM_CHAR + 6 + deltaOf(delta?.[key]).length * CHAR),
  );
  const gap = (RW - 40 - widths.reduce((a, b) => a + b, 0)) / (items.length - 1);
  const colX = widths.map((_, i) => outX + widths.slice(0, i).reduce((a, b) => a + b + gap, 0));
  const statCells = items
    .map(([key, label], i) => {
      const x = colX[i];
      const value = stats.counts[key];
      const d = delta?.[key];
      const begin = outBegin + i * 0.05;
      const deltaText = deltaOf(d);
      // 前日比はカウントアップを終えてから出す。
      return `<text x="${x}" y="${outY}" class="label" fill="${t.dim}">${label}${hideUntil(begin)}</text>
      ${countUp(value, { x, y: outY + 34, cls: "num", fill: i === 0 ? t.accent : t.text, begin, dur: 1.2 })}
      ${deltaText ? `<text x="${x + fmt(value).length * NUM_CHAR + 6}" y="${outY + 34}" fill="${d > 0 ? t.up : t.dim}">${deltaText}${hideUntil(begin + 1.2)}</text>` : ""}`;
    })
    .join("\n");
  const nextPromptY = outY + 84;
  const doneAt = outBegin + 1.4;

  // 起動後に、端末が行ごとに描き直すように上から TUI を出す。
  const wipeRows = Math.ceil((H - 32) / ROW);
  const wipe = Array.from({ length: wipeRows + 1 }, (_, i) => Math.min(i * ROW, H - 32)).join(";");

  // ステータスバー: powerline 風
  const segL = `${LOGIN} `;
  const segLW = 16 + cells(segL) * CHAR;
  const right = `${ICON.clock} up ${uptime(stats.createdAt, new Date(today))}   ${ICON.nix} ${STACK}   ${ICON.calendar} ${today}`;
  const loginAt = new Date(`${today}T03:00:00Z`).toUTCString().slice(0, 16);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${LOGIN}: ${fmt(stats.counts.commits)} commits, ${fmt(stats.counts.pullRequests)} pull requests, ${fmt(stats.counts.issues)} issues, ${stats.counts.repos} repositories`)}">
  <style>
    /*FONT*/
    text { font-family: HackGenSub, ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; white-space: pre; }
    .label { font-size: 11px; letter-spacing: 2px; }
    .num { font-size: 28px; font-weight: 700; }
    .cursor { animation: blink 1.1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .cursor { animation: none; } }
  </style>
  <defs>
    ${boot.defs}
    ${stats$.defs}
    <clipPath id="wipe"><rect x="0" y="32" width="${W}" height="${H - 32}">
      <animate attributeName="height" begin="${T0.toFixed(2)}s" dur=".4s" calcMode="discrete" values="${wipe}" fill="freeze"/>
    </rect></clipPath>
  </defs>

  <rect width="${W}" height="${H}" rx="10" fill="${t.bg}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="${t.line}"/>
  <circle cx="20" cy="16" r="5" fill="${t.line}"/><circle cx="38" cy="16" r="5" fill="${t.line}"/><circle cx="56" cy="16" r="5" fill="${t.line}"/>
  <text x="${W / 2}" y="20" fill="${t.dim}" text-anchor="middle" style="font-size:12px">${LOGIN}@github: ~</text>

  <g visibility="hidden">
    <set attributeName="visibility" to="visible" begin="0s" dur="${T0.toFixed(2)}s"/>
    <text x="24" y="${TOP}" fill="${t.dim}">Last login: ${loginAt} 03:00 on ttys001</text>
    <text x="24" y="${TOP + 24}" fill="${t.prompt}" font-weight="700">❯</text>
    ${boot.body}
  </g>

  <g clip-path="url(#wipe)">${hideUntil(T0)}
    ${pane(t, { x: LEFT_X, y: TOP, w: LEFT_W, h: reposH, title: "[1] repos" })}
    <text x="${LEFT_X + 14}" y="${TOP + 30}" fill="${t.text}" font-weight="700">~/${LOGIN}</text>
    ${repoRows}
    ${reposFooter}

    ${pane(t, { x: RX, y: langTop, w: RW, h: langH, title: "[2] langs" })}
    ${langRows}

    ${pane(t, { x: RX, y: TOP, w: RW, h: zshH, title: `[0] zsh — ~/${LOGIN}`, active: true })}
    <text x="${RX + 18}" y="${TOP + 70}" style="font-size:52px;letter-spacing:-1px" font-weight="700" fill="${t.text}">salan<tspan fill="${t.accent}">70</tspan></text>
    <text x="${RX + 20}" y="${TOP + 96}" fill="${t.dim}">${esc(TAGLINE)}</text>
    <text x="${RX + 20}" y="${promptY}" fill="${t.prompt}" font-weight="700">❯</text>
    ${stats$.body}
    ${statCells}
    <text x="${RX + 20}" y="${nextPromptY}" fill="${t.prompt}" font-weight="700">❯${hideUntil(doneAt)}</text>
    <g>${hideUntil(doneAt)}<rect class="cursor" x="${RX + 22 + 2 * CHAR}" y="${nextPromptY - 13}" width="8" height="17" fill="${t.cursor}"/></g>

    ${pane(t, { x: RX, y: logTop, w: RW, h: logH, title: "[3] git log" })}
    ${logRows}

    <path d="M0 ${BAR} H${W} V${H - 10} a10 10 0 0 1 -10 10 H10 a10 10 0 0 1 -10 -10 Z" fill="${t.bar}"/>
    <path d="M0 ${BAR} H${segLW} V${H} H10 a10 10 0 0 1 -10 -10 Z" fill="${t.accent}"/>
    <text x="16" y="${BAR + 19}" fill="${t.onAccent}" font-weight="700" style="font-size:12px">${segL}</text>
    <text x="${segLW}" y="${BAR + 20}" fill="${t.accent}" style="font-size:22px">${ICON.sepRight}</text>
    <text x="${segLW + 22}" y="${BAR + 19}" style="font-size:12px"><tspan fill="${t.text}" font-weight="700">0:zsh*</tspan><tspan fill="${t.dim}">  1:repos  2:langs  3:log</tspan></text>
    <text x="${W - 16}" y="${BAR + 19}" fill="${t.dim}" text-anchor="end" style="font-size:12px">${esc(right)}</text>
  </g>
</svg>
`;
}

// SVG の文字だけを含むサブセットを作り、@font-face として埋め込める形にする。
async function fontFaces(svgs) {
  const text = svgs
    .flatMap((svg) => [...svg.matchAll(/>([^<]+)</g)].map((m) => m[1]))
    .join("")
    .replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[e]);
  const chars = [...new Set(`${text}0123456789,`)].join("");
  const dir = await mkdtemp(join(tmpdir(), "font-"));
  await writeFile(join(dir, "chars.txt"), chars);
  const fontDir = process.env.FONT_DIR ?? "fonts";
  const cmd = process.env.PYFTSUBSET ?? "pyftsubset";
  const faces = [];
  for (const [weight, file] of Object.entries(FONT_FILES)) {
    const out = join(dir, `${weight}.woff2`);
    execSync(`${cmd} "${join(fontDir, file)}" --text-file="${join(dir, "chars.txt")}" --flavor=woff2 --layout-features='' --output-file="${out}"`, {
      stdio: "inherit",
    });
    const data = (await readFile(out)).toString("base64");
    faces.push(`@font-face { font-family: HackGenSub; font-weight: ${weight}; src: url(data:font/woff2;base64,${data}) format("woff2"); }`);
  }
  return faces.join("\n    ");
}

const outDir = process.argv[2] ?? "dist";
// 日付は JST で区切る。
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const stats = await fetchStats();
await mkdir(outDir, { recursive: true });
const delta = await withHistory(outDir, today, stats.counts);
const svgs = Object.entries(THEMES).map(([name, theme]) => [name, render(stats, delta, theme, today)]);
const faces = await fontFaces(svgs.map(([, svg]) => svg));
for (const [name, svg] of svgs) {
  await writeFile(join(outDir, `tui-${name}.svg`), svg.replace("/*FONT*/", faces));
}
console.log(JSON.stringify({ ...stats.counts, delta, log: stats.log }));
