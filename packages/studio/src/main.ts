/**
 * Ludra Studio's Electron main process: runs `ludra dev --studio` for the project, opens the Studio
 * window on it, and gives the window what a web page can't do alone (a native menu, opening folders and
 * files, remembering recent projects). See docs/studio.md.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const UI = new URL("../ui/index.html", import.meta.url);
const PRELOAD = new URL("./preload.cjs", import.meta.url);
/** Menu commands the UI acts on (window.studio.onMenu). */
type MenuCommand = "play" | "step" | "restart" | "check" | "test" | "review" | "pick";

interface State {
  window?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  recent: string[];
}

// ---------------------------------------------------------------------------------------------
// Arguments and remembered state

function parseArgs(argv: string[]): { dir?: string; port?: number } {
  const out: { dir?: string; port?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) out.port = Number(a.slice(7));
    else if (!a.startsWith("-") && !a.endsWith(".js") && out.dir === undefined) out.dir = resolve(a);
  }
  return out;
}

// Electron's argv is [electron, main.js, ...ours] (or [app, ...ours] when packaged).
const args = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2));
const statePath = () => join(app.getPath("userData"), "studio-state.json");

function loadState(): State {
  try {
    const state = JSON.parse(readFileSync(statePath(), "utf8")) as State;
    return { ...state, recent: (state.recent ?? []).filter((d) => existsSync(join(d, "ludra.json"))) };
  } catch {
    return { recent: [] };
  }
}

function saveState(): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch {
    // Not remembering is fine.
  }
}

let state: State = { recent: [] };

function remember(dir: string): void {
  state.recent = [dir, ...state.recent.filter((d) => d !== dir)].slice(0, 10);
  saveState();
  app.addRecentDocument(dir);
}

// ---------------------------------------------------------------------------------------------
// The game server: `ludra dev <dir> --studio`

interface Server {
  dir: string;
  url: string;
  child: ChildProcess;
  /** The last lines it printed, to show if it dies. */
  log: string[];
}

let server: Server | undefined;
let quitting = false;

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

/** [program, ...args] that runs `ludra`: from `ludra studio`, or the @ludra/cli Studio finds, on Electron's Node. */
function cliCommand(): { command: string[]; env: NodeJS.ProcessEnv } {
  const given = process.env.LUDRA_STUDIO_CLI;
  if (given) return { command: JSON.parse(given) as string[], env: {} };
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve("@ludra/cli");
  } catch {
    throw new Error("Studio couldn't find @ludra/cli. Install it next to @ludra/studio (npm install @ludra/cli), or start Studio with `ludra studio`.");
  }
  return { command: [process.execPath, entry], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

async function startServer(dir: string): Promise<Server> {
  const port = args.port && server === undefined ? args.port : await freePort();
  const { command, env } = cliCommand();
  const [program, ...rest] = command;
  const child = spawn(program!, [...rest, "dev", dir, "--studio", "--no-record", "--port", String(port)], {
    env: { ...process.env, ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const log: string[] = [];
  const keep = (chunk: Buffer) => {
    log.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
    log.splice(0, Math.max(0, log.length - 40));
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const url = `http://127.0.0.1:${port}`;
  const next: Server = { dir, url, child, log };

  // Ready once it answers; dead if it exits first.
  const exited = new Promise<never>((_, fail) => child.once("exit", (code) => fail(new Error(`The game server stopped (exit ${code}).\n\n${log.join("\n")}`))));
  const ready = (async () => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      try {
        const res = await fetch(`${url}/__ludra/version`);
        if (res.ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    child.kill();
    throw new Error(`The game server didn't start within 30 s.\n\n${log.join("\n")}`);
  })();
  await Promise.race([ready, exited]);
  child.on("exit", (code) => {
    if (quitting || server !== next) return;
    server = undefined;
    void serverDied(next, code);
  });
  return next;
}

function stopServer(): void {
  const s = server;
  server = undefined;
  if (s && s.child.exitCode === null) s.child.kill();
}

async function serverDied(dead: Server, code: number | null): Promise<void> {
  const choice = await dialog.showMessageBox(window!, {
    type: "error",
    title: "Ludra Studio",
    message: "The game server stopped.",
    detail: `Exit code ${code}.\n\n${dead.log.slice(-15).join("\n")}`,
    buttons: ["Restart it", "Open another project…", "Quit"],
    defaultId: 0,
  });
  if (choice.response === 0) await openProject(dead.dir);
  else if (choice.response === 1) await chooseProject();
  else app.quit();
}

// ---------------------------------------------------------------------------------------------
// The window

let window: BrowserWindow | undefined;

function createWindow(): BrowserWindow {
  const saved = state.window;
  const win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#0f1117",
    title: "Ludra Studio",
    webPreferences: {
      preload: fileURLToPath(PRELOAD),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (saved?.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());

  const keepBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    state.window = { ...(win.isMaximized() ? (state.window ?? win.getNormalBounds()) : win.getBounds()), maximized: win.isMaximized() };
    saveState();
  };
  win.on("resize", keepBounds);
  win.on("move", keepBounds);
  win.on("maximize", keepBounds);
  win.on("unmaximize", keepBounds);

  // Links open in the person's browser; the window itself only ever shows Studio and the game.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(UI.href.split("?")[0]!) && !url.startsWith(server?.url ?? "\0")) event.preventDefault();
  });
  return win;
}

function load(win: BrowserWindow, s: Server): void {
  const name = projectName(s.dir);
  win.setTitle(`${name} · Ludra Studio`);
  if (existsSync(UI)) {
    void win.loadURL(`${UI.href}?server=${encodeURIComponent(s.url)}`);
  } else {
    // A repo checkout without the UI built: show the game alone, so the shell can still be tried.
    void win.loadURL(`${s.url}/?studio=1`);
  }
}

function projectName(dir: string): string {
  try {
    return (JSON.parse(readFileSync(join(dir, "ludra.json"), "utf8")) as { name?: string }).name ?? basename(dir);
  } catch {
    return basename(dir);
  }
}

async function openProject(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, "ludra.json"))) {
    await dialog.showMessageBox(window!, { type: "warning", title: "Ludra Studio", message: "That folder isn't a Ludra game.", detail: `There is no ludra.json in ${dir}.\n\nMake one with \`ludra new <folder>\`.` });
    return false;
  }
  stopServer();
  try {
    server = await startServer(dir);
  } catch (err) {
    await dialog.showMessageBox(window!, { type: "error", title: "Ludra Studio", message: `Couldn't open ${basename(dir)}.`, detail: (err as Error).message });
    return false;
  }
  remember(dir);
  buildMenu();
  load(window!, server);
  return true;
}

async function chooseProject(): Promise<boolean> {
  const picked = await dialog.showOpenDialog(window!, { title: "Open a Ludra game", properties: ["openDirectory"], ...(server ? { defaultPath: server.dir } : {}) });
  if (picked.canceled || !picked.filePaths[0]) return false;
  return openProject(picked.filePaths[0]);
}

/** A path from the UI, relative to the project, that must stay inside it. */
function inProject(path: string): string | undefined {
  if (!server || typeof path !== "string") return undefined;
  const full = resolve(server.dir, path);
  const rel = relative(server.dir, full);
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : full;
}

/** Opens a file in VS Code at a line if `code` is on the PATH, otherwise with the system's default app. */
function openInEditor(full: string, line?: number): void {
  const target = line ? `${full}:${line}` : full;
  const code = spawn(process.platform === "win32" ? "code.cmd" : "code", ["-g", target], { stdio: "ignore", shell: process.platform === "win32", windowsHide: true });
  code.once("error", () => void shell.openPath(full));
  code.once("exit", (status) => {
    if (status !== 0) void shell.openPath(full);
  });
}

// ---------------------------------------------------------------------------------------------
// Menu and IPC

function send(command: MenuCommand): void {
  window?.webContents.send("studio:menu", command);
}

function buildMenu(): void {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: () => void chooseProject() },
        {
          label: "Open Recent",
          submenu: state.recent.length > 0 ? [...state.recent.map((dir) => ({ label: dir, click: () => void openProject(dir) })), { type: "separator" as const }, { label: "Clear Recent", click: () => ((state.recent = []), saveState(), buildMenu()) }] : [{ label: "Nothing yet", enabled: false }],
        },
        { label: "Show Project Folder", enabled: !!server, click: () => server && void shell.openPath(server.dir) },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Game",
      submenu: [
        { label: "Play / Pause", accelerator: "F5", click: () => send("play") },
        { label: "Step One Frame", accelerator: "F10", click: () => send("step") },
        { label: "Restart Scene", accelerator: "CmdOrCtrl+R", click: () => send("restart") },
        { label: "Pick in Game", accelerator: "CmdOrCtrl+P", click: () => send("pick") },
        { type: "separator" },
        { label: "Check", accelerator: "CmdOrCtrl+Shift+C", click: () => send("check") },
        { label: "Test", accelerator: "CmdOrCtrl+Shift+T", click: () => send("test") },
        { label: "Review", accelerator: "CmdOrCtrl+Shift+V", click: () => send("review") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload Studio", accelerator: "CmdOrCtrl+Shift+R", click: () => window && server && load(window, server) },
        { role: "toggleDevTools", accelerator: "F12" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      role: "help",
      submenu: [
        { label: "Ludra on GitHub", click: () => void shell.openExternal("https://github.com/ersingvn/ludra") },
        { label: "Studio Guide", click: () => void shell.openExternal("https://github.com/ersingvn/ludra/blob/main/docs/studio.md") },
        { label: `Ludra Studio ${VERSION}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function wireIpc(): void {
  ipcMain.on("studio:info", (event) => {
    event.returnValue = { version: VERSION, platform: process.platform, project: server ? { dir: server.dir, url: server.url } : null };
  });
  ipcMain.handle("studio:open-project", () => chooseProject());
  ipcMain.handle("studio:open-recent", (_e, dir: unknown) => (typeof dir === "string" && state.recent.includes(dir) ? openProject(dir) : false));
  ipcMain.handle("studio:recent", () => state.recent);
  ipcMain.handle("studio:reveal", (_e, path: unknown) => {
    const full = inProject(String(path ?? ""));
    if (!full) return false;
    if (existsSync(full)) shell.showItemInFolder(full);
    else void shell.openPath(server!.dir);
    return true;
  });
  ipcMain.handle("studio:open-in-editor", (_e, path: unknown, line: unknown) => {
    const full = inProject(String(path ?? ""));
    if (!full || !existsSync(full)) return false;
    openInEditor(full, typeof line === "number" && line > 0 ? Math.floor(line) : undefined);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------

app.setName("Ludra Studio");

app.whenReady().then(async () => {
  state = loadState();
  wireIpc();
  buildMenu();
  window = createWindow();
  const dir = args.dir ?? state.recent[0];
  const opened = dir ? await openProject(dir) : false;
  const shot = process.env.LUDRA_STUDIO_SCREENSHOT;
  if (shot && window) {
    // For smoke tests and docs: open, let the game run a moment, save the window as a PNG, quit.
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        writeFileSync(shot, (await window!.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.LUDRA_STUDIO_SCREENSHOT_DELAY ?? 4000));
    });
    if (!opened) app.quit();
    return;
  }
  if (!opened && !(await chooseProject())) {
    if (!server) app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  stopServer();
});
process.on("exit", () => stopServer());

