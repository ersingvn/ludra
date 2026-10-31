import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { CameraView, CapturedFrame } from "@ludra/core/browser";
import { CliError, type Project } from "./project.ts";
import { BLANK_PATH, createGameServer, PROJECT_PREFIX, SCRIPT_PREFIX } from "./server.ts";

const TIMEOUT_MS = 60_000;

/**
 * Finds an installed Chromium-based browser: LUDRA_BROWSER if set, otherwise
 * Chrome, Edge or Chromium in their usual places.
 */
export function findBrowser(): string | undefined {
  const fromEnv = process.env.LUDRA_BROWSER;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;

  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const base of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(join(base, "Google", "Chrome", "Application", "chrome.exe"), join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      for (const name of names) candidates.push(join(dir, name));
    }
  }
  return candidates.find((path) => existsSync(path));
}

export interface ScreenshotRequest {
  /** Draw colliders, sensors, joints and ids over the frames. */
  debug?: boolean;
  /** Scene to render, relative to the project. Defaults to the entry scene. */
  scene?: string;
  inputs: string;
  frames: number[];
  /** Also lay these frames out as one contact sheet, each with its label. */
  sheet?: SheetRequest;
  /** A debugging view instead of the scene's camera (3D). */
  camera?: CameraView;
}

export interface SheetRequest {
  frames: number[];
  /** One line under each frame, in the same order. */
  labels: string[];
}

export interface CaptureResult {
  frames: CapturedFrame[];
  /** The contact sheet as a PNG data URL, when one was asked for. */
  sheet?: string;
}

/** Widest a contact sheet gets, so it stays readable as one image. */
const SHEET_MAX_WIDTH = 2048;
const SHEET_GAP = 4;
const SHEET_LABEL = 22;

/** Columns and cell size for `count` frames of a `width`×`height` window. */
export function sheetLayout(count: number, width: number, height: number) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const cellWidth = Math.min(width, Math.floor((SHEET_MAX_WIDTH - SHEET_GAP * (columns + 1)) / columns));
  const cellHeight = Math.round((height * cellWidth) / width);
  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    width: columns * cellWidth + SHEET_GAP * (columns + 1),
    height: rows * (cellHeight + SHEET_LABEL) + SHEET_GAP * (rows + 1),
  };
}

/**
 * Renders frames of a project in a headless browser, using the same renderer
 * players see. Starts a private game server and browser, and stops both.
 */
function sceneUrl(scene: string | undefined): string {
  return scene ? `/__ludra/scene?path=${encodeURIComponent(scene)}` : "/__ludra/scene";
}

export async function captureScreenshots(project: Project, request: ScreenshotRequest): Promise<CaptureResult> {
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new CliError(
      "Screenshots need Chrome, Edge or Chromium installed, and none was found.\n" +
        "Install one, or set LUDRA_BROWSER to the path of a Chromium-based browser.",
    );
  }

  const { server, browserModule, physicsModule, threeModule } = createGameServer(project, () => "");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const profile = mkdtempSync(join(tmpdir(), "ludra-browser-"));
  let browser: ChildProcess | undefined;
  let cdp: Cdp | undefined;

  try {
    const { width, height } = project.config.window;
    browser = spawn(
      browserPath,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        "--hide-scrollbars",
        // Software WebGL, so postfx shaders render without a GPU.
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        `--window-size=${width},${height}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    cdp = await Cdp.connect(await devToolsUrl(browser));

    const origin = `http://127.0.0.1:${port}`;
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: origin + BLANK_PATH });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    // The new tab starts on about:blank; wait until it has loaded the game server's page.
    await waitFor(cdp, sessionId, `location.origin === ${JSON.stringify(origin)} && document.readyState === "complete"`);

    const script = `(async () => {
      const { captureFrames } = await import(${JSON.stringify(browserModule)});
      const data = await (await fetch(${JSON.stringify(sceneUrl(request.scene))})).json();
      if (!data.ok) throw new Error("The scene has errors. Run ludra check.");
      const canvas = document.createElement("canvas");
      canvas.width = ${width};
      canvas.height = ${height};
      document.body.append(canvas);
      return captureFrames(canvas, data.scene, {
        assetBase: ${JSON.stringify(PROJECT_PREFIX)},
        scriptBase: ${JSON.stringify(SCRIPT_PREFIX)},
        scriptPaths: await (await fetch("/__ludra/scripts")).json(),
        inputs: ${JSON.stringify(request.inputs)},
        frames: ${JSON.stringify(request.frames)},
        debug: ${JSON.stringify(!!request.debug)},
        camera: ${JSON.stringify(request.camera ?? null)} ?? undefined,
        loadPhysics: async (name) => {
          if (name === "rapier") await (await import(${JSON.stringify(physicsModule)})).loadRapierPhysics();
          if (name === "rapier3d") await (await import(${JSON.stringify(physicsModule)})).loadRapier3DPhysics();
        },
        loadRenderer3D: async () => (await import(${JSON.stringify(threeModule)})).createRenderer3D,
      });
    })()`;
    const frames = await evaluate<CapturedFrame[]>(cdp, sessionId, script);
    if (!request.sheet) return { frames };
    const layout = sheetLayout(request.sheet.frames.length, width, height);
    const cells = request.sheet.frames.map((frame, i) => ({ png: frames.find((f) => f.frame === frame)!.png, label: request.sheet!.labels[i] ?? "" }));
    // Drawn in the page, where decoding and scaling PNGs is built in.
    const compose = `(async () => {
      const layout = ${JSON.stringify(layout)};
      const cells = ${JSON.stringify(cells)};
      const gap = ${SHEET_GAP}, label = ${SHEET_LABEL};
      const sheet = document.createElement("canvas");
      sheet.width = layout.width;
      sheet.height = layout.height;
      const ctx = sheet.getContext("2d");
      ctx.fillStyle = "#111318";
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      ctx.imageSmoothingQuality = "high";
      ctx.textBaseline = "middle";
      for (const [i, cell] of cells.entries()) {
        const image = new Image();
        image.src = cell.png;
        await image.decode();
        const x = gap + (i % layout.columns) * (layout.cellWidth + gap);
        const y = gap + Math.floor(i / layout.columns) * (layout.cellHeight + label + gap);
        ctx.drawImage(image, x, y, layout.cellWidth, layout.cellHeight);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y + layout.cellHeight, layout.cellWidth, label);
        ctx.clip();
        ctx.fillStyle = "#e8eaf0";
        ctx.font = "13px ui-monospace, Consolas, monospace";
        ctx.fillText(cell.label, x + 6, y + layout.cellHeight + label / 2);
        ctx.restore();
      }
      return sheet.toDataURL("image/png");
    })()`;
    return { frames, sheet: await evaluate<string>(cdp, sessionId, compose) };
  } finally {
    await cdp?.send("Browser.close").catch(() => {});
    cdp?.close();
    if (browser && browser.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          browser!.kill();
          resolve(undefined);
        }, 3000);
        browser!.once("exit", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    }
    server.close();
    removeProfile(profile);
  }
}

/**
 * The browser can keep its profile busy for a moment after exiting: files held open
 * on Windows, helper processes still writing on macOS (ENOTEMPTY). Retry, and if it
 * still won't go, leave it to the OS's temp cleanup rather than fail a capture that worked.
 */
function removeProfile(profile: string): void {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.warn(`Could not remove the temporary browser profile ${profile}: ${(err as Error).message}`);
  }
}

/** Chrome prints "DevTools listening on ws://..." to stderr once it is ready. */
function devToolsUrl(browser: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new CliError(`The browser did not start in time.\n${output.trim()}`)), TIMEOUT_MS);
    browser.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    browser.once("exit", (code) => {
      clearTimeout(timer);
      reject(new CliError(`The browser exited before it was ready (code ${code}).\n${output.trim()}`));
    });
    browser.once("error", (err) => {
      clearTimeout(timer);
      reject(new CliError(`Could not start the browser: ${err.message}`));
    });
  });
}

async function waitFor(cdp: Cdp, sessionId: string, condition: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!(await evaluate<boolean>(cdp, sessionId, condition))) {
    if (Date.now() > deadline) throw new CliError("The browser did not load the game page in time.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const result = await cdp.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new CliError(`Rendering failed in the browser: ${details.exception?.description ?? details.text ?? "unknown error"}`);
  }
  return result.result.value as T;
}

/** A minimal Chrome DevTools Protocol client over the WebSocket built into Node. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new CliError(`Browser error: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new CliError("The browser closed unexpectedly."));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener("error", () => reject(new CliError(`Could not connect to the browser at ${url}.`)), { once: true });
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError(`The browser did not answer ${method} in time.`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close(): void {
    this.socket.close();
  }
}
