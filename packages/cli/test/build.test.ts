import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { findBrowser } from "../src/headless.ts";
import { oneLiveBrowser } from "./live-browser.ts";
import { ModulePacker, normalizePath, scriptSafe, zip } from "../src/pack.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const browser = findBrowser();
/** Real Chrome on GitHub's Windows and macOS machines draws a game at 1-5 fps: as for recordings, only Linux CI plays one. */
const live = !browser ? "needs Chrome, Edge or Chromium" : process.env.CI && process.platform !== "linux" ? "real browser play runs on Linux CI only" : false;

function run(...args: string[]) {
  const result = spawnSync(process.execPath, ["--conditions=ludra-dev", "--no-warnings", CLI, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
}

function files(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ludra-build-"));
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("the module packer", () => {
  it("rewrites every kind of import to a packed name, once per file, cycles included", () => {
    const dir = files({
      "a.ts": `import { b } from "./b.ts";\nexport * from './c.js';\nimport "./c.js";\nconst lazy = () => import( "./d.js" );\nconst x: number = 1;\nexport { b, lazy, x };`,
      "b.ts": `import { a } from "./a.ts";\nexport const b = () => a;`,
      "c.js": `export const c = 3;`,
      "d.js": `export default "d";`,
    });
    const packer = new ModulePacker(() => undefined);
    const name = packer.addFile(join(dir, "a.ts"));
    assert.equal(name, "@pack/0");
    assert.equal(packer.modules.size, 4);
    const a = packer.modules.get("@pack/0")!;
    assert.doesNotMatch(a, /\.\/[bcd]\./, a);
    assert.doesNotMatch(a, /: number/, "types are stripped");
    assert.match(a, /from "@pack\/1"/);
    assert.match(a, /import\( "@pack\/3" \)/);
    assert.equal(a.match(/@pack\/2/g)!.length, 2, "c.js is one module, named twice");
    assert.match(packer.modules.get("@pack/1")!, /from "@pack\/0"/, "b imports a back");
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves bare specifiers through the given table, and leaves the rest alone", () => {
    const dir = files({ "main.js": `import * as THREE from "three";\nimport { nope } from "not-a-package";\nconst t = "a string that says from \\"./missing.js\\"";`, "three.js": `export const REVISION = 1;` });
    const packer = new ModulePacker((specifier) => (specifier === "three" ? join(dir, "three.js") : undefined));
    packer.addFile(join(dir, "main.js"));
    const main = packer.modules.get("@pack/0")!;
    assert.match(main, /from "@pack\/1"/);
    assert.match(main, /from "not-a-package"/);
    assert.match(main, /\.\/missing\.js/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips modules the game never runs, and replaces import.meta.url with a path that says nothing of this machine", () => {
    const dir = files({ "main.js": `const three = () => import("./big.js");\nconst here = new URL("../libs/x.wasm", import.meta.url);`, "big.js": `export {};` });
    const packer = new ModulePacker(() => undefined, new Set([join(dir, "big.js")]));
    packer.addFile(join(dir, "main.js"));
    assert.equal(packer.modules.size, 1);
    const main = packer.modules.get("@pack/0")!;
    assert.match(main, /import\("\.\/big\.js"\)/);
    assert.doesNotMatch(main, /import\.meta\.url/);
    assert.doesNotThrow(() => new URL("../libs/x.wasm", /new URL\("\.\.\/libs\/x\.wasm", ("[^"]+")\)/.exec(main)![1]!.slice(1, -1)));
    assert.ok(!packer.html("@pack/0").includes(dir), "the page names no folder of the machine that built it");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a page's scripts closed: code that says </script> or <!-- can't end them", () => {
    const json = scriptSafe(JSON.stringify({ code: `const s = "</script><script>alert(1)</script><!--";` }));
    assert.doesNotMatch(json, /<\/script|<!--/i);
    assert.deepEqual(JSON.parse(json), { code: `const s = "</script><script>alert(1)</script><!--";` });
  });

  it("normalizes project paths", () => {
    assert.equal(normalizePath("./models/../textures//a.png"), "textures/a.png");
    assert.equal(normalizePath("assets\\hero.svg"), "assets/hero.svg");
  });
});

describe("zip", () => {
  it("writes entries any unzip reads: names, deflated data and checksums", () => {
    const page = Buffer.from("<!doctype html>".repeat(500));
    const other = Buffer.from("çok güzel");
    const data = zip([{ name: "index.html", data: page }, { name: "notes/ğ.txt", data: other }]);
    let offset = 0;
    const read: { name: string; data: Buffer }[] = [];
    while (data.readUInt32LE(offset) === 0x04034b50) {
      const size = data.readUInt32LE(offset + 18);
      const nameLength = data.readUInt16LE(offset + 26);
      const name = data.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
      const body = inflateRawSync(data.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size));
      assert.equal(data.readUInt32LE(offset + 14), crc32(body));
      read.push({ name, data: body });
      offset += 30 + nameLength + size;
    }
    assert.deepEqual(read.map((f) => f.name), ["index.html", "notes/ğ.txt"]);
    assert.ok(read[0]!.data.equals(page) && read[1]!.data.equals(other));
    const end = data.length - 22;
    assert.equal(data.readUInt32LE(end), 0x06054b50);
    assert.equal(data.readUInt16LE(end + 10), 2);
    assert.equal(data.readUInt32LE(end + 16), offset, "the central directory starts where the files end");
    assert.ok(data.length < page.length / 4, "deflated");
  });

  it("gives the same bytes for the same game", () => {
    const one = zip([{ name: "index.html", data: Buffer.from("same") }]);
    const two = zip([{ name: "index.html", data: Buffer.from("same") }]);
    assert.ok(one.equals(two));
  });
});

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ff00ff"/></svg>`;

/** Two scenes: the first is won at once and moves on to the second, each with its own script. */
function twoSceneGame(): string {
  const ground = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 }, sprite: { color: "#335" } } };
  const player = (script: string) => ({
    id: "player",
    components: { transform: { x: 100, y: 470 }, body: { type: "dynamic", width: 32, height: 32 }, platformer: {}, sprite: { image: "art/hero.svg" }, script: { src: script } },
  });
  const goal = (next?: string) => ({ id: "goal", components: { transform: { x: 100, y: 470 }, body: { type: "static", width: 60, height: 60, sensor: true }, goal: next ? { next } : {} } });
  return files({
    "ludra.json": JSON.stringify({ name: "Two Scenes", entry: "main.scene.json" }),
    "main.scene.json": JSON.stringify({ entities: [ground, player("scripts/first.ts"), goal("scenes/second.scene.json")] }),
    "scenes/second.scene.json": JSON.stringify({ entities: [ground, { ...player("scripts/second.ts"), components: { ...player("scripts/second.ts").components, transform: { x: 300, y: 470 } } }] }),
    "scripts/first.ts": `const count: number = 1;\nexport default { update() { (globalThis as Record<string, unknown>).firstRan = count; } };`,
    "scripts/second.ts": `const label: string = "second scene";\nexport default { update() { (globalThis as Record<string, unknown>).secondRan = label; } };`,
    "art/hero.svg": SVG,
  });
}

describe("ludra build", () => {
  it("writes one HTML file and a zip of it, with every scene, script and asset", () => {
    const dir = twoSceneGame();
    const { code, out } = run("build", dir, "--json");
    assert.equal(code, 0, out);
    const result = JSON.parse(out) as { html: string; zip: string; scenes: string[]; scripts: string[]; assets: string[] };
    assert.deepEqual(result.scenes.sort(), ["main.scene.json", "scenes/second.scene.json"]);
    assert.deepEqual(result.scripts.sort(), ["scripts/first.ts", "scripts/second.ts"]);
    assert.deepEqual(result.assets, ["art/hero.svg"]);
    assert.equal(result.zip.replaceAll("\\", "/"), "build/two-scenes-web.zip");
    const html = readFileSync(join(dir, result.html), "utf8");
    assert.ok(!html.includes(dir) && !html.includes(dir.replaceAll("\\", "/")) && !html.includes(pathToFileURL(dir).href), "no path of this machine in the page");
    assert.ok(html.length < 1024 * 1024, `an arcade 2D game carries neither Rapier nor three (${html.length} bytes)`);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a script that check refuses", () => {
    const dir = twoSceneGame();
    writeFileSync(join(dir, "scripts/first.ts"), `import { helper } from "./helper.ts";\nexport default { update() { helper(); } };`);
    writeFileSync(join(dir, "scripts/helper.ts"), `export const helper = () => {};`);
    const { code, out } = run("build", dir);
    assert.equal(code, 1, out);
    assert.match(out, /cannot import runtime code/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a game with errors, and says which", () => {
    const dir = files({ "ludra.json": JSON.stringify({ name: "Broken", entry: "main.scene.json" }), "main.scene.json": JSON.stringify({ entities: [{ id: "x", components: { body: { type: "wobbly" } } }] }) });
    const { code, out } = run("build", dir);
    assert.equal(code, 1);
    assert.match(out, /wasn't built/);
    assert.match(out, /main\.scene\.json/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("plays from file:// with nothing else around: scripts, images and the next scene", { skip: live, timeout: 240_000 }, () => oneLiveBrowser(async () => {
    const dir = twoSceneGame();
    assert.equal(run("build", dir).code, 0);
    const page = await open(join(dir, "build", "index.html"));
    try {
      await until(async () => (await page.evaluate("globalThis.secondRan")) === "second scene", 120_000);
      assert.equal(await page.evaluate("globalThis.firstRan"), 1);
      assert.deepEqual(page.problems, []);
    } finally {
      await page.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }));
});

/** A side-view game whose script tells the page where the player is and whether action is held. */
function controlsGame(): string {
  const ground = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 }, sprite: { color: "#335" } } };
  const player = { id: "player", components: { transform: { x: 480, y: 480 }, body: { type: "dynamic", width: 32, height: 32 }, platformer: {}, sprite: { color: "#f80" }, script: { src: "scripts/report.ts" } } };
  return files({
    "ludra.json": JSON.stringify({ name: "Controls", entry: "main.scene.json" }),
    "main.scene.json": JSON.stringify({ entities: [ground, player] }),
    "scripts/report.ts": `export default { update({ self, input }) { const page = globalThis as Record<string, unknown>; page.px = self.x; page.act = input.held("action"); } };`,
  });
}

describe("controls besides the keyboard", { skip: live }, () => {
  it("touch buttons appear on a phone, move and act; a gamepad's stick moves too", { timeout: 240_000 }, () => oneLiveBrowser(async () => {
    const dir = controlsGame();
    assert.equal(run("build", dir).code, 0);
    // The page's own Gamepad API, answered from a value the test sets.
    const page = await open(join(dir, "build", "index.html"), { phone: true, beforeLoad: `navigator.getGamepads = () => globalThis.testPads ?? [];` });
    // Pointer events on the page, as a touch screen sends them. Not DevTools' touch input, which a slow machine holds back.
    const touch = (type: string, id: number, where: string) =>
      page.evaluate(`(() => { const [x, y] = ${where}; const target = document.elementFromPoint(x, y) ?? document.body; target.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { pointerId: ${id}, pointerType: "touch", isPrimary: ${id === 1}, clientX: x, clientY: y, bubbles: true, cancelable: true })); return true; })()`);
    const centre = (selector: string, dx = 0) => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2 + ${dx}, r.top + r.height / 2]; })()`;
    const x = async () => (await page.evaluate("globalThis.px")) as number;
    try {
      await until(async () => typeof (await page.evaluate("globalThis.px")) === "number", 120_000);
      assert.equal(await page.evaluate(`document.querySelector(".ludra-touch").hidden`), true, "no buttons before a touch");
      await touch("pointerdown", 9, "[422, 60]");
      await touch("pointerup", 9, "[422, 60]");
      assert.equal(await page.evaluate(`document.querySelector(".ludra-touch").hidden`), false, "buttons once touched");
      assert.deepEqual(await page.evaluate(`[...document.querySelectorAll(".ludra-touch .b")].map((b) => b.dataset.action)`), ["left", "right", "action", "jump"], "a platformer's moves, and action because the script reads it");

      const start = await x();
      await touch("pointerdown", 1, centre(".ludra-touch .move", 40));
      await until(async () => (await x()) > start + 30, 60_000);
      // Sliding the same finger to the other side runs back.
      const turned = await x();
      await touch("pointermove", 1, centre(".ludra-touch .move", -40));
      await until(async () => (await x()) < turned - 30, 60_000);
      await touch("pointerup", 1, centre(".ludra-touch .move", -40));

      assert.equal(await page.evaluate("globalThis.act"), false);
      await touch("pointerdown", 2, centre('.ludra-touch .b[data-action="action"]'));
      await until(async () => (await page.evaluate("globalThis.act")) === true, 60_000);
      await touch("pointerup", 2, centre('.ludra-touch .b[data-action="action"]'));
      await until(async () => (await page.evaluate("globalThis.act")) === false, 60_000);

      const still = await x();
      await page.evaluate(`globalThis.testPads = [{ connected: true, axes: [0.95, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }]`);
      await until(async () => (await x()) > still + 30, 60_000);
      await page.evaluate(`globalThis.testPads = []`);
      assert.deepEqual(page.problems, []);
    } finally {
      await page.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(ready: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error("Timed out.");
    await sleep(100);
  }
}

/** A page in headless Chrome, with every error and warning it logs. */
async function open(file: string, setup: { phone?: boolean; beforeLoad?: string } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "ludra-build-browser-"));
  const chrome = spawn(browser!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--mute-audio", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  chrome.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  while (!/ws:\/\/\S+/.test(log)) await sleep(50);
  const socket = new WebSocket(/ws:\/\/\S+/.exec(log)![0]);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let next = 0;
  const waiting = new Map<number, (value: unknown) => void>();
  const problems: string[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; method?: string; params?: Record<string, any> };
    if (message.id !== undefined) waiting.get(message.id)?.(message.result);
    if (message.method === "Runtime.exceptionThrown") problems.push(String(message.params!.exceptionDetails.exception?.description ?? message.params!.exceptionDetails.text));
    if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params!.type)) problems.push(message.params!.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" "));
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
  if (setup.phone) {
    await send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 1, mobile: true }, sessionId);
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
  }
  if (setup.beforeLoad) await send("Page.addScriptToEvaluateOnNewDocument", { source: setup.beforeLoad }, sessionId);
  await send("Page.navigate", { url: pathToFileURL(file).href }, sessionId);
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
