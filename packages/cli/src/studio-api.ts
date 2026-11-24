import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { COMPONENTS, type Diagnostic } from "@ludra/core";
import { listBlocks } from "./blocks.ts";
import { isInside, listScenes, readPrefabs, readScene, type Project } from "./project.ts";
import { applyEdits, EditError, textVersion } from "./scene-edit.ts";

/**
 * What `ludra dev --studio` adds for Ludra Studio (docs/studio.md): the project, a stream of the
 * files the agent changes with their diffs, and runs of check, test and review. Since v0.99
 * (docs/editor.md) also the person's own edits: reading a file, editing a scene, undo and redo.
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
/** Edits Studio remembers for undo. */
const HISTORY = 200;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

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

const ENDPOINTS = new Set(["/__ludra/project", "/__ludra/events", "/__ludra/run", "/__ludra/file", "/__ludra/edit", "/__ludra/undo", "/__ludra/redo"]);

/** One of Studio's own writes, for undo and redo: the file's text on each side of it. */
interface Done {
  path: string;
  label: string;
  before: string;
  after: string;
}

type Seen = string | { size: number; mtime: number };

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

  /**
   * Files this server just wrote and what they'll read as, so their change event says
   * `by: "studio"`. Without `now`, any change (a run of `ludra add` that's still going).
   */
  const ours = new Map<string, { label: string; now?: Seen }>();
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const files: FileChange[] = [];
    const studio: { change: FileChange; label: string }[] = [];
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
      const mine = ours.get(path);
      if (mine && (mine.now === undefined || (now !== undefined && same(mine.now, now)))) {
        if (mine.now !== undefined) ours.delete(path);
        studio.push({ change, label: mine.label });
      } else files.push(change);
    }
    pending.clear();
    const at = new Date().toISOString();
    if (studio.length > 0) {
      const label = [...new Set(studio.map((s) => s.label))].join("; ");
      sendAll({ type: "change", version: options.version(), at, files: studio.map((s) => s.change), by: "studio", label });
    }
    if (files.length > 0) sendAll({ type: "change", version: options.version(), at, files, by: "files" });
  };
  const changed = (path: string) => {
    pending.add(path);
    timer ??= setTimeout(flush, BATCH_MS);
  };

  const done: Done[] = [];
  const undone: Done[] = [];
  /** Writes a file for Studio; the next change event says it was Studio. */
  const write = (path: string, text: string, label: string) => {
    writeFileSync(join(project.dir, path), text);
    ours.set(path, { label, now: read(path) });
    changed(path);
  };
  const remember = (entry: Done) => {
    done.push(entry);
    if (done.length > HISTORY) done.shift();
    undone.length = 0;
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
      changed(path);
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
    const next = previous.catch(() => {}).then(() => (command === "add" ? runAdd(args) : runCli([command, project.dir, "--json", ...args], options.cli)));
    queues.set(command, next);
    return next;
  };
  /** `ludra add <block> <dir> --json --at x,y [--id name]`, for the palette: an undoable Studio edit of the entry scene. */
  const runAdd = async (args: string[]) => {
    const path = project.entryLabel;
    const label = `Added ${args[0]}`;
    const before = existsSync(project.entryPath) ? readFileSync(project.entryPath, "utf8") : undefined;
    ours.set(path, { label });
    try {
      const result = await runCli(["add", args[0]!, project.dir, "--json", ...args.slice(1)], options.cli);
      const files = (result.result as { files?: { path: string; status: string }[] } | undefined)?.files ?? [];
      for (const file of files) {
        if (file.status !== "added" && file.status !== "replaced") continue;
        try {
          const now = read(file.path);
          if (now !== undefined) ours.set(file.path, { label, now });
        } catch {
          // Gone again.
        }
      }
      const after = existsSync(project.entryPath) ? readFileSync(project.entryPath, "utf8") : undefined;
      if (result.ok && before !== undefined && after !== undefined && after !== before) remember({ path, label, before, after });
      if (after === undefined) ours.delete(path);
      else ours.set(path, { label, now: after });
      changed(path);
      return result;
    } catch (err) {
      ours.delete(path);
      throw err;
    }
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  /** POST /__ludra/edit: all the edits or none, against the version the person saw, never adding an error. */
  const edit = (res: ServerResponse, body: Record<string, unknown>) => {
    const path = typeof body.path === "string" && listScenes(project).includes(body.path) && existsSync(join(project.dir, body.path)) ? body.path : undefined;
    if (!path) return json(res, 400, { error: `path must be a scene in the project: ${listScenes(project).join(", ")}.` });
    const text = readFileSync(join(project.dir, path), "utf8");
    const version = textVersion(text);
    if (body.version !== version) return json(res, 409, { error: `${path} changed since you loaded it (the agent or an editor wrote it). Load it again.`, version });
    let next: string;
    try {
      next = applyEdits(text, body.edits);
    } catch (err) {
      if (err instanceof EditError) return json(res, 400, { error: err.message });
      throw err;
    }
    const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 200) : describeEdits(body.edits as { op: string }[]);
    // Errors the file already had don't stop an edit; only ones it would add.
    const { diagnostics } = readScene(project, path, next);
    const known = new Set(readScene(project, path, text).diagnostics.filter((d) => d.severity === "error").map(errorKey));
    const added = diagnostics.filter((d) => d.severity === "error" && !known.has(errorKey(d)));
    if (added.length > 0) return json(res, 422, { error: `That edit would break ${path}.`, diagnostics: added.map((d) => ({ ...d, file: path })) });
    if (next !== text) {
      write(path, next, label);
      remember({ path, label, before: text, after: next });
    }
    json(res, 200, { ok: true, version: textVersion(next), diagnostics: diagnostics.filter((d) => d.severity === "warning").map((d) => ({ ...d, file: path })) });
  };

  /** POST /__ludra/undo and /redo: Studio's own edits, refused when the file has moved on since. */
  const travel = (res: ServerResponse, undo: boolean) => {
    const from = undo ? done : undone;
    const entry = from[from.length - 1];
    if (!entry) return json(res, 200, { ok: false });
    const file = join(project.dir, entry.path);
    const now = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (now !== (undo ? entry.after : entry.before)) {
      return json(res, 409, { ok: false, error: `${entry.path} changed since "${entry.label}" (the agent or an editor wrote it), so ${undo ? "undoing" : "redoing"} it would overwrite that work.` });
    }
    from.pop();
    write(entry.path, undo ? entry.before : entry.after, `${undo ? "Undo" : "Redo"} ${entry.label}`);
    (undo ? undone : done).push(entry);
    json(res, 200, { ok: true, path: entry.path, label: entry.label });
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
        json(res, 200, {
          name: project.config.name,
          dir: project.dir,
          entry: project.entryLabel,
          scenes: listScenes(project).filter((s) => existsSync(join(project.dir, s))),
          window: project.config.window,
          prefabs: Object.keys(readPrefabs(project).prefabs).sort(),
          blocks: listBlocks().map(({ name, description, tags }) => ({ name, description, tags })),
          components: COMPONENTS,
        });
      } else if (url.pathname === "/__ludra/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ type: "hello", version: options.version() })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
      } else if (url.pathname === "/__ludra/file") {
        const path = url.searchParams.get("path") ?? "";
        const file = resolve(project.dir, path);
        const readable = TEXT.has(extname(path).toLowerCase()) && isInside(project.dir, file) && !path.split(/[\\/]/).some((part) => IGNORED.has(part)) && existsSync(file) && statSync(file).isFile();
        if (!readable) {
          json(res, 404, { error: `No text file "${path}" in the project.` });
          return true;
        }
        const text = readFileSync(file, "utf8");
        json(res, 200, { path, version: textVersion(text), text });
      } else if (url.pathname !== "/__ludra/run") {
        if (req.method !== "POST") {
          json(res, 405, { error: "POST only" });
          return true;
        }
        readBody(req, (body) => {
          if (body === undefined) return json(res, 400, { error: "The body isn't a JSON object." });
          if (url.pathname === "/__ludra/edit") return edit(res, body);
          travel(res, url.pathname === "/__ludra/undo");
        });
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
          const args = Array.isArray(body.args) ? body.args : [];
          const allowed = RUN_FLAGS[command];
          if (command === "add") {
            const problem = addArgsProblem(args);
            if (problem) return json(res, 400, { error: problem });
          } else if (!allowed) {
            return json(res, 400, { error: `command must be one of ${[...Object.keys(RUN_FLAGS), "add"].join(", ")}` });
          } else {
            const refused = args.filter((a) => typeof a !== "string" || !allowed.has(a));
            if (refused.length > 0) return json(res, 400, { error: `${command} doesn't take ${refused.map((a) => JSON.stringify(a)).join(", ")} from Studio. It takes: ${[...allowed].join(", ") || "nothing"}.` });
          }
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

function same(a: Seen, b: Seen): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.size === b.size && a.mtime === b.mtime;
}

/** An error is "the same" before and after an edit when it says the same thing (paths move when entities do). */
const errorKey = (d: Diagnostic) => `${d.code}|${d.message}`;

function describeEdits(edits: { op: string; entity?: unknown; field?: unknown }[]): string {
  const first = edits[0]!;
  const id = (e: unknown) => (typeof e === "string" ? e : ((e as { id?: string } | undefined)?.id ?? "an entity"));
  const what =
    first.op === "add" ? `Added ${id(first.entity)}` : first.op === "remove" ? `Removed ${id(first.entity)}` : first.op === "set" ? `Changed ${id(first.entity)} ${String(first.field)}` : `Changed ${String(first.field)}`;
  return edits.length > 1 ? `${what} and ${edits.length - 1} more` : what;
}

/** What's wrong with `add` args from Studio, which takes [block, "--at", "x,y"] and optionally "--id", name. */
export function addArgsProblem(args: unknown[]): string | undefined {
  const usage = 'add takes [block, "--at", "x,y"] and optionally "--id", name.';
  if (args.some((a) => typeof a !== "string")) return usage;
  const [block, ...rest] = args as string[];
  const blocks = listBlocks().map((b) => b.name);
  if (!block || !blocks.includes(block)) return `Unknown block ${JSON.stringify(block ?? "")}. Blocks: ${blocks.join(", ")}.`;
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === "--at" && value !== undefined && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(value)) continue;
    if (flag === "--id" && value !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(value)) continue;
    return usage;
  }
  return undefined;
}

/** Reads a JSON object body; undefined when it isn't one. */
function readBody(req: IncomingMessage, then: (body: Record<string, unknown> | undefined) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  });
  req.on("end", () => {
    if (size > MAX_BODY_BYTES) return then(undefined);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return then(undefined);
    }
    then(body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined);
  });
}

/** `ludra ...argv` (e.g. `check <dir> --json`), as a separate process, with what it printed parsed. */
function runCli(argv: string[], cli?: { node: string; args: string[] }): Promise<{ ok: boolean; exitCode: number; result: unknown }> {
  // The same Node and entry point this server runs from, with its flags (the dev condition, in a checkout).
  const node = cli?.node ?? process.execPath;
  const prefix = cli?.args ?? [...process.execArgv.filter((a) => !a.startsWith("--inspect")), process.argv[1]!];
  return new Promise((resolve, reject) => {
    const child = spawn(node, [...prefix, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
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

