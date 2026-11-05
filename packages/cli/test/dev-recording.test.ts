import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Recording } from "@ludra/core";
import { findBrowser } from "../src/headless.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const browser = findBrowser();

/** Just enough DevTools protocol to press keys in a page. */
class Page {
  private readonly waiting = new Map<number, (value: unknown) => void>();
  private readonly socket: WebSocket;
  private readonly session: string;

  private constructor(socket: WebSocket, session: string) {
    this.socket = socket;
    this.session = session;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      if (message.id !== undefined) this.waiting.get(message.id)?.(message.result);
    });
  }

  static async open(devtools: string, url: string): Promise<Page> {
    const socket = new WebSocket(devtools);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    const page = new Page(socket, "");
    const { targetId } = (await page.send("Target.createTarget", { url: "about:blank" }, "")) as { targetId: string };
    const { sessionId } = (await page.send("Target.attachToTarget", { targetId, flatten: true }, "")) as { sessionId: string };
    const attached = new Page(socket, sessionId);
    await attached.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await attached.send("Page.navigate", { url });
    return attached;
  }

  send(method: string, params: Record<string, unknown> = {}, session = this.session): Promise<unknown> {
    const id = (Page.next += 1);
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      // Each wrapper hears every message on the socket, so ids are shared between them.
      this.socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
  }

  private static next = 0;

  async evaluate(expression: string): Promise<unknown> {
    const answer = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result?: { value?: unknown } };
    return answer.result?.value;
  }

  private key(type: string, code: string, key: string, text?: string) {
    const windowsVirtualKeyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : { ArrowRight: 39, ArrowLeft: 37 }[key] ?? 0;
    return this.send("Input.dispatchKeyEvent", { type, code, key, windowsVirtualKeyCode, ...(text ? { text } : {}) });
  }

  down(code: string, key: string) {
    return this.key("keyDown", code, key);
  }

  up(code: string, key: string) {
    return this.key("keyUp", code, key);
  }

  async tap(code: string, key: string) {
    await this.down(code, key);
    await sleep(40);
    await this.up(code, key);
  }

  close() {
    this.socket.close();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(50);
  }
}

/** A person plays the game in a real browser, on `ludra dev`; the callback is the person. */
async function session(game: string, port: number, takes: number, play: (page: Page, onDisk: () => Recording | undefined) => Promise<void>): Promise<{ dir: string; file: string; recording: Recording }> {
  const dir = mkdtempSync(join(tmpdir(), "ludra-dev-"));
  cpSync(game, dir, { recursive: true, filter: (path) => !/node_modules|screenshots|recordings/.test(path) });
  const server: ChildProcess = spawn(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "dev", dir, "--port", String(port)], { stdio: "pipe" });
  const profile = mkdtempSync(join(tmpdir(), "ludra-dev-browser-"));
  const chrome = spawn(browser!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--mute-audio", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let closing: Page | undefined;
  try {
    await new Promise<void>((resolve) => server.stdout!.once("data", () => resolve()));
    let log = "";
    chrome.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
    await until("the browser", () => /ws:\/\/\S+/.test(log));
    const page = await Page.open(/ws:\/\/\S+/.exec(log)![0], `http://127.0.0.1:${port}/`);
    await until("the game", async () => (await page.evaluate(`document.readyState === "complete" && !!document.querySelector("canvas")`)) === true);
    const folder = join(dir, "recordings");
    // Every take is on disk within seconds. Its ending may not be: a closing page's last request
    // isn't sure to arrive, and readRecording counts a take without one as stopped.
    const found = () => (existsSync(folder) ? readdirSync(folder).find((name) => name.endsWith(".rec.json")) : undefined);
    const read = () => JSON.parse(readFileSync(join(folder, found()!), "utf8")) as Recording;
    const onDisk = () => {
      try {
        return found() ? read() : undefined;
      } catch {
        return undefined; // caught halfway through a write
      }
    };
    await sleep(1500);
    await play(page, onDisk);
    await page.send("Page.navigate", { url: "about:blank" });
    closing = page;
    try {
      await until(`${takes} finished takes on disk`, () => found() !== undefined && read().takes.filter(Boolean).length >= takes);
    } catch (err) {
      const seen = found() ? read().takes.map((take) => take && [take.end ?? "open", take.frames, take.marks.length]) : "no file";
      throw new Error(`${(err as Error).message} On disk: ${JSON.stringify(seen)}`);
    }
    return { dir, file: join(folder, found()!), recording: read() };
  } finally {
    // Closing, not killing: Chrome's helper processes go with it and let go of the profile.
    await closing?.send("Browser.close", {}, "");
    closing?.close();
    await new Promise<void>((resolve) => {
      if (chrome.exitCode !== null) return resolve();
      const timer = setTimeout(() => (chrome.kill(), resolve()), 3000);
      chrome.once("exit", () => (clearTimeout(timer), resolve()));
    });
    server.kill();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows can hold the folder a while longer. The temp folder gets cleaned up in time.
    }
  }
}

const replay = (file: string) => {
  const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, "replay", file, "--json"], { encoding: "utf8", maxBuffer: 1 << 26 });
  return { code: result.status, report: JSON.parse(result.stdout) as { ok: boolean; takes: { replay: { status: string; leftBetween?: number[] } }[] } };
};

describe("a person playing in a real browser", { skip: browser ? false : "needs Chrome, Edge or Chromium" }, () => {
  it("is recorded in Chrome and played again in Node, frame for frame, keys, marks and restart included", { timeout: 90_000 }, async () => {
    const { dir, recording, file } = await session(join(ROOT, "packages/cli/templates/platformer"), 5801, 2, async (page) => {
      await page.evaluate(`window.prompt = () => "the jump felt floaty"`);
      await page.down("ArrowRight", "ArrowRight");
      await sleep(700);
      await page.tap("Space", " ");
      await sleep(500);
      await page.tap("Digit1", "1");
      await page.tap("KeyN", "n");
      await sleep(300);
      await page.up("ArrowRight", "ArrowRight");
      await page.tap("KeyR", "r");
      await sleep(300);
      await page.down("ArrowLeft", "ArrowLeft");
      await sleep(400);
      await page.up("ArrowLeft", "ArrowLeft");
      await page.tap("Digit4", "4");
      await sleep(200);
    });
    assert.equal(recording.takes.length, 2, JSON.stringify(recording.takes.map((t) => [t.end, t.frames])));
    const [first, second] = recording.takes;
    const told = (take: Recording["takes"][number]) => JSON.stringify({ end: take?.end, frames: take?.frames, deaths: take?.deaths, inputs: take?.inputs.slice(0, 300) });
    assert.equal(first!.end, "restarted", `first take: ${told(first)}`);
    assert.ok(second!.end === undefined || second!.end === "stopped", `second take ended ${second!.end}`);
    assert.deepEqual(first!.marks.map((m) => m.kind), ["hard", "note"]);
    assert.equal(first!.marks[1]!.text, "the jump felt floaty");
    assert.deepEqual(second!.marks.map((m) => m.kind), ["great"]);
    assert.match(first!.inputs, /jump/);
    // Frames, not seconds: a CI machine drawing in software may run at 10 fps. The replay below is the real check.
    assert.ok(first!.frames >= first!.marks.at(-1)!.frame, `first take has ${first!.frames} frames`);

    const { code, report } = replay(file);
    assert.equal(code, 0, JSON.stringify(report.takes.map((t) => t.replay)));
    assert.deepEqual(report.takes.map((t) => t.replay.status), ["same", "same"]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("keeps a long run on a tweened level, in step at every check", { timeout: 240_000 }, async () => {
    const { dir, recording, file } = await session(join(ROOT, "examples/clockwork-keep"), 5802, 1, async (page, onDisk) => {
      await page.down("ArrowRight", "ArrowRight");
      await sleep(3000);
      await page.up("ArrowRight", "ArrowRight");
      // Played until long enough in frames, however fast this machine draws.
      const start = Date.now();
      try {
        await until("600 frames on disk", () => (onDisk()?.takes[0]?.frames ?? 0) >= 600, 180_000);
      } catch (err) {
        const take = onDisk()?.takes[0];
        const fps = await page.evaluate(`new Promise((done) => { let n = 0; const t = performance.now(); const f = () => (++n, performance.now() - t < 2000 ? requestAnimationFrame(f) : done(n / 2)); requestAnimationFrame(f); })`);
        throw new Error(`${(err as Error).message} After ${Math.round((Date.now() - start) / 1000)} s: ${JSON.stringify({ end: take?.end, frames: take?.frames, deaths: take?.deaths?.length, drawnPerSecond: fps })}`);
      }
    });
    assert.ok(recording.takes[0]!.frames > 500, `played ${recording.takes[0]!.frames} frames`);
    const { code, report } = replay(file);
    assert.equal(code, 0, JSON.stringify(report.takes.map((t) => t.replay)));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
});
