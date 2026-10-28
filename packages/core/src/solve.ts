import { FPS } from "./time.ts";
import type { Action } from "./types.ts";
import type { Entity, World, WorldSave } from "./world.ts";

/**
 * `solve` searches the inputs for a way to win, so the engine (not the agent) answers "can this
 * level be beaten, how, and how tight is it". The search is Go-Explore: remember every distinct
 * situation the player reaches (a "cell": where it is, on the ground or not, the score, what the
 * scripts hold), keep the earliest way to get there, and keep exploring from the cells tried least
 * and closest to the goal. Each try starts from a saved moment (`World.save`), not from frame 0.
 * Engines that can't save fall back to replaying the inputs that led to the cell.
 */

export interface SolveOptions {
  /** Most frames simulated across the whole search. Default 2,000,000. */
  budget?: number;
  /** Returns true when time is up (wall clock lives with the caller, never in the simulation). */
  deadline?: () => boolean;
  /** Longest run considered, in seconds. Default 120. */
  maxSeconds?: number;
  /** Count a win that cost lives. Default false: a solution never dies. */
  allowDeaths?: boolean;
  /** What counts as done. Default: the world is won. */
  goal?: (world: World) => boolean;
  /** Frames each decision holds its actions. Default 6 (0.1 s). */
  hold?: number;
  /** The action sets to try. Default: from the player's controller. */
  choices?: readonly (readonly Action[])[];
  /** Seeds the search's own choices, so a search is repeatable. Default 1. */
  seed?: number;
  /** Measure how far each jump's timing can move and still win. Default true. */
  windows?: boolean;
}

export interface TimingWindow {
  /** Frame the action is first pressed in the solution. */
  frame: number;
  action: Action;
  /** How many frames earlier and later the press still wins. */
  early: number;
  late: number;
  /** early + late + 1, in frames. Below 6 (0.1 s) is tight for a person. */
  width: number;
}

export interface SolveResult {
  solved: boolean;
  /** The winning inputs, in `ludra play --inputs` form. */
  inputs?: string;
  /** Frame the goal was reached. */
  frame?: number;
  /** The search ran out of new places at this resolution: unsolved means unsolvable, as far as it can tell. */
  exhausted: boolean;
  /** Frames simulated, and distinct situations found. */
  explored: number;
  cells: number;
  /** How the search went back in time: "save" (World.save) or "replay" (from frame 0). */
  method: "save" | "replay";
  /** The closest the player came to a goal, when there is one. */
  closest?: { frame: number; distance: number; x: number; y: number; z?: number; inputs: string };
  /** Timing windows of each press in the solution (jumps and actions). */
  windows?: TimingWindow[];
}

interface Cell {
  key: string;
  frame: number;
  /** Decisions from frame 0: index into choices, frames held. */
  path: [number, number][];
  save?: WorldSave;
  chosen: number;
  distance: number;
}

const DEFAULT_BUDGET = 2_000_000;
/** Decisions in one exploration from a cell, and how often the last one is kept. */
const EXPLORE_DECISIONS = 12;
const REPEAT_CHANCE = 0.75;
/** Explorations without a new cell before the search calls the level exhausted. */
const EXHAUSTED_AFTER = 400;
const WINDOW_REACH = 30;
/** Frames the search spends at least on looking for a faster win after the first. */
const REFINE_MIN = 100_000;

export function solve(make: () => World, options: SolveOptions = {}): SolveResult {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const hold = options.hold ?? 6;
  const maxFrames = Math.round((options.maxSeconds ?? 120) * FPS);
  const isGoal = options.goal ?? ((w: World) => w.won);
  const random = mulberry32(options.seed ?? 1);

  let world = make();
  const method = world.canSave ? "save" : "replay";
  const player = findPlayer(world);
  if (!player) throw new Error("solve needs a player: an entity with platformer, topdown or character.");
  const playerId = player.id;
  const choices = options.choices ?? defaultChoices(player);
  const startDeaths = world.deaths;
  // Cells about half a player wide: 2D px, 3D metres.
  const quantum = world.dimensions === 3 ? 1 : 16;

  let explored = 0;
  const step = (input: ReadonlySet<Action>) => {
    world.step(input);
    explored++;
  };
  const sets = choices.map((c) => new Set(c) as ReadonlySet<Action>);
  const failed = () => world.lost || (!options.allowDeaths && world.deaths > startDeaths) || !world.get(playerId);

  const cells = new Map<string, Cell>();
  let closest: Cell | undefined;
  const enter = (path: [number, number][]): Cell | undefined => {
    const p = world.get(playerId);
    if (!p) return undefined;
    const key = cellKey(world, p, quantum);
    const distance = goalDistance(world, p);
    const known = cells.get(key);
    if (known && known.frame <= world.frame) return undefined;
    const cell: Cell = { key, frame: world.frame, path: path.slice(), save: method === "save" ? world.save() : undefined, chosen: known?.chosen ?? 0, distance };
    cells.set(key, cell);
    if (!closest || distance < closest.distance) closest = cell;
    return cell;
  };
  /** Puts the world back at a cell: restore its save, or replay its path on a fresh world. */
  const goTo = (cell: Cell) => {
    if (cell.save) return world.restore(cell.save);
    world = make();
    for (const [choice, frames] of cell.path) for (let i = 0; i < frames; i++) step(sets[choice]!);
  };

  enter([]);
  let win: { path: [number, number][]; frame: number } | undefined;
  /** After the first win, the search goes on this long for a faster one. */
  let refineUntil = Infinity;
  let sinceNew = 0;
  const startDistance = Math.max(1e-9, closest!.distance);

  while (explored < Math.min(budget, refineUntil) && !options.deadline?.()) {
    const cell = pick([...cells.values()], startDistance, random);
    if (win && cell.frame >= win.frame) {
      cell.chosen++;
      continue;
    }
    cell.chosen++;
    goTo(cell);
    const path = cell.path.slice();
    const weights = towardGoal(world, world.get(playerId)!, choices);
    let choice = weighted(weights, random);
    let grew = false;
    explore: for (let d = 0; d < EXPLORE_DECISIONS && world.frame < Math.min(maxFrames, win?.frame ?? Infinity); d++) {
      if (d > 0 && random() > REPEAT_CHANCE) choice = weighted(weights, random);
      for (let f = 0; f < hold; f++) {
        step(sets[choice]!);
        if (isGoal(world)) {
          extend(path, choice, f + 1);
          if (!win || world.frame < win.frame) {
            if (!win) refineUntil = explored + Math.max(REFINE_MIN, explored);
            win = { path, frame: world.frame };
          }
          break explore;
        }
        if (failed()) break explore;
      }
      extend(path, choice, hold);
      if (enter(path)) grew = true;
    }
    sinceNew = grew ? 0 : sinceNew + 1;
    if (sinceNew >= EXHAUSTED_AFTER) break;
  }

  const result: SolveResult = { solved: !!win, exhausted: !win && sinceNew >= EXHAUSTED_AFTER, explored, cells: cells.size, method };
  if (closest && Number.isFinite(closest.distance)) {
    goTo(closest);
    const p = world.get(playerId)!;
    result.closest = { frame: closest.frame, distance: round(closest.distance), x: round(p.transform.x), y: round(p.transform.y), ...(world.dimensions === 3 ? { z: round(p.transform.z) } : {}), inputs: format(closest.path, choices) };
  }
  if (!win) return result;

  const lost = (w: World) => w.lost || (!options.allowDeaths && w.deaths > startDeaths);
  const simple = simplify(make, win.path, sets, isGoal, lost, win.frame);
  const frames = expand(simple.path, sets);
  // Proof: the solution wins from a fresh world, with nothing but its inputs.
  const proof = make();
  for (const input of frames) proof.step(input);
  if (!isGoal(proof)) throw new Error("solve found inputs that didn't win when replayed: the simulation isn't deterministic.");
  result.inputs = format(simple.path, choices);
  result.frame = simple.frame;
  if (options.windows ?? true) result.windows = measureWindows(make, frames, isGoal, startDeaths, !!options.allowDeaths);
  return result;
}

/** Plays inputs on a world from a save near `from`, and says on which frame they won, if they did. */
class Trial {
  private readonly world: World;
  private readonly saves = new Map<number, WorldSave>();
  private readonly make: () => World;
  private readonly isGoal: (w: World) => boolean;
  private readonly lost: (w: World) => boolean;

  constructor(make: () => World, isGoal: (w: World) => boolean, lost: (w: World) => boolean) {
    this.make = make;
    this.isGoal = isGoal;
    this.lost = lost;
    this.world = make();
    this.initial = this.world.canSave ? this.world.save() : undefined;
  }

  private readonly initial: WorldSave | undefined;

  /** Saves along `frames` every 10 frames, so later trials of variations start close to them. */
  prepare(frames: readonly ReadonlySet<Action>[]): void {
    this.saves.clear();
    if (!this.initial) return;
    const w = this.world;
    w.restore(this.initial);
    this.saves.set(0, this.initial);
    for (let f = 0; f < frames.length; f++) {
      w.step(frames[f]!);
      if ((f + 1) % 10 === 0) this.saves.set(f + 1, w.save());
    }
  }

  /** The win frame of `frames`, which match the prepared inputs before `from`; undefined if they don't win by `limit`. */
  run(frames: readonly ReadonlySet<Action>[], from: number, limit: number): number | undefined {
    let w = this.world;
    let start = Math.floor(Math.max(0, from - 1) / 10) * 10;
    while (start > 0 && !this.saves.has(start)) start -= 10;
    const save = this.saves.get(start);
    if (save) w.restore(save);
    else {
      w = this.make();
      start = 0;
    }
    for (let f = start; f < limit; f++) {
      w.step(frames[f] ?? NOTHING);
      if (this.isGoal(w)) return w.frame;
      if (this.lost(w)) return undefined;
    }
    return undefined;
  }
}

/**
 * Makes a found solution read like a person's: each stretch tries the stretch before or after it,
 * or itself without the jump, and keeps the change when the run still wins as early. Fewer, longer
 * presses are easier to understand and to turn into a test.
 */
function simplify(make: () => World, path: [number, number][], sets: readonly ReadonlySet<Action>[], isGoal: (w: World) => boolean, lost: (w: World) => boolean, frame: number): { path: [number, number][]; frame: number } {
  const trial = new Trial(make, isGoal, lost);
  let best = path.slice();
  let bestFrame = frame;
  trial.prepare(expand(best, sets));
  const without = (choice: number, action: Action) => {
    const wanted = [...sets[choice]!].filter((a) => a !== action).sort().join("+");
    return sets.findIndex((s) => [...s].sort().join("+") === wanted);
  };
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < best.length; i++) {
      const [choice] = best[i]!;
      // The same stretch done like its neighbours, like most of the run, with one action fewer, or not at all.
      const candidates = [best[i - 1]?.[0], best[i + 1]?.[0], dominant(best), ...[...sets[choice]!].map((a) => without(choice, a)), -1].filter((c): c is number => c !== undefined && c !== choice && (c >= 0 || c === -1));
      const from = best.slice(0, i).reduce((sum, [, n]) => sum + n, 0);
      for (const candidate of new Set(candidates)) {
        const next = candidate === -1 ? best.filter((_, k) => k !== i) : best.map((s, k) => (k === i ? ([candidate, s[1]] as [number, number]) : s));
        if (next.length === 0) continue;
        const won = trial.run(expand(next, sets), from, bestFrame + 1);
        if (won === undefined || won > bestFrame) continue;
        const merged = merge(next);
        best = merged.slice(0, cut(merged, won));
        bestFrame = won;
        trial.prepare(expand(best, sets));
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return { path: best, frame: bestFrame };
}

/** The choice held for the most frames, ignoring jumps: the run's main direction. */
function dominant(path: [number, number][]): number | undefined {
  const frames = new Map<number, number>();
  for (const [choice, n] of path) frames.set(choice, (frames.get(choice) ?? 0) + n);
  return [...frames].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Joins neighbouring steps with the same choice. */
function merge(path: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [choice, n] of path) extend(out, choice, n);
  return out;
}

/** How many steps of `path` are needed to reach `frames`, the last one shortened to fit. */
function cut(path: [number, number][], frames: number): number {
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    total += path[i]![1];
    if (total >= frames) {
      path[i] = [path[i]![0], path[i]![1] - (total - frames)];
      return i + 1;
    }
  }
  return path.length;
}

/**
 * For each press in a solution, how many frames earlier or later it can come and still win, all
 * else equal. Uses saves along the solution, so each variation replays only from just before it.
 */
export function measureWindows(make: () => World, frames: readonly ReadonlySet<Action>[], isGoal: (w: World) => boolean, startDeaths = 0, allowDeaths = false): TimingWindow[] {
  const presses: { frame: number; action: Action; end: number }[] = [];
  for (let f = 0; f < frames.length; f++) {
    for (const action of frames[f]!) {
      if (action !== "jump" && action !== "action") continue;
      if (f > 0 && frames[f - 1]!.has(action)) continue;
      let end = f;
      while (end < frames.length && frames[end]!.has(action)) end++;
      presses.push({ frame: f, action, end });
    }
  }
  if (presses.length === 0) return [];
  const base = make();
  const canSave = base.canSave;
  // A save every 10 frames along the solution.
  const saves = new Map<number, WorldSave>();
  if (canSave) {
    for (let f = 0; f <= frames.length; f++) {
      if (f % 10 === 0) saves.set(f, base.save());
      if (f < frames.length) base.step(frames[f]!);
    }
  }
  const limit = frames.length + 3 * FPS;
  const wins = (variant: readonly ReadonlySet<Action>[], from: number): boolean => {
    let world: World;
    let start = 0;
    if (canSave) {
      start = Math.floor(Math.max(0, from - 1) / 10) * 10;
      world = base;
      world.restore(saves.get(start)!);
    } else {
      world = make();
    }
    for (let f = start; f < limit; f++) {
      world.step(variant[f] ?? NOTHING);
      if (isGoal(world)) return true;
      if (world.lost || (!allowDeaths && world.deaths > startDeaths)) return false;
    }
    return false;
  };
  return presses.map(({ frame, action, end }) => {
    // This press moved by `by` frames; every other press stays where it was.
    const shifted = (by: number) => {
      const variant = frames.map((set, f) => {
        const copy = new Set(set);
        if (f >= frame && f < end) copy.delete(action);
        return copy;
      });
      for (let f = frame + by; f < end + by; f++) if (f >= 0) (variant[f] ??= new Set()).add(action);
      return variant;
    };
    let early = 0;
    while (early < WINDOW_REACH && frame - early - 1 >= 0 && wins(shifted(-(early + 1)), frame - early - 1)) early++;
    let late = 0;
    while (late < WINDOW_REACH && wins(shifted(late + 1), frame)) late++;
    return { frame, action, early, late, width: early + late + 1 };
  });
}

const NOTHING: ReadonlySet<Action> = new Set();

function findPlayer(world: World): Entity | undefined {
  return world.entities.find((e) => e.platformer || e.character || (e.topdown && e.body?.type !== "static"));
}

/** What a player can do at once, by how it is controlled. */
function defaultChoices(player: Entity): Action[][] {
  if (player.platformer) return [[], ["right"], ["left"], ["jump"], ["right", "jump"], ["left", "jump"]];
  const moves: Action[][] = [[], ["up"], ["down"], ["left"], ["right"], ["up", "left"], ["up", "right"], ["down", "left"], ["down", "right"]];
  if (player.character) return [...moves, ...moves.map((m) => [...m, "jump" as Action])];
  return [...moves, ["action"]];
}

function cellKey(world: World, p: Entity, q: number): string {
  const t = p.transform;
  const parts = [Math.floor(t.x / q), Math.floor(t.y / q)];
  if (world.dimensions === 3) parts.push(Math.floor(t.z / q));
  let states = "";
  for (const e of world.entities) if (Object.keys(e.state).length > 0) states += `${e.id}=${JSON.stringify(e.state)};`;
  return `${parts.join(",")}|${p.body?.grounded ? 1 : 0}|${world.score}|${world.entities.length}|${hash(states)}`;
}

function goalDistance(world: World, p: Entity): number {
  let best = Infinity;
  for (const e of world.entities) {
    if (!e.goal) continue;
    const dx = e.transform.x - p.transform.x;
    const dy = e.transform.y - p.transform.y;
    const dz = e.transform.z - p.transform.z;
    best = Math.min(best, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return best;
}

/**
 * How likely each choice is: every one stays possible (a key may lie behind the player), but
 * moving toward the nearest goal is picked about three times as often as moving away.
 */
function towardGoal(world: World, p: Entity, choices: readonly (readonly Action[])[]): number[] {
  let goal: Entity | undefined;
  let best = Infinity;
  for (const e of world.entities) {
    if (!e.goal) continue;
    const d = Math.hypot(e.transform.x - p.transform.x, e.transform.y - p.transform.y, e.transform.z - p.transform.z);
    if (d < best) [best, goal] = [d, e];
  }
  if (!goal || best === 0) return choices.map(() => 1);
  // Screen directions: 2D +x right; 3D up walks to -z.
  const dx = (goal.transform.x - p.transform.x) / best;
  const dz = world.dimensions === 3 ? (goal.transform.z - p.transform.z) / best : 0;
  return choices.map((actions) => {
    const mx = (actions.includes("right") ? 1 : 0) - (actions.includes("left") ? 1 : 0);
    const mz = world.dimensions === 3 ? (actions.includes("down") ? 1 : 0) - (actions.includes("up") ? 1 : 0) : 0;
    const length = Math.hypot(mx, mz);
    const along = length === 0 ? 0 : (mx * dx + mz * dz) / length;
    return 2 + 1.5 * along;
  });
}

function weighted(weights: readonly number[], random: () => number): number {
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** Cells tried less, and closer to a goal, are picked more often. */
function pick(cells: Cell[], startDistance: number, random: () => number): Cell {
  let total = 0;
  const weights = cells.map((c) => {
    const progress = Number.isFinite(c.distance) ? Math.max(0, 1 - c.distance / startDistance) : 0;
    const w = (1 / Math.sqrt(1 + c.chosen)) * (1 + 4 * progress * progress);
    total += w;
    return w;
  });
  let r = random() * total;
  for (let i = 0; i < cells.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return cells[i]!;
  }
  return cells[cells.length - 1]!;
}

/** Adds frames to a path. Steps are replaced, never changed: cells share them. */
function extend(path: [number, number][], choice: number, frames: number): void {
  const last = path[path.length - 1];
  if (last && last[0] === choice) path[path.length - 1] = [choice, last[1] + frames];
  else path.push([choice, frames]);
}

function expand(path: [number, number][], sets: readonly ReadonlySet<Action>[]): ReadonlySet<Action>[] {
  const frames: ReadonlySet<Action>[] = [];
  for (const [choice, n] of path) for (let i = 0; i < n; i++) frames.push(sets[choice]!);
  return frames;
}

/** A path as `--inputs` text: seconds when they are exact tenths, frames ("7f") otherwise. */
export function format(path: [number, number][], choices: readonly (readonly Action[])[]): string {
  return path
    .map(([choice, frames]) => {
      const name = choices[choice]!.length > 0 ? choices[choice]!.join("+") : "wait";
      const duration = frames % 6 === 0 ? `${frames / FPS}s` : `${frames}f`;
      return `${name}:${duration}`;
    })
    .join(", ");
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
