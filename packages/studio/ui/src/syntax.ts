// Small, line-by-line syntax coloring for the files a Ludra project holds. It colors, it doesn't parse.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type Lang = "json" | "ts" | "md" | "plain";

export function langOf(path: string): Lang {
  if (/\.(json|gltf)$/i.test(path)) return "json";
  if (/\.(ts|js|mjs|cjs|tsx|jsx)$/i.test(path)) return "ts";
  if (/\.md$/i.test(path)) return "md";
  return "plain";
}

const JSON_TOKENS = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

export function highlightJson(text: string): string {
  return text.split("\n").map(highlightJsonLine).join("\n");
}

function highlightJsonLine(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(JSON_TOKENS)) {
    out += escapeHtml(line.slice(last, m.index));
    if (m[1] !== undefined) {
      if (m[2] !== undefined) out += `<span class="t-key">${escapeHtml(m[1])}</span>${escapeHtml(m[2])}`;
      else out += `<span class="${/^"#[0-9a-f]{3,8}"$/i.test(m[1]) ? "t-color" : "t-str"}">${escapeHtml(m[1])}</span>`;
    } else if (m[3] !== undefined) out += `<span class="t-num">${m[3]}</span>`;
    else if (m[4] !== undefined) out += `<span class="t-lit">${m[4]}</span>`;
    else out += `<span class="t-punc">${m[5]}</span>`;
    last = m.index! + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

const TS_KEYWORDS = new Set(
  "as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while yield".split(" "),
);
const TS_TOKENS = /(\/\/.*$)|(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`?)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(\s*\()?/g;

export function highlightTs(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(TS_TOKENS)) {
    out += escapeHtml(line.slice(last, m.index));
    if (m[1] !== undefined || m[2] !== undefined) out += `<span class="t-com">${escapeHtml(m[0])}</span>`;
    else if (m[3] !== undefined) out += `<span class="t-str">${escapeHtml(m[3])}</span>`;
    else if (m[4] !== undefined) out += `<span class="t-num">${m[4]}</span>`;
    else if (m[5] !== undefined) {
      const word = m[5];
      if (TS_KEYWORDS.has(word)) out += `<span class="t-kw">${word}</span>`;
      else if (m[6] !== undefined) out += `<span class="t-fn">${word}</span>`;
      else if (/^[A-Z]/.test(word)) out += `<span class="t-type">${word}</span>`;
      else out += escapeHtml(word);
      if (m[6] !== undefined) out += escapeHtml(m[6]);
    }
    last = m.index! + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

function highlightMd(line: string): string {
  if (/^#{1,6}\s/.test(line)) return `<span class="t-kw">${escapeHtml(line)}</span>`;
  return escapeHtml(line)
    .replace(/`([^`]+)`/g, '<span class="t-str">`$1`</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<span class="t-key">**$1**</span>')
    .replace(/^(\s*[-*]\s)/, '<span class="t-punc">$1</span>')
    .replace(/(#[0-9a-fA-F]{6})\b/g, '<span class="t-color">$1</span>');
}

export function highlightLine(line: string, lang: Lang): string {
  if (lang === "json") return highlightJsonLine(line);
  if (lang === "ts") return highlightTs(line);
  if (lang === "md") return highlightMd(line);
  return escapeHtml(line);
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** Reads a unified diff into lines with their numbers on both sides. */
export function parseDiff(diff: string): { lines: DiffLine[]; added: number; removed: number } {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  for (const raw of diff.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("\\")) {
      lines.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
      added++;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
      removed++;
    } else {
      lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return { lines, added, removed };
}

export function renderDiff(diff: string, path: string): HTMLElement {
  const lang = langOf(path);
  const { lines } = parseDiff(diff);
  const table = document.createElement("div");
  table.className = "diff code";
  let html = "";
  for (const l of lines) {
    if (l.kind === "meta") continue;
    if (l.kind === "hunk") {
      html += `<div class="dl dl-hunk"><span class="ln"></span><span class="ln"></span><span class="dm"></span><span class="dt">${escapeHtml(l.text)}</span></div>`;
      continue;
    }
    const mark = l.kind === "add" ? "+" : l.kind === "del" ? "−" : "";
    html += `<div class="dl dl-${l.kind}"><span class="ln">${l.oldNo ?? ""}</span><span class="ln">${l.newNo ?? ""}</span><span class="dm">${mark}</span><span class="dt">${highlightLine(l.text, lang) || " "}</span></div>`;
  }
  table.innerHTML = html;
  return table;
}
