/**
 * The player's progress: what a run has achieved, as plain JSON a browser keeps between visits.
 * It is not a snapshot of the world (that is `World.save`): it says which scene to start and what
 * the player carries into it, so Continue starts that scene again as moving on to it would have,
 * at the last checkpoint when there is one.
 */

/** A flag's value: story state such as "talked to the smith" or "chose to help". */
export type FlagValue = number | string | boolean;

export interface Progress {
  /** The format, so a later Ludra can read what an older one saved. */
  v: 1;
  /** The scene's path in the project, e.g. "scenes/level-2.scene.json". */
  scene: string;
  score: number;
  deaths: number;
  /** Lives left; left out when the game has unlimited retries. */
  lives?: number;
  items: Record<string, number>;
  flags: Record<string, FlagValue>;
  /** The id of the checkpoint to start at, instead of the scene's own start. */
  checkpoint?: string;
}

/** What a run carries into a scene: the same fields `WorldOptions.carry` takes. */
export interface ProgressCarry {
  score?: number;
  deaths?: number;
  lives?: number;
  items?: Record<string, number>;
  flags?: Record<string, FlagValue>;
}

/** What `encodeProgress` reads from a world. Items and flags are there once the game has them. */
export interface ProgressSource {
  score: number;
  deaths: number;
  lives: number | undefined;
  readonly items?: Record<string, number>;
  readonly flags?: Record<string, FlagValue>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Progress from a world's counters, in a scene, optionally at a checkpoint. */
export function encodeProgress(world: ProgressSource, scene: string, checkpoint?: string): Progress {
  const progress: Progress = {
    v: 1,
    scene,
    score: world.score,
    deaths: world.deaths,
    items: { ...(world.items ?? {}) },
    flags: { ...(world.flags ?? {}) },
  };
  if (world.lives !== undefined) progress.lives = world.lives;
  if (checkpoint !== undefined) progress.checkpoint = checkpoint;
  return progress;
}

/** Same as `encodeProgress`, from a carry object (what a scene started with). */
export function progressFromCarry(carry: ProgressCarry | undefined, scene: string, checkpoint?: string): Progress {
  return encodeProgress({ score: carry?.score ?? 0, deaths: carry?.deaths ?? 0, lives: carry?.lives, items: carry?.items, flags: carry?.flags }, scene, checkpoint);
}

/** What a world hands on to the next scene: its counters, items and flags. */
export function carryFrom(world: ProgressSource): ProgressCarry {
  const carry: ProgressCarry = { score: world.score, deaths: world.deaths, lives: world.lives };
  if (world.items) carry.items = { ...world.items };
  if (world.flags) carry.flags = { ...world.flags };
  return carry;
}

/** What a saved run starts its scene with. */
export function progressCarry(progress: Progress): ProgressCarry {
  const carry: ProgressCarry = { score: progress.score, deaths: progress.deaths, items: { ...progress.items }, flags: { ...progress.flags } };
  if (progress.lives !== undefined) carry.lives = progress.lives;
  return carry;
}

export type DecodedProgress = { ok: true; progress: Progress } | { ok: false; error: string };

/**
 * Reads saved progress (a JSON string or an already parsed value) and checks every field, so a
 * damaged or hand-edited save is turned away with a reason instead of breaking the game.
 */
export function decodeProgress(input: unknown): DecodedProgress {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, error: "it isn't JSON" };
    }
  }
  if (!isRecord(raw)) return { ok: false, error: "it isn't an object" };
  if (raw.v !== 1) return { ok: false, error: `it is version ${JSON.stringify(raw.v)}, and this Ludra reads version 1` };
  if (typeof raw.scene !== "string" || raw.scene === "") return { ok: false, error: "scene must be a scene path" };
  for (const key of ["score", "deaths"] as const) if (!isCount(raw[key])) return { ok: false, error: `${key} must be a number` };
  if (raw.lives !== undefined && !isCount(raw.lives)) return { ok: false, error: "lives must be a number" };
  const items = raw.items ?? {};
  if (!isRecord(items) || !Object.values(items).every(isCount)) return { ok: false, error: "items must map names to numbers" };
  const flags = raw.flags ?? {};
  if (!isRecord(flags) || !Object.values(flags).every((f) => isCount(f) || typeof f === "string" || typeof f === "boolean")) {
    return { ok: false, error: "flags must map names to numbers, text or true/false" };
  }
  if (raw.checkpoint !== undefined && (typeof raw.checkpoint !== "string" || raw.checkpoint === "")) return { ok: false, error: "checkpoint must be an entity id" };
  const progress: Progress = {
    v: 1,
    scene: raw.scene,
    score: raw.score as number,
    deaths: raw.deaths as number,
    items: { ...(items as Record<string, number>) },
    flags: { ...(flags as Record<string, FlagValue>) },
  };
  if (raw.lives !== undefined) progress.lives = raw.lives as number;
  if (raw.checkpoint !== undefined) progress.checkpoint = raw.checkpoint as string;
  return { ok: true, progress };
}

/** Where a browser keeps the progress of a game, by its name in ludra.json. */
export function progressKey(game: string): string {
  return `ludra:progress:${game}`;
}

/** Saved progress, kept somewhere: localStorage in a browser, memory in tests. */
export interface ProgressStore {
  load(): Progress | undefined;
  save(progress: Progress): void;
  clear(): void;
}

/** A store in memory. */
export function memoryProgressStore(initial?: Progress): ProgressStore {
  let kept = initial;
  return {
    load: () => kept,
    save: (progress) => (kept = progress),
    clear: () => (kept = undefined),
  };
}

/**
 * A store in the browser's localStorage. A save that can't be read is dropped, with a warning,
 * and a storage that refuses (private mode, full) only means the game isn't saved.
 */
export function localProgressStore(game: string, storage: Storage | undefined = globalThis.localStorage): ProgressStore {
  const key = progressKey(game);
  return {
    load: () => {
      let text: string | null = null;
      try {
        text = storage?.getItem(key) ?? null;
      } catch {
        return undefined;
      }
      if (text === null) return undefined;
      const decoded = decodeProgress(text);
      if (decoded.ok) return decoded.progress;
      console.warn(`[ludra] the saved game can't be read (${decoded.error}), so the game starts fresh.`);
      return undefined;
    },
    save: (progress) => {
      try {
        storage?.setItem(key, JSON.stringify(progress));
      } catch (err) {
        console.warn("[ludra] could not save the game:", err);
      }
    },
    clear: () => {
      try {
        storage?.removeItem(key);
      } catch {
        // Nothing kept, nothing to clear.
      }
    },
  };
}
