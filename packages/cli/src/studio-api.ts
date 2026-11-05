import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { listScenes, type Project } from "./project.ts";

/**
 * What `ludra dev --studio` adds for Ludra Studio (docs/studio.md): the project, a stream of the
 * files the agent changes with their diffs, and runs of check, test and review.
 */

export type FileKind = "scene" | "prefab" | "script" | "asset" | "config" | "test" | "design" | "other";

export interface FileChange {
  path: string;
  kind: FileKind;
  change: "added" | "changed" | "removed";
  diff?: string;
}

export interface StudioApi {
  /** Answers a studio request. False when the request isn't one. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  close(): void;
}

/** Folders whose files are the tools' output, not the game. */
const IGNORED = new Set(["node_modules", ".git", "build", "screenshots", "recordings", ".claude", "dist"]);
const TEXT = new Set([".json", ".ts", ".js", ".mjs", ".md", ".svg", ".glsl", ".frag", ".vert", ".txt", ".css", ".html", ".gltf"]);
const ASSET = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".wav", ".mp3", ".ogg", ".woff2", ".woff", ".ttf", ".otf", ".frag", ".glsl", ".glb", ".gltf", ".bin"]);
const DIFF_MAX_BYTES = 1024 * 1024;
const DIFF_MAX_LINES = 400;
const BATCH_MS = 100;

/** The flags a run may pass on, per command: enough for the UI, nothing that writes files elsewhere. */
const RUN_FLAGS: Record<string, ReadonlySet<string>> = {
  check: new Set([]),
  test: new Set([]),
  review: new Set(["--fast", "--strict"]),
};

export function classify(project: Project, path: string): FileKind {
  if (path === "ludra.json") return "config";
  if (path === "game.md") return "design";
  if (path.startsWith("tests/")) return "test";
  if (path.endsWith(".scene.json") || path === project.entryLabel) return "scene";
  if (path.startsWith("prefabs/")) return "prefab";
  if (path.startsWith("scripts/") && /\.(ts|js)$/.test(path)) return "script";
  if (ASSET.has(extname(path).toLowerCase())) return "asset";
  return "other";
}

/** What Studio is allowed to reach: only pages on this machine, by name, so a rebinding DNS name can't. */
export function isLocalHost(req: IncomingMessage): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? "");
}

const ENDPOINTS = new Set(["/__ludra/project", "/__ludra/events", "/__ludra/run"]);

/**
 * `token` (default: LUDRA_STUDIO_TOKEN): when set, every studio request must carry it as `?token=`.
 * Answering any origin lets any web page open in a browser reach these endpoints; the token is what
 * only Studio knows. EventSource can't send headers, so it goes in the query.
 */
export function createStudioApi(project: Project, options: { version: () => string; token?: string; cli?: { node: string; args: string[] } }): StudioApi {
  const token = options.token ?? process.env.LUDRA_STUDIO_TOKEN ?? "";
  /** What each file was when last seen: its text when small enough to diff, else its size and time. */
  const known = new Map<string, string | { size: number; mtime: number }>();
  const read = (path: string) => {
    const file = join(project.dir, path);
    const stat = statSync(file);
    if (!stat.isFile()) return undefined;
    if (TEXT.has(extname(path).toLowerCase()) && stat.size <= DIFF_MAX_BYTES) return readFileSync(file, "utf8");
    return { size: stat.size, mtime: stat.mtimeMs };
  };
  const walk = (dir: string) => {
    for (const name of readdirSync(join(project.dir, dir))) {
      if (IGNORED.has(name)) continue;
      const path = dir ? `${dir}/${name}` : name;
      try {
        if (statSync(join(project.dir, path)).isDirectory()) walk(path);
        else known.set(path, read(path)!);
      } catch {
        // Gone while looking.
      }
    }
  };
  walk("");

  const clients = new Set<ServerResponse>();
  const sendAll = (message: object) => {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of clients) client.write(line);
  };

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const files: FileChange[] = [];
    for (const path of [...pending].sort()) {
      const before = known.get(path);
      let now: string | { size: number; mtime: number } | undefined;
      try {
        now = existsSync(join(project.dir, path)) ? read(path) : undefined;
      } catch {
        now = undefined;
      }
      if (now === undefined && before === undefined) continue;
      if (now !== undefined && before !== undefined && same(before, now)) continue;
      if (now === undefined) known.delete(path);
      else known.set(path, now);
      const change: FileChange = { path, kind: classify(project, path), change: now === undefined ? "removed" : before === undefined ? "added" : "changed" };
      const diff = typeof now === "string" || typeof before === "string" ? unifiedDiff(path, typeof before === "string" ? before : "", typeof now === "string" ? now : "") : undefined;
      if (diff) change.diff = diff;
      files.push(change);
    }
    pending.clear();
    if (files.length > 0) sendAll({ type: "change", version: options.version(), at: new Date().toISOString(), files });
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(project.dir, { recursive: true }, (_event, name) => {
      if (!name) return;
      const path = name.toString().split(sep).join("/");
      if (path.split("/").some((part) => IGNORED.has(part))) return;
      try {
        if (existsSync(join(project.dir, path)) && statSync(join(project.dir, path)).isDirectory()) return;
      } catch {
        return;
      }
      pending.add(path);
      timer ??= setTimeout(flush, BATCH_MS);
    });
  } catch (err) {
    console.error(`Studio can't watch ${project.dir} for changes: ${(err as Error).message}`);
  }
  const keepAlive = setInterval(() => {
    for (const client of clients) client.write(": keep-alive\n\n");
  }, 15_000);

  const queues = new Map<string, Promise<unknown>>();
  const run = (command: string, args: string[]) => {
    const previous = queues.get(command) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => runCli(project, command, args, options.cli));
    queues.set(command, next);
    return next;
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return {
    handle(req, res, url) {
      if (!ENDPOINTS.has(url.pathname)) return false;
      res.setHeader("access-control-allow-origin", "*");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
        res.end();
        return true;
      }
      if (!isLocalHost(req)) {
        json(res, 403, { error: "Studio only answers pages on this machine." });
        return true;
      }
      if (token && url.searchParams.get("token") !== token) {
        json(res, 401, { error: "This Studio server needs its token: ?token=..." });
        return true;
      }
      if (url.pathname === "/__ludra/project") {
        json(res, 200, { name: project.config.name, dir: project.dir, entry: project.entryLabel, scenes: listScenes(project).filter((s) => existsSync(join(project.dir, s))), window: project.config.window });
      } else if (url.pathname === "/__ludra/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ type: "hello", version: options.version() })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
      } else {
        if (req.method !== "POST") {
          json(res, 405, { error: "POST only" });
          return true;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          let body: { command?: unknown; args?: unknown };
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "The body isn't JSON." });
          }
          const command = typeof body.command === "string" ? body.command : "";
          const allowed = RUN_FLAGS[command];
          if (!allowed) return json(res, 400, { error: `command must be one of ${Object.keys(RUN_FLAGS).join(", ")}` });
          const args = Array.isArray(body.args) ? body.args : [];
          const refused = args.filter((a) => typeof a !== "string" || !allowed.has(a));
          if (refused.length > 0) return json(res, 400, { error: `${command} doesn't take ${refused.map((a) => JSON.stringify(a)).join(", ")} from Studio. It takes: ${[...allowed].join(", ") || "nothing"}.` });
          run(command, args as string[]).then(
            (result) => json(res, 200, result),
            (err: Error) => json(res, 500, { error: err.message }),
          );
        });
      }
      return true;
    },
    close() {
      watcher?.close();
      clearInterval(keepAlive);
      if (timer) clearTimeout(timer);
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}

function same(a: string | { size: number; mtime: number }, b: string | { size: number; mtime: number }): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.size === b.size && a.mtime === b.mtime;
}

/** `ludra <command> <dir> --json ...args`, as a separate process, with what it printed parsed. */
function runCli(project: Project, command: string, args: string[], cli?: { node: string; args: string[] }): Promise<{ ok: boolean; exitCode: number; result: unknown }> {
  // The same Node and entry point this server runs from, with its flags (the dev condition, in a checkout).
  const node = cli?.node ?? process.execPath;
  const prefix = cli?.args ?? [...process.execArgv.filter((a) => !a.startsWith("--inspect")), process.argv[1]!];
  return new Promise((resolve, reject) => {
    const child = spawn(node, [...prefix, command, project.dir, "--json", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const text = Buffer.concat(out).toString("utf8");
      let result: unknown;
      try {
        result = JSON.parse(text);
      } catch {
        result = { error: (Buffer.concat(err).toString("utf8") || text).trim() };
      }
      resolve({ ok: code === 0, exitCode: code ?? 1, result });
    });
  });
}

/**
 * A unified diff of two texts, three lines of context, cut at 400 lines. Myers' algorithm, so a
 * small edit to a big scene stays cheap.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const ops = diffLines(a, b);
  const hunks: string[] = [];
  const context = 3;
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op === " ") {
      i++;
      continue;
    }
    // A hunk: from 3 lines before this change to 3 after the last change near it.
    let start = i;
    for (let k = 0; k < context && start > 0 && ops[start - 1]!.op === " "; k++) start--;
    let end = i;
    for (;;) {
      while (end < ops.length && ops[end]!.op !== " ") end++;
      let gap = 0;
      while (end + gap < ops.length && ops[end + gap]!.op === " ") gap++;
      if (end + gap < ops.length && gap <= context * 2) end += gap;
      else {
        end = Math.min(ops.length, end + Math.min(gap, context));
        break;
      }
    }
    const slice = ops.slice(start, end);
    const aStart = slice[0]!.a + 1;
    const bStart = slice[0]!.b + 1;
    const aCount = slice.filter((o) => o.op !== "+").length;
    const bCount = slice.filter((o) => o.op !== "-").length;
    hunks.push(`@@ -${aCount === 0 ? aStart - 1 : aStart},${aCount} +${bCount === 0 ? bStart - 1 : bStart},${bCount} @@`);
    for (const o of slice) hunks.push(`${o.op}${o.text}`);
    i = end;
  }
  const lines = [`--- a/${path}`, `+++ b/${path}`, ...hunks];
  if (lines.length > DIFF_MAX_LINES) return [...lines.slice(0, DIFF_MAX_LINES), `… ${lines.length - DIFF_MAX_LINES} more lines`].join("\n");
  return lines.join("\n");
}

interface Op {
  op: " " | "-" | "+";
  text: string;
  /** Line indexes before this line, in a and b. */
  a: number;
  b: number;
}

/** Edits past which a diff is the whole file out and in. */
const MAX_EDITS = 2000;

function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    // Each step keeps a copy of the frontier: past this many edits a file was rewritten, so say so plainly.
    if (d > MAX_EDITS) return [...a.map((text, i) => ({ op: "-" as const, text, a: i, b: 0 })), ...b.map((text, i) => ({ op: "+" as const, text, a: n, b: i }))];
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1)! : v.get(k - 1)! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk back through the trace to recover the edit script.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: " ", text: a[x]!, a: x, b: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        ops.push({ op: "+", text: b[y]!, a: x, b: y });
      } else {
        x--;
        ops.push({ op: "-", text: a[x]!, a: x, b: y });
      }
    }
  }
  return ops.reverse();
}

