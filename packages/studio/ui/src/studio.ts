import type { Backend, Connection } from "./backend.ts";
import { debounce, Emitter } from "./dom.ts";
import { Editor } from "./editor.ts";
import { GameLink } from "./game-link.ts";
import type {
  CheckResult, Command, Diagnostic, EntityData, EntitySummary, FileChange, GameMessage, GameStatus, GameView, ProjectInfo, RunResponse,
} from "./protocol.ts";
import { youDid, type Point } from "./tools.ts";

export interface HotResult {
  result: "kept" | "restarted" | "rejected";
  frame: number;
  reason?: string;
}

export interface ActivityEntry {
  id: number;
  at: Date;
  version: number | string;
  files: FileChange[];
  hot?: HotResult;
  /** "studio" when the person made it in Studio (an edit, undo or redo), with what they did. */
  by?: "studio" | "files";
  label?: string;
}

/** What the palette has picked to place with the next click in the game. */
export interface Placing {
  kind: "prefab" | "block";
  name: string;
}

export interface ConsoleEntry {
  id: number;
  at: Date;
  frame: number | null;
  level: "event" | "error" | "info" | "hot" | "warn";
  text: string;
  detail?: string;
}

export interface RunState {
  running: boolean;
  /** Set when the run was started by Studio after a change, not by the person. */
  auto?: boolean;
  response?: RunResponse<any>;
  error?: string;
  at?: Date;
  ms?: number;
}

export interface Toast {
  kind: "kept" | "restarted" | "rejected" | "info" | "error";
  title: string;
  detail?: string;
}

type Events = {
  project: ProjectInfo;
  connection: Connection;
  scene: string | null;
  status: GameStatus;
  entities: EntitySummary[];
  selection: string | null;
  hover: string | null;
  entity: EntityData | null;
  picking: boolean;
  muted: boolean;
  run: Command;
  activity: ActivityEntry[];
  console: ConsoleEntry;
  consoleCleared: void;
  gameErrors: Diagnostic[];
  toast: Toast;
  tab: string;
  view: GameView | null;
  grid: number;
  placing: Placing | null;
  /** Someone asked to frame the selection (F, or the hierarchy's menu). */
  frame: void;
};

const CONSOLE_LIMIT = 1000;

/** All of Studio's state, and every action a panel can take. Panels listen and render. */
export class Studio extends Emitter<Events> {
  readonly link: GameLink;
  project: ProjectInfo | null = null;
  connection: Connection = "connecting";
  scene: string | null = null;
  dimensions: 2 | 3 = 2;
  physics = "";
  gameSize = { width: 960, height: 540 };
  status: GameStatus = { frame: 0, paused: false, won: false, lost: false, score: 0, lives: 0, deaths: 0, fps: 0 };
  entities: EntitySummary[] = [];
  selected: string | null = null;
  entity: EntityData | null = null;
  picking = false;
  muted = false;
  runs: Record<Command, RunState> = { check: { running: false }, test: { running: false }, review: { running: false } };
  activity: ActivityEntry[] = [];
  consoleEntries: ConsoleEntry[] = [];
  gameErrors: Diagnostic[] = [];
  /** The 2D game's camera and canvas, from `view`; null in 3D or before the first frame. */
  view: GameView | null = null;
  /** Grid size in world px (G toggles it on and off); `gridOn` says whether it shows and snaps. */
  gridSize = 16;
  gridOn = false;
  placing: Placing | null = null;
  readonly editor: Editor;
  private pickAsks = new Map<number, (id: string | null) => void>();
  private nextPickTag = 1;
  private nextId = 1;
  private eventsThisSecond = 0;
  private projectFailed = false;

  readonly backend: Backend;
  readonly mock: boolean;

  constructor(backend: Backend, mock: boolean) {
    super();
    this.backend = backend;
    this.mock = mock;
    this.link = new GameLink(backend.gameOrigin);
    this.link.on("any", (msg) => this.onGame(msg));
    this.editor = new Editor({
      backend,
      scene: () => this.scene,
      liveIds: () => this.entities.map((e) => e.id),
      toast: (t) => this.emit("toast", t),
    });
    setInterval(() => (this.eventsThisSecond = 0), 1000);
  }

  async start(): Promise<void> {
    this.backend.listen(
      (event) => {
        if (event.type === "hello") this.log("info", `Connected to ludra dev (version ${event.version})`);
        else if (event.type === "change") this.onChange(event.version, event.at, event.files, event.by, event.label);
      },
      (state) => {
        if (state === this.connection) return;
        if (state === "lost" || (state === "connecting" && this.connection === "live")) this.log("warn", "Lost the connection to ludra dev. Retrying…");
        this.connection = state;
        this.emit("connection", state);
        // The server came up after Studio did: read what we missed.
        if (state === "live" && this.projectFailed) void this.loadProject().then(() => this.runCommand("check", true));
      },
    );
    await this.loadProject();
    void this.runCommand("check", true);
  }

  private async loadProject(): Promise<void> {
    try {
      this.project = await this.backend.project();
      this.emit("project", this.project);
      this.gameSize = { width: this.project.window.width, height: this.project.window.height };
      document.title = `${this.project.name} · Ludra Studio`;
      this.projectFailed = false;
    } catch (err) {
      this.projectFailed = true;
      this.log("error", "Couldn't read the project from the server.", String(err));
    }
  }

  // Game controls

  togglePlay(): void {
    this.link.send({ type: this.status.paused ? "resume" : "pause" });
    // Show it at once; the game's status confirms it.
    this.status = { ...this.status, paused: !this.status.paused };
    this.emit("status", this.status);
  }
  step(frames = 1): void {
    if (!this.status.paused) this.togglePlay();
    this.link.send({ type: "step", frames });
  }
  restart(): void {
    this.link.send({ type: "restart" });
  }
  goto(scene: string): void {
    this.link.send({ type: "goto", scene });
  }
  focusGame(): void {
    this.link.send({ type: "focus" });
  }
  setPicking(on: boolean): void {
    if (on === this.picking) return;
    this.picking = on;
    this.link.send({ type: "pick", on });
    this.emit("picking", on);
  }
  setMuted(on: boolean): void {
    this.muted = on;
    this.link.send({ type: "mute", on });
    this.emit("muted", on);
  }
  select(id: string | null): void {
    if (id === this.selected) return;
    this.selected = id;
    this.entity = null;
    this.link.send({ type: "inspect", id });
    this.link.send({ type: "highlight", id });
    this.emit("selection", id);
    this.emit("entity", null);
  }
  /** Outline an entity while the pointer is over it, then go back to the selection. */
  hover(id: string | null): void {
    this.link.send({ type: "highlight", id: id ?? this.selected });
    this.emit("hover", id);
  }
  // Viewport tools (docs/editor.md, part B)

  /** What is at a world point, asked of the game (it knows the bodies and sprites). */
  pickAt(at: Point): Promise<string | null> {
    const tag = this.nextPickTag++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pickAsks.delete(tag);
        resolve(null);
      }, 500);
      this.pickAsks.set(tag, (id) => {
        clearTimeout(timer);
        resolve(id);
      });
      this.link.send({ type: "pickAt", x: at.x, y: at.y, tag });
    });
  }
  preview(id: string | null, at?: Point): void {
    this.link.send(id && at ? { type: "preview", id, x: at.x, y: at.y } : { type: "preview", id: null });
  }
  /** The placement ghost: what the palette has picked, or `components` (an Alt+drag copy); null hides it. */
  ghost(at: Point | null, components?: Record<string, unknown>): void {
    if (at && components) return this.link.send({ type: "ghost", components, x: at.x, y: at.y });
    const p = this.placing;
    if (!at || !p) return this.link.send({ type: "ghost" });
    // A block has no prefab to draw; a plain box stands in for it.
    this.link.send(p.kind === "prefab" ? { type: "ghost", prefab: p.name, x: at.x, y: at.y } : { type: "ghost", components: { sprite: { color: "#9aa5b1", width: 48, height: 24 } }, x: at.x, y: at.y });
  }
  look(at: { x: number; y: number; zoom: number } | null): void {
    this.link.send(at ? { type: "look", ...at } : { type: "look" });
  }
  setGrid(on: boolean, size = this.gridSize): void {
    this.gridOn = on;
    this.gridSize = Math.max(1, Math.round(size));
    this.link.send({ type: "grid", size: on ? this.gridSize : 0 });
    this.emit("grid", on ? this.gridSize : 0);
  }
  /** The grid edits snap to: its size while it shows, otherwise none. */
  get snap(): number {
    return this.gridOn ? this.gridSize : 0;
  }
  /** F: look at the selection in the game, or back at the game's own camera. */
  frameSelection(): void {
    this.emit("frame", undefined);
  }
  setPlacing(p: Placing | null): void {
    this.placing = p;
    if (!p) this.ghost(null);
    this.emit("placing", p);
  }

  showTab(tab: string): void {
    this.emit("tab", tab);
  }

  // check, test, review

  async runCommand(command: Command, auto = false, args: string[] = []): Promise<void> {
    const state = this.runs[command];
    if (state.running) return;
    this.runs[command] = { ...state, running: true, auto };
    this.emit("run", command);
    const started = performance.now();
    try {
      const response = await this.backend.run(command, args);
      this.runs[command] = { running: false, auto, response, at: new Date(), ms: performance.now() - started };
      if (!auto) this.log("info", `ludra ${command}: ${summarize(command, response)}`);
    } catch (err) {
      this.runs[command] = { running: false, auto, error: String(err instanceof Error ? err.message : err), at: new Date() };
      this.log("error", `ludra ${command} failed to run`, this.runs[command].error);
    }
    this.emit("run", command);
  }

  private autoCheck = debounce(() => void this.runCommand("check", true), 500);

  // Messages

  private onChange(version: number | string, at: string, files: FileChange[], by?: "studio" | "files", label?: string): void {
    const entry: ActivityEntry = { id: this.nextId++, at: new Date(at), version, files, ...(by ? { by } : {}), ...(label ? { label } : {}) };
    this.activity = [entry, ...this.activity].slice(0, 200);
    this.emit("activity", this.activity);
    this.editor.changed(files.map((f) => f.path));
    const names = files.map((f) => f.path).join(", ");
    this.log("info", by === "studio" ? `${youDid(label)} (${names})` : `Changed ${names}`);
    this.autoCheck();
  }

  private onGame(msg: GameMessage): void {
    switch (msg.type) {
      case "ready": {
        this.scene = msg.scene;
        this.dimensions = msg.dimensions;
        this.physics = msg.physics;
        if (msg.width && msg.height) this.gameSize = { width: msg.width, height: msg.height };
        if (msg.dimensions !== 2) this.setView(null);
        this.emit("scene", msg.scene);
        if (this.gridOn) this.link.send({ type: "grid", size: this.gridSize });
        if (this.muted) this.link.send({ type: "mute", on: true });
        if (this.picking) this.link.send({ type: "pick", on: true });
        // The world is new: ask again about the selection, which may have survived.
        if (this.selected) {
          this.link.send({ type: "inspect", id: this.selected });
          this.link.send({ type: "highlight", id: this.selected });
        }
        break;
      }
      case "status": {
        const { type: _type, ...status } = msg;
        const before = this.status;
        this.status = status;
        this.emit("status", status);
        if (status.won && !before.won) this.log("event", "Won", undefined, status.frame);
        if (status.lost && !before.lost) this.log("error", "Lost", undefined, status.frame);
        break;
      }
      case "entities":
        this.entities = msg.list;
        this.emit("entities", msg.list);
        break;
      case "entity":
        if (msg.id !== this.selected) return;
        this.entity = msg.data;
        this.emit("entity", msg.data);
        break;
      case "view": {
        const { type: _type, ...view } = msg;
        this.setView(view);
        break;
      }
      case "picked":
        if (msg.tag !== undefined) {
          this.pickAsks.get(msg.tag)?.(msg.id);
          this.pickAsks.delete(msg.tag);
          return;
        }
        this.setPicking(false);
        if (msg.id) this.select(msg.id);
        break;
      case "hot": {
        const hot: HotResult = { result: msg.result, frame: msg.frame, reason: msg.reason };
        const entry = this.activity.find((a) => !a.hot && a.files.some((f) => msg.files.includes(f.path))) ?? this.activity.find((a) => !a.hot);
        if (entry) {
          entry.hot = hot;
          this.emit("activity", this.activity);
        }
        if (msg.result !== "rejected") this.setGameErrors([]);
        const files = msg.files.length > 0 ? msg.files : entry?.files.map((f) => f.path) ?? [];
        // The person's own edits show in place; only say something when they didn't simply apply.
        if (entry?.by !== "studio") this.emit("toast", hotToast(hot, files));
        else if (msg.result !== "kept") this.emit("toast", { ...hotToast(hot, files), title: youDid(entry.label) });
        this.log("hot", `Hot reload ${msg.result}: ${files.join(", ") || "files"}${msg.reason ? ` (${msg.reason})` : ""}`, undefined, msg.frame);
        break;
      }
      case "event": {
        const ev = msg.event;
        if (++this.eventsThisSecond > 40) return;
        const { type, ...rest } = ev;
        const detail = Object.keys(rest).length > 0 ? describeEvent(rest) : undefined;
        this.log(type === "die" ? "warn" : "event", type, detail, typeof ev.frame === "number" ? ev.frame : this.status.frame);
        break;
      }
      case "error":
        this.log("error", msg.message, msg.diagnostics?.map((d) => `${d.code} ${d.path}: ${d.message}`).join("\n"), this.status.frame);
        if (msg.diagnostics) this.setGameErrors(msg.diagnostics);
        else this.emit("toast", { kind: "error", title: "Script error", detail: msg.message });
        break;
    }
  }

  private setView(view: GameView | null): void {
    this.view = view;
    this.emit("view", view);
  }

  private setGameErrors(list: Diagnostic[]): void {
    if (list.length === 0 && this.gameErrors.length === 0) return;
    this.gameErrors = list;
    this.emit("gameErrors", list);
  }

  log(level: ConsoleEntry["level"], text: string, detail?: string, frame: number | null = null): void {
    const entry: ConsoleEntry = { id: this.nextId++, at: new Date(), frame, level, text, detail };
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > CONSOLE_LIMIT) this.consoleEntries.splice(0, this.consoleEntries.length - CONSOLE_LIMIT);
    this.emit("console", entry);
  }

  clearConsole(): void {
    this.consoleEntries = [];
    this.emit("consoleCleared", undefined);
  }
}

function hotToast(hot: HotResult, files: string[]): Toast {
  const what = files.length === 1 ? files[0]! : files.length > 1 ? `${files[0]} and ${files.length - 1} more` : "the game";
  const at = `${(hot.frame / 60).toFixed(1)} s`;
  if (hot.result === "kept") return { kind: "kept", title: `AI changed ${what}`, detail: `State kept at ${at}` };
  if (hot.result === "restarted") return { kind: "restarted", title: `AI changed ${what}`, detail: `Restarted${hot.reason ? `: ${hot.reason}` : ""}` };
  return { kind: "rejected", title: `Change to ${what} not applied`, detail: hot.reason ?? "It doesn't pass check. The old version keeps running." };
}

function describeEvent(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([k]) => k !== "frame")
    .map(([k, v]) => `${k}=${typeof v === "number" ? Math.round(v * 100) / 100 : typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
}

export function summarize(command: Command, response: RunResponse<any>): string {
  const r = response.result ?? {};
  if (command === "check") {
    const c = r as CheckResult;
    return c.errors > 0 ? `${c.errors} error(s), ${c.warnings} warning(s)` : c.warnings > 0 ? `no errors, ${c.warnings} warning(s)` : "no problems";
  }
  if (command === "test") {
    if (r.error) return r.error;
    return `${r.passed ?? 0} passed, ${r.failed ?? 0} failed`;
  }
  return `${r.issues ?? 0} issue(s), ${r.ideas ?? 0} idea(s)`;
}
