import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../src/headless.ts";
import { loadProject } from "../src/project.ts";
import { classify, unifiedDiff } from "../src/studio-api.ts";
import { oneLiveBrowser } from "./live-browser.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const browser = findBrowser();
const live = !browser ? "needs Chrome, Edge or Chromium" : process.env.CI && process.platform !== "linux" ? "real browser play runs on Linux CI only" : false;

const ground = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 }, sprite: { color: "#335" } } };
const player = { id: "player", components: { transform: { x: 100, y: 482 }, body: { type: "dynamic", width: 28, height: 36 }, platformer: {}, sprite: { color: "#f80" } } };
const sceneJson = (groundColor: string) => `${JSON.stringify({ entities: [{ ...ground, components: { ...ground.components, sprite: { color: groundColor } } }, player] }, null, 2)}\n`;

function game(): string {
  const dir = mkdtempSync(join(tmpdir(), "ludra-studio-"));
  writeFileSync(join(dir, "ludra.json"), JSON.stringify({ name: "Studio Test", entry: "scenes/main.scene.json" }));
  mkdirSync(join(dir, "scenes"));
  writeFileSync(join(dir, "scenes", "main.scene.json"), sceneJson("#335"));
  return dir;
}

/** `ludra dev` on a free port, once it says it's listening. */
async function serve(dir: string, ...flags: string[]): Promise<{ port: number; child: ChildProcess }> {
  return serveWith({}, dir, ...flags);
}

async function serveWith(env: Record<string, string>, dir: string, ...flags: string[]): Promise<{ port: number; child: ChildProcess }> {
  const port = 5900 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "dev", dir, "--port", String(port), "--no-record", ...flags], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LUDRA_STUDIO_TOKEN: "", ...env } });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`ludra dev exited with ${code}`)));
  });
  return { port, child };
}

function fetchJson(port: number, path: string, init: { method?: string; body?: string; host?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { ...(init.host ? { host: init.host } : {}), ...(init.body ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

/** The messages an event stream sends, as they come. */
function events(port: number) {
  const messages: any[] = [];
  let buffer = "";
  const waiting: (() => void)[] = [];
  const req = get({ host: "127.0.0.1", port, path: "/__ludra/events" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const line of block.split("\n")) if (line.startsWith("data: ")) messages.push(JSON.parse(line.slice(6)));
        waiting.splice(0).forEach((w) => w());
      }
    });
  });
  return {
    messages,
    async next(test: (m: any) => boolean, ms = 10_000) {
      const end = Date.now() + ms;
      for (;;) {
        const found = messages.find(test);
        if (found) {
          messages.splice(messages.indexOf(found), 1);
          return found;
        }
        if (Date.now() > end) throw new Error(`No such message. Got: ${JSON.stringify(messages)}`);
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          setTimeout(resolve, 200);
        });
      }
    },
    close: () => req.destroy(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Applies a unified diff to `before`, the way patch would. */
function patch(before: string, diff: string): string {
  const lines = before === "" ? [] : before.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const line of diff.split("\n").slice(2)) {
    const hunk = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(line);
    if (hunk) {
      const start = Number(hunk[2]) === 0 ? Number(hunk[1]) : Number(hunk[1]) - 1;
      while (at < start) out.push(lines[at++]!);
    } else if (line.startsWith(" ")) {
      out.push(line.slice(1));
      at++;
    } else if (line.startsWith("-")) at++;
    else if (line.startsWith("+")) out.push(line.slice(1));
  }
  while (at < lines.length) out.push(lines[at++]!);
  return out.join("\n");
}

describe("studio: diffs and kinds", () => {
  it("writes a unified diff that patch turns back into the new text", () => {
    const a = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const lines = a.split("\n");
    lines[3] = "changed 3";
    lines.splice(30, 2);
    lines.splice(50, 0, "new a", "new b");
    const b = lines.join("\n");
    const diff = unifiedDiff("scenes/main.scene.json", a, b);
    assert.match(diff, /^--- a\/scenes\/main\.scene\.json\n\+\+\+ b\/scenes\/main\.scene\.json\n@@ /);
    assert.equal(patch(a, diff), b);
    assert.equal((diff.match(/^@@/gm) ?? []).length, 3, "three hunks, with context between them");
    assert.equal(patch("", unifiedDiff("x", "", "one\ntwo")), "one\ntwo");
    assert.equal(patch("one\ntwo", unifiedDiff("x", "one\ntwo", "")), "");
    assert.equal(unifiedDiff("x", "same", "same"), "");
  });

  it("cuts a diff at 400 lines", () => {
    const big = Array.from({ length: 1000 }, (_, i) => `${i}`).join("\n");
    const diff = unifiedDiff("big.txt", "", big).split("\n");
    assert.equal(diff.length, 401);
    assert.match(diff.at(-1)!, /^… \d+ more lines$/);
  });

  it("knows a file's kind from where it is", () => {
    const dir = game();
    const project = loadProject(dir);
    assert.equal(classify(project, "scenes/main.scene.json"), "scene");
    assert.equal(classify(project, "prefabs/coin.json"), "prefab");
    assert.equal(classify(project, "scripts/boss.ts"), "script");
    assert.equal(classify(project, "art/hero.png"), "asset");
    assert.equal(classify(project, "ludra.json"), "config");
    assert.equal(classify(project, "game.md"), "design");
    assert.equal(classify(project, "tests/gameplay.test.json"), "test");
    assert.equal(classify(project, "notes.txt"), "other");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ludra dev --studio", () => {
  let dir: string;
  let server: { port: number; child: ChildProcess };
  before(async () => {
    dir = game();
    server = await serve(dir, "--studio");
  });
  after(() => {
    server.child.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("describes the project, to any page, but only by a local name", async () => {
    const { status, headers, body } = await fetchJson(server.port, "/__ludra/project");
    assert.equal(status, 200);
    assert.equal(headers["access-control-allow-origin"], "*");
    assert.deepEqual(body, { name: "Studio Test", dir, entry: "scenes/main.scene.json", scenes: ["scenes/main.scene.json"], window: body.window });
    assert.equal(typeof body.window.width, "number");
    const preflight = await fetchJson(server.port, "/__ludra/run", { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.match(String(preflight.headers["access-control-allow-headers"]), /content-type/);
    // A web page that points its own name at this machine reaches the server by that name: refused.
    assert.equal((await fetchJson(server.port, "/__ludra/project", { host: "evil.example:80" })).status, 403);
    // The game and its files answer only this server's own pages: no other origin may read them.
    const scene = await fetchJson(server.port, "/__ludra/scene");
    assert.equal(scene.status, 200);
    assert.equal(scene.headers["access-control-allow-origin"], undefined);
  });

  it("streams the files that change, batched, with their diffs", async () => {
    const stream = events(server.port);
    try {
      const hello = await stream.next((m) => m.type === "hello");
      assert.equal(typeof hello.version, "string");

      writeFileSync(join(dir, "scenes", "main.scene.json"), sceneJson("#7a4"));
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "scripts", "spin.ts"), "export default {};\n");
      const change = await stream.next((m) => m.type === "change" && m.files.some((f: any) => f.path === "scripts/spin.ts"));
      const files = Object.fromEntries(change.files.map((f: any) => [f.path, f]));
      assert.equal(typeof change.version, "string");
      assert.ok(!Number.isNaN(Date.parse(change.at)));
      // Both in one message, if the watcher saw the scene by then; the scene's change either way.
      const scene = files["scenes/main.scene.json"] ?? (await stream.next((m) => m.type === "change" && m.files.some((f: any) => f.path === "scenes/main.scene.json"))).files[0];
      assert.equal(scene.kind, "scene");
      assert.equal(scene.change, "changed");
      assert.match(scene.diff, /^-.*#335/m);
      assert.match(scene.diff, /^\+.*#7a4/m);
      assert.equal(files["scripts/spin.ts"].kind, "script");
      assert.equal(files["scripts/spin.ts"].change, "added");
      assert.match(files["scripts/spin.ts"].diff, /^\+export default \{\};$/m);

      unlinkSync(join(dir, "scripts", "spin.ts"));
      const gone = await stream.next((m) => m.type === "change" && m.files.some((f: any) => f.path === "scripts/spin.ts"));
      assert.equal(gone.files.find((f: any) => f.path === "scripts/spin.ts").change, "removed");
    } finally {
      stream.close();
    }
  });

  it("runs check, test and review, and answers what the command prints with --json", async () => {
    const run = await fetchJson(server.port, "/__ludra/run", { method: "POST", body: JSON.stringify({ command: "check" }) });
    assert.equal(run.status, 200);
    const cli = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "check", dir, "--json"], { encoding: "utf8" });
    assert.deepEqual(run.body, { ok: cli.status === 0, exitCode: cli.status, result: JSON.parse(cli.stdout) });

    // Two at once: the second waits for the first, and both answer.
    const [one, two] = await Promise.all([1, 2].map(() => fetchJson(server.port, "/__ludra/run", { method: "POST", body: JSON.stringify({ command: "review", args: ["--fast"] }) })));
    assert.equal(one!.status, 200);
    assert.deepEqual(one!.body.result.findings, two!.body.result.findings);

    assert.equal((await fetchJson(server.port, "/__ludra/run", { method: "POST", body: JSON.stringify({ command: "build" }) })).status, 400);
    const flag = await fetchJson(server.port, "/__ludra/run", { method: "POST", body: JSON.stringify({ command: "review", args: ["--out", "/tmp"] }) });
    assert.equal(flag.status, 400);
    assert.match(flag.body.error, /doesn't take "--out"/);
    assert.equal((await fetchJson(server.port, "/__ludra/run")).status, 405);
  });
});

describe("ludra dev --studio with a token", () => {
  it("answers only requests that carry it", async () => {
    const dir = game();
    const server = await serveWith({ LUDRA_STUDIO_TOKEN: "s3cret" }, dir, "--studio");
    try {
      assert.equal((await fetchJson(server.port, "/__ludra/project")).status, 401);
      assert.equal((await fetchJson(server.port, "/__ludra/project?token=wrong")).status, 401);
      const ok = await fetchJson(server.port, "/__ludra/project?token=s3cret");
      assert.equal(ok.status, 200);
      assert.equal(ok.body.name, "Studio Test");
      assert.equal((await fetchJson(server.port, "/__ludra/run?token=s3cret", { method: "POST", body: JSON.stringify({ command: "check" }) })).status, 200);
      const page = await fetchJson(server.port, "/?studio=1&token=s3cret");
      assert.ok(String(page.body).includes(`get("token")`) && String(page.body).includes(`"?token=" + encodeURIComponent(token)`), "the game page passes the token on to the change stream");
    } finally {
      server.child.kill();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

describe("plain ludra dev", () => {
  it("has none of it", async () => {
    const dir = game();
    const server = await serve(dir);
    try {
      const project = await fetchJson(server.port, "/__ludra/project");
      assert.equal(project.status, 404);
      assert.equal(project.headers["access-control-allow-origin"], undefined);
      const page = await fetchJson(server.port, "/");
      assert.match(String(page.body), /const studio = false/);
    } finally {
      server.child.kill();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

describe("a studio page in a real browser", { skip: live }, () => {
  it("pauses, inspects, keeps the moment through an edit, rejects a broken one and steps", { timeout: 240_000 }, () =>
    oneLiveBrowser(async () => {
      const dir = game();
      const server = await serve(dir, "--studio");
      // The page posts to window.parent, which is itself when opened on its own: collect what it says.
      const page = await open(`http://127.0.0.1:${server.port}/?studio=1`, `window.studioSaid = []; addEventListener("message", (e) => { if (e.data && e.data.ludra === 1 && e.source === window && !e.data.fromTest) window.studioSaid.push(e.data); });`);
      const said = async () => (await page.evaluate("window.studioSaid")) as any[];
      const until = async (what: string, test: (messages: any[]) => any, ms = 60_000) => {
        const end = Date.now() + ms;
        for (;;) {
          const found = test(await said());
          if (found) return found;
          if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Said: ${JSON.stringify((await said()).slice(-8))}`);
          await sleep(100);
        }
      };
      const tell = (type: string, fields: Record<string, unknown> = {}) => page.evaluate(`window.postMessage(${JSON.stringify({ ludra: 1, fromTest: true, type, ...fields })}, "*")`);
      const last = (messages: any[], type: string) => messages.filter((m) => m.type === type).at(-1);
      try {
        const ready = await until("ready", (m) => last(m, "ready"));
        assert.equal(ready.scene, "scenes/main.scene.json");
        assert.equal(ready.dimensions, 2);
        assert.deepEqual(last(await said(), "entities").list.map((e: any) => e.id), ["ground", "player"]);
        assert.equal(await page.evaluate(`!!document.getElementById("marks")`), false, "no recording hint");

        // Play a little, then stop the clock.
        await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", key: "ArrowRight" }))`);
        await until("some frames", (m) => (last(m, "status")?.frame ?? 0) > 40);
        await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowRight", key: "ArrowRight" }))`);
        await tell("pause");
        const paused = await until("paused", (m) => (last(m, "status")?.paused ? last(m, "status") : undefined));
        await sleep(400);
        const frame = last(await said(), "status").frame;
        assert.ok(frame >= paused.frame);
        await tell("inspect", { id: "player" });
        const before = await until("the player", (m) => last(m, "entity")?.data);
        assert.ok(before.components.transform.x > 100, "it ran right");

        // The agent recolours the ground: the game stays at the same frame, the player where it was.
        writeFileSync(join(dir, "scenes", "main.scene.json"), sceneJson("#7a4"));
        const kept = await until("a hot reload", (m) => last(m, "hot"));
        assert.equal(kept.result, "kept", JSON.stringify(kept));
        assert.equal(kept.frame, frame);
        assert.deepEqual(kept.files, ["scenes/main.scene.json"]);
        await tell("inspect", { id: "player" });
        await sleep(300);
        const afterEdit = last(await said(), "entity").data;
        assert.equal(afterEdit.components.transform.x, before.components.transform.x);
        assert.equal(afterEdit.components.transform.y, before.components.transform.y);
        assert.equal(last(await said(), "status").paused, true, "still paused");

        // A broken scene: the old version plays on, and Studio hears why.
        writeFileSync(join(dir, "scenes", "main.scene.json"), JSON.stringify({ entities: [{ id: "x", components: { body: { type: "wobbly" } } }] }));
        const rejected = await until("a rejection", (m) => m.filter((x) => x.type === "hot").find((x) => x.result === "rejected"));
        assert.equal(rejected.frame, frame);
        const error = last(await said(), "error");
        assert.ok(Array.isArray(error.diagnostics) && error.diagnostics.length > 0, JSON.stringify(error));
        assert.equal(last(await said(), "status").frame, frame);

        await tell("step", { frames: 5 });
        await until("five frames on", (m) => last(m, "status")?.frame === frame + 5);
        assert.deepEqual(page.problems.filter((p) => !/doesn't pass check|E_/.test(p)), []);
      } finally {
        await page.close();
        server.child.kill();
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }));
});

/** A page in headless Chrome, with every error it logs. `beforeLoad` runs before the page's own scripts. */
async function open(url: string, beforeLoad: string) {
  const profile = mkdtempSync(join(tmpdir(), "ludra-studio-browser-"));
  const chrome = spawn(browser!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--mute-audio", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  chrome.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const started = Date.now();
  while (!/ws:\/\/\S+/.test(log)) {
    if (Date.now() - started > 60_000) throw new Error("Chrome didn't start.");
    await sleep(50);
  }
  const socket = new WebSocket(/ws:\/\/\S+/.exec(log)![0]);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let next = 0;
  const waiting = new Map<number, (value: unknown) => void>();
  const problems: string[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; method?: string; params?: Record<string, any> };
    if (message.id !== undefined) waiting.get(message.id)?.(message.result);
    if (message.method === "Runtime.exceptionThrown") problems.push(String(message.params!.exceptionDetails.exception?.description ?? message.params!.exceptionDetails.text));
    if (message.method === "Runtime.consoleAPICalled" && message.params!.type === "error") problems.push(message.params!.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" "));
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: beforeLoad }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  return {
    problems,
    evaluate: async (expression: string) => ((await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)) as { result?: { value?: unknown } }).result?.value,
    close: async () => {
      await send("Browser.close");
      socket.close();
      await new Promise<void>((resolve) => {
        if (chrome.exitCode !== null) return resolve();
        const timer = setTimeout(() => (chrome.kill(), resolve()), 3000);
        chrome.once("exit", () => (clearTimeout(timer), resolve()));
      });
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Windows can hold the folder a while longer.
      }
    },
  };
}

describe("studio: a rewritten file", () => {
  it("diffs quickly however much changed, and stays cut at 400 lines", () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `old ${i}`).join("\n");
    const b = Array.from({ length: 20_000 }, (_, i) => `new ${i}`).join("\n");
    const started = Date.now();
    const diff = unifiedDiff("big.json", a, b);
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    assert.equal(diff.split("\n").length, 401, "cut at 400 lines");
  });
});
