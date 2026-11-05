import { ACTIONS, type Action } from "./types.ts";
import type { World } from "./world.ts";
import { findPlayer } from "./solve.ts";

/** What a player can say about a moment while playing. */
export const MARK_KINDS = ["hard", "boring", "confusing", "great", "note"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

/** Words for each mark, in reports and on screen. */
export const MARK_LABELS: Record<MarkKind, string> = {
  hard: "too hard",
  boring: "boring",
  confusing: "confusing",
  great: "love this",
  note: "note",
};

export interface Place {
  x: number;
  y: number;
  z?: number;
}

/** A moment the player marked. `frame` is when the key was pressed, a little after the feeling. */
export interface Mark extends Partial<Place> {
  frame: number;
  kind: MarkKind;
  /** The player's own words, for a note. */
  text?: string;
}

export interface RecordedDeath extends Place {
  frame: number;
  /** "fall", or the id of what killed the player. */
  cause: string;
}

export type TakeEnd =
  /** The level was completed. */
  | "won"
  /** Out of lives. */
  | "lost"
  /** A world.goto moved to another scene. */
  | "moved"
  /** The player pressed R. */
  | "restarted"
  /** The player closed or reloaded the page: where they stopped playing. */
  | "stopped"
  /** A script threw. */
  | "crashed";

/**
 * One run of one scene: from when its World was made until it ended. A take holds everything
 * needed to play it again, because a World only ever advances through its inputs.
 */
export interface Take {
  /** Path of the scene, relative to the project. */
  scene: string;
  /** Identifies the scene and scripts this was played on. See the CLI's `gameHash`. */
  version: string;
  /** What the game carried in from the scene before. */
  carry?: { score: number; deaths: number; lives?: number };
  /** The inputs, as an input script in whole frames. */
  inputs: string;
  frames: number;
  /** undefined while the take is still being played. */
  end?: TakeEnd;
  /** The script error, for a crashed take. */
  error?: string;
  /** World fingerprints every `CHECK_EVERY` frames, then the last frame, to tell where a replay leaves the original. */
  checks: string[];
  score: number;
  deathCount: number;
  lives?: number;
  /** The id of the player entity. */
  player?: string;
  /** Where the player was on the last frame. */
  last?: Place;
  deaths: RecordedDeath[];
  marks: Mark[];
}

export interface Recording {
  version: 1;
  /** Stable for a session, and the recording's file name. */
  session: string;
  /** The game's name. */
  game: string;
  /** ISO time the session started. */
  started: string;
  takes: Take[];
}

/** One fingerprint per this many frames (5 s), so a replay can say roughly when it left the original. */
export const CHECK_EVERY = 300;

/** A short hash of everything a test can see of the world. Equal on any machine for an equal world. */
export function fingerprint(world: World): string {
  const text = JSON.stringify(world.snapshot());
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Where the player is, in the form recordings keep it. */
function placeOf(world: World): Place | undefined {
  const player = findPlayer(world);
  if (!player) return undefined;
  const { x, y, z } = player.transform;
  return world.dimensions === 3 ? { x, y, z } : { x, y };
}

export interface RecorderOptions {
  session: string;
  game: string;
  /** The entry scene's path: a world started without a path is on this one. */
  entry: string;
  /** The version of a scene, as `Take.version`. */
  version: (scene: string) => string;
  /** Called with a take to keep. Called again with the same index as the take grows. */
  save: (recording: Omit<Recording, "takes">, index: number, take: Take) => void;
  /** Keeps an ISO time out of the simulation's way. */
  now: () => string;
}

/**
 * Writes down a person's session as `startGame` plays it. It only reads the world. The inputs
 * are the ones the world really stepped on, including a tap shorter than a frame, so playing a
 * take again headlessly gives the same run, frame for frame.
 */
export class Recorder {
  private readonly options: RecorderOptions;
  private started: string | undefined;
  private index = -1;
  private take: Take | undefined;
  /** Input runs of the take being recorded. */
  private runKey = "";
  private runFrames = 0;
  private seenDeaths = 0;
  private played = false;
  /** The world of the take being recorded. */
  private world: World | undefined;

  constructor(options: RecorderOptions) {
    this.options = options;
  }

  /** A new World started. Ends the take before it, as `restarted` unless it already ended. */
  begin(world: World, scene: string | undefined, carry?: { score: number; deaths: number; lives: number | undefined }): void {
    if (this.world) this.end(this.world, "restarted");
    const path = scene ?? this.options.entry;
    this.index++;
    this.take = {
      scene: path,
      version: this.options.version(path),
      carry: carry ? { score: carry.score, deaths: carry.deaths, ...(carry.lives === undefined ? {} : { lives: carry.lives }) } : undefined,
      inputs: "",
      frames: 0,
      checks: [],
      score: world.score,
      deathCount: world.deaths,
      player: findPlayer(world)?.id,
      deaths: [],
      marks: [],
    };
    this.runKey = "";
    this.runFrames = 0;
    this.seenDeaths = 0;
    this.world = world;
  }

  /** The world just stepped on `input`. Frames after the world is over decide nothing, so they aren't kept. */
  step(world: World, input: ReadonlySet<Action>): void {
    const take = this.take;
    if (!take || take.end) return;
    this.addFrame(take, input);
    this.observe(world, take);
    if (take.frames % CHECK_EVERY === 0) take.checks.push(fingerprint(world));
    if (world.over) this.end(world, world.won ? "won" : world.lost ? "lost" : "moved");
  }

  /** A script threw during the step that this frame was. */
  crash(world: World, input: ReadonlySet<Action>, error: string): void {
    const take = this.take;
    if (!take || take.end) return;
    this.addFrame(take, input);
    take.error = error;
    this.played = true;
    this.finish(world, take, "crashed", false);
  }

  /** Remembers what a person said about now. After a take ends, the mark belongs to its last frame. */
  mark(world: World, kind: MarkKind, text?: string): void {
    const take = this.take;
    if (!take) return;
    take.marks.push({ frame: take.frames, kind, ...(text ? { text } : {}), ...(take.end ? take.last : placeOf(world)) });
    this.played = true;
    this.send();
  }

  /** Ends the take being recorded, if there is one. */
  end(world: World, reason: TakeEnd): void {
    const take = this.take;
    if (!take || take.end) return;
    if (take.frames === 0 && take.marks.length === 0) {
      // Nothing happened in it, so there is nothing to keep.
      this.index--;
      this.take = undefined;
      return;
    }
    this.finish(world, take, reason, true);
  }

  /** Sends what has been played so far: the take is safe if the page dies. */
  flush(): void {
    this.send();
  }

  /** The page is going away: ends the take where the player stopped. */
  stop(): void {
    if (this.world) this.end(this.world, "stopped");
  }

  private finish(world: World, take: Take, reason: TakeEnd, check: boolean): void {
    this.closeRun(take);
    take.end = reason;
    this.observe(world, take);
    // A crash leaves the world half way through a step: its fingerprint proves nothing.
    if (check && take.frames % CHECK_EVERY !== 0) take.checks.push(fingerprint(world));
    this.send();
  }

  private observe(world: World, take: Take): void {
    for (const event of world.events.slice(this.seenDeaths)) {
      if (event.type !== "die") continue;
      take.deaths.push({ frame: event.frame, cause: event.cause, x: event.x, y: event.y, ...(event.z === undefined ? {} : { z: event.z }) });
    }
    this.seenDeaths = world.events.length;
    take.score = world.score;
    take.deathCount = world.deaths;
    if (world.lives === undefined) delete take.lives;
    else take.lives = world.lives;
    const place = placeOf(world);
    if (place) take.last = place;
  }

  private addFrame(take: Take, input: ReadonlySet<Action>): void {
    const key = ACTIONS.filter((action) => input.has(action)).join("+") || "wait";
    if (key !== "wait") this.played = true;
    if (key === this.runKey) this.runFrames++;
    else {
      this.closeRun(take);
      this.runKey = key;
      this.runFrames = 1;
    }
    take.frames++;
  }

  /** Adds the run of equal inputs so far to the take's script. */
  private closeRun(take: Take): void {
    if (this.runFrames === 0) return;
    take.inputs += `${take.inputs ? ", " : ""}${this.runKey}:${this.runFrames}f`;
    this.runFrames = 0;
    this.runKey = "";
  }

  private send(): void {
    const take = this.take;
    // A session nobody played isn't a session: no file for a page left open.
    if (!take || !this.played) return;
    this.started ??= this.options.now();
    const partial = !take.end && this.runFrames > 0;
    const sent = partial ? { ...take, inputs: `${take.inputs}${take.inputs ? ", " : ""}${this.runKey}:${this.runFrames}f` } : take;
    this.options.save({ version: 1, session: this.options.session, game: this.options.game, started: this.started }, this.index, sent);
  }
}
