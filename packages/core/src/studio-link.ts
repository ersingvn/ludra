import type { Action, Diagnostic, SceneDef } from "./types.ts";
import { World, type Entity, type GameEvent, type WorldOptions } from "./world.ts";

/**
 * Ludra Studio's side of a running game (docs/studio.md): hot reload by replay, and the postMessage
 * link between the game page and the Studio window around it. The first half is plain simulation
 * and runs in Node too, so it's tested there; `connectStudio` needs a browser.
 */

/** Replay goes this far back at most: 2 minutes of game time. */
export const REPLAY_LIMIT = 7200;

const ACTION_ORDER: readonly Action[] = ["left", "right", "up", "down", "jump", "action"];

/** One frame's input as a short string, the form a hot reload replays from. */
export function inputKey(input: ReadonlySet<Action>): string {
  if (input.size === 0) return "";
  return ACTION_ORDER.filter((a) => input.has(a)).join("+");
}

function inputSet(key: string): ReadonlySet<Action> {
  return key === "" ? NOTHING : new Set(key.split("+") as Action[]);
}
const NOTHING: ReadonlySet<Action> = new Set();

export type Replayed = { result: "kept"; world: World } | { result: "restarted"; world: World; reason: string };

/**
 * A world of `scene` that has been played through `inputs`, one per frame, as the running one was:
 * the same moment of the game, built from the edited files. When that can't be (the edit ends the
 * scene sooner, a script throws on the way, or it's too far in), a fresh world and why.
 */
export function replayScene(scene: SceneDef, inputs: readonly string[], options: WorldOptions = {}): Replayed {
  const fresh = (reason: string): Replayed => ({ result: "restarted", world: new World(scene, options), reason });
  if (inputs.length > REPLAY_LIMIT) return fresh("too far in to replay");
  let world: World;
  try {
    world = new World(scene, options);
    for (let frame = 0; frame < inputs.length; frame++) {
      if (world.over) return fresh(`with this change the scene ${world.won ? "is won" : world.lost ? "is lost" : "ends"} at frame ${world.frame}, before frame ${inputs.length}`);
      world.step(inputSet(inputs[frame]!));
    }
  } catch (err) {
    return fresh(`replaying threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { result: "kept", world };
}

export interface EntitySummary {
  id: string;
  name?: string;
  prefab?: string;
  parent?: string;
  components: string[];
  x: number;
  y: number;
  z?: number;
}

/** Entity fields that aren't components. */
const NOT_COMPONENTS = new Set(["id", "state", "removed", "spawn"]);

function componentNames(e: Entity): string[] {
  return Object.keys(e).filter((k) => !NOT_COMPONENTS.has(k) && (e as unknown as Record<string, unknown>)[k] !== undefined);
}

export function entitySummary(e: Entity, dimensions: 2 | 3): EntitySummary {
  const t = e.transform;
  return { id: e.id, components: componentNames(e), x: round(t.x), y: round(t.y), ...(dimensions === 3 ? { z: round(t.z) } : {}) };
}

/**
 * An entity as plain JSON with its live values. Another entity it refers to (what a body stands on)
 * is its id, functions are left out, and a loop is cut, so it always serializes.
 */
export function entityJson(e: Entity): { id: string; components: Record<string, unknown>; state: Record<string, unknown> } {
  const seen = new WeakSet<object>();
  const clean = (value: unknown, depth: number): unknown => {
    if (typeof value === "function" || value === undefined) return undefined;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (value === null || typeof value !== "object") return value;
    if (value !== e && isEntity(value)) return { entity: value.id };
    if (seen.has(value) || depth > 8) return "…";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 200).map((v) => clean(v, depth + 1) ?? null);
    if (value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) return `[${value.constructor.name}]`;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = clean(v, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  };
  const components: Record<string, unknown> = {};
  for (const name of componentNames(e)) {
    const value = clean((e as unknown as Record<string, unknown>)[name], 1);
    if (value !== undefined) components[name] = value;
  }
  return { id: e.id, components, state: (clean(e.state, 1) as Record<string, unknown>) ?? {} };
}

function isEntity(value: object): value is Entity {
  return typeof (value as Entity).id === "string" && typeof (value as Entity).transform === "object" && (value as Entity).transform !== null && "state" in value;
}

/** A 2D entity's box: its body, else its sprite, else a small square around its centre. */
function box(e: Entity): { w: number; h: number } {
  const body = e.body as { width?: number; height?: number; radius?: number } | undefined;
  const sprite = e.sprite as { width?: number; height?: number } | undefined;
  const w = body?.width ?? (body?.radius !== undefined ? body.radius * 2 : undefined) ?? sprite?.width ?? 24;
  const h = body?.height ?? (body?.radius !== undefined ? body.radius * 2 : undefined) ?? sprite?.height ?? 24;
  return { w, h };
}

export function entityBox(e: Entity): { x: number; y: number; w: number; h: number } {
  const { w, h } = box(e);
  return { x: e.transform.x - w / 2, y: e.transform.y - h / 2, w, h };
}

/**
 * The entity a person means by a click at this world point (2D): the smallest one under it, so a
 * coin in front of a big wall wins. 3D worlds pick nothing yet.
 */
export function entityAt(world: World, x: number, y: number): Entity | undefined {
  if (world.dimensions === 3) return undefined;
  let best: Entity | undefined;
  let bestArea = Infinity;
  for (const e of world.entities) {
    const b = entityBox(e);
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
    const area = b.w * b.h;
    if (area < bestArea) {
      best = e;
      bestArea = area;
    }
  }
  return best;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** What a game page lets Studio do with it. `startGame` hands one to `onControl`. */
export interface GameControl {
  readonly world: World;
  readonly scene: SceneDef;
  /** The running scene's path, as `loadScene` and `goto` take it. */
  readonly scenePath: string;
  readonly paused: boolean;
  /** Frames drawn a second, lately. */
  readonly fps: number;
  /** The canvas the player sees (a postfx scene swaps it). */
  readonly canvas: HTMLCanvasElement;
  pause(): void;
  resume(): void;
  /** While paused, advance exactly this many frames. */
  step(frames: number): void;
  restart(): void;
  goto(scene: string): Promise<void>;
  mute(on: boolean): void;
  focus(): void;
  highlight(id: string | null): void;
  /** Where a point of the page is in the world, for picking. */
  pointToWorld(clientX: number, clientY: number): { x: number; y: number } | undefined;
  /** Swaps in an edited version of the running scene, replaying to the same frame when it can. */
  hot(scene: SceneDef): Promise<{ result: "kept" | "restarted"; frame: number; reason?: string }>;
  /** `scene`: a scene started (first, restart, level change, a hot restart). `crash`: a script threw. */
  on(listener: { scene?: () => void; crash?: (message: string) => void }): void;
}

type Message = { ludra: 1; type: string; [field: string]: unknown };

export interface StudioLink {
  /** Sends a message to Studio, as `{ ludra: 1, type, ...fields }`. */
  send(type: string, fields?: Record<string, unknown>): void;
  error(message: string, diagnostics?: Diagnostic[]): void;
  hot(result: "kept" | "restarted" | "rejected", frame: number, files: string[], reason?: string): void;
  /** Called with every message from Studio the link doesn't handle itself. */
  onMessage?: (message: Message) => void;
  close(): void;
}

/** How often, at most, `status` and `entity` go out, and how many `event`s a second. */
const STATUS_MS = 100;
const EVENTS_PER_SECOND = 20;

/**
 * Connects a running game to the Studio window around it (`target`, normally `window.parent`).
 * Answers Studio's messages and keeps it told what the game is doing, without flooding it.
 */
export function connectStudio(control: GameControl, target: Pick<Window, "postMessage">): StudioLink {
  let inspected: string | null = null;
  let picking = false;
  let lastStatus = "";
  let lastEntities = "";
  let lastEntity = "";
  let eventWorld: World | undefined;
  let eventsSent = 0;
  let budget = EVENTS_PER_SECOND;

  const send = (type: string, fields: Record<string, unknown> = {}) => target.postMessage({ ludra: 1, type, ...fields }, "*");

  const status = () => {
    const w = control.world;
    return { frame: w.frame, paused: control.paused, won: w.won, lost: w.lost, score: w.score, lives: w.lives ?? null, deaths: w.deaths, fps: Math.round(control.fps) };
  };
  const sendStatus = (force: boolean) => {
    const s = status();
    const key = JSON.stringify({ ...s, fps: undefined });
    if (!force && key === lastStatus) return;
    lastStatus = key;
    send("status", s);
  };
  const sendEntities = (force: boolean) => {
    const w = control.world;
    const list = w.entities.map((e) => entitySummary(e, w.dimensions));
    // The set and the names, not positions: those go with `entity` and `status`.
    const key = list.map((e) => `${e.id}:${e.components.join(",")}`).join("|");
    if (!force && key === lastEntities) return;
    lastEntities = key;
    send("entities", { list });
  };
  const sendEntity = (force: boolean) => {
    if (inspected === null) return;
    const e = control.world.entities.find((x) => x.id === inspected);
    const data = e ? entityJson(e) : null;
    const key = JSON.stringify(data);
    if (!force && key === lastEntity) return;
    lastEntity = key;
    send("entity", { id: inspected, data });
  };
  const ready = () => {
    const w = control.world;
    eventWorld = w;
    eventsSent = w.events.length;
    send("ready", { scene: control.scenePath, dimensions: w.dimensions, width: control.canvas.width, height: control.canvas.height, physics: w.physics.name });
    sendEntities(true);
    sendStatus(true);
    sendEntity(true);
  };

  control.on({ scene: ready, crash: (message) => send("error", { message }) });

  const tick = setInterval(() => {
    sendStatus(false);
    sendEntities(false);
    sendEntity(false);
  }, STATUS_MS);
  const refill = setInterval(() => (budget = EVENTS_PER_SECOND), 1000);
  const events = setInterval(() => {
    const w = control.world;
    if (w !== eventWorld) {
      eventWorld = w;
      eventsSent = 0;
    }
    // Over budget, the rest of this burst is skipped rather than sent late.
    for (; eventsSent < w.events.length; eventsSent++) {
      if (budget <= 0) {
        eventsSent = w.events.length;
        break;
      }
      budget--;
      send("event", { event: w.events[eventsSent] as GameEvent });
    }
  }, 50);

  const onClick = (event: MouseEvent) => {
    if (!picking) return;
    event.preventDefault();
    event.stopPropagation();
    const point = control.pointToWorld(event.clientX, event.clientY);
    const e = point ? entityAt(control.world, point.x, point.y) : undefined;
    send("picked", { id: e?.id ?? null });
  };
  addEventListener("click", onClick, true);

  const link: StudioLink = {
    send,
    error: (message, diagnostics) => send("error", { message, ...(diagnostics ? { diagnostics } : {}) }),
    hot: (result, frame, files, reason) => {
      send("hot", { result, frame, files, ...(reason ? { reason } : {}) });
      sendStatus(true);
    },
    close: () => {
      clearInterval(tick);
      clearInterval(refill);
      clearInterval(events);
      removeEventListener("message", onMessage);
      removeEventListener("click", onClick, true);
    },
  };

  const onMessage = (event: MessageEvent) => {
    const m = event.data as Message | undefined;
    if (!m || typeof m !== "object" || m.ludra !== 1 || typeof m.type !== "string") return;
    switch (m.type) {
      case "pause":
        control.pause();
        return sendStatus(true);
      case "resume":
        control.resume();
        return sendStatus(true);
      case "step":
        control.step(Math.max(1, Math.floor(Number(m.frames ?? 1)) || 1));
        return;
      case "restart":
        return control.restart();
      case "goto":
        if (typeof m.scene === "string") void control.goto(m.scene).catch((err: unknown) => link.error(`Could not start ${m.scene}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      case "inspect":
        inspected = typeof m.id === "string" ? m.id : null;
        lastEntity = "";
        return sendEntity(true);
      case "highlight":
        return control.highlight(typeof m.id === "string" ? m.id : null);
      case "pick":
        picking = m.on === true;
        return;
      case "mute":
        return control.mute(m.on === true);
      case "focus":
        return control.focus();
      default:
        link.onMessage?.(m);
    }
  };
  addEventListener("message", onMessage);
  ready();
  return link;
}
