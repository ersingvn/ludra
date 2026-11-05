import { InputScript } from "./input.ts";
import { ScriptError } from "./script.ts";
import { defaultChoices, extend, findPlayer, mulberry32, placeKey, solve } from "./solve.ts";
import { FPS } from "./time.ts";
import type { Action } from "./types.ts";
import type { Entity, World } from "./world.ts";

/**
 * `fuzz` plays a game many times with random inputs, the way a careless player would, and reports
 * what goes wrong: scripts that crash (with the inputs that make them), places the player can get
 * into but never out of (softlocks), and where and how players die. Every session is seeded, so a
 * finding comes with inputs that reproduce it exactly.
 */

export interface FuzzOptions {
  /** Random sessions to play. Default 200. */
  sessions?: number;
  /** Longest session, in seconds. Default 60. */
  seconds?: number;
  /**
   * Most frames simulated in all, counting random sessions and the searches behind the softlock
   * checks. Unlike a deadline, it stops at the same place on a busy machine as on an idle one, so
   * the findings don't depend on load. Default: no limit.
   */
  work?: number;
  /** Returns true when time is up. Results then depend on how fast the machine is: prefer `work`. */
  deadline?: () => boolean;
  /** Seeds the random inputs. Default 1. */
  seed?: number;
  /** Look for softlocks: from each new place, can the game still be won? Default true when the scene has a goal. */
  softlocks?: boolean;
  /** Frames the softlock check may search from one place before it gives up (and reports nothing). Default 60,000. */
  checkBudget?: number;
  /** The action sets to press. Default: from the player's controller. */
  choices?: readonly (readonly Action[])[];
}

export interface FuzzFinding {
  /** Inputs from frame 0 that reproduce it. */
  inputs: string;
  frame: number;
  x: number;
  y: number;
  z?: number;
}

export interface FuzzResult {
  sessions: number;
  frames: number;
  /** Sessions that reached a goal by chance. */
  wins: number;
  /** Distinct places the player reached. */
  cells: number;
  /** Script errors, one per distinct message. */
  crashes: (FuzzFinding & { message: string })[];
  /** Places from which no way to win exists (the search ran out of new places), one per area. */
  softlocks: FuzzFinding[];
  /** Deaths by cause, with the places they happen most. */
  deaths: { cause: string; count: number; places: { x: number; y: number; z?: number; count: number }[] }[];
  /**
   * Whether the level can be won from the start at all (a quick solve first): false means it can't,
   * and softlocks aren't looked for. Undefined when that search ran out of budget.
   */
  winnable?: boolean;
  /** True when the deadline cut the sessions short. */
  outOfTime: boolean;
  /** True when the `work` budget ran out before every session was played. */
  outOfWork: boolean;
  /** Frames simulated in all: sessions plus softlock searches. */
  work: number;
}

export function fuzz(make: () => World, options: FuzzOptions = {}): FuzzResult {
  const sessions = options.sessions ?? 200;
  const maxFrames = Math.round((options.seconds ?? 60) * FPS);
  const random = mulberry32(options.seed ?? 1);
  const probe = make();
  const player = findPlayer(probe);
  if (!player) throw new Error("fuzz needs a player: an entity with platformer, topdown or character.");
  const playerId = player.id;
  const choices = options.choices ?? defaultChoices(player);
  const sets = choices.map((c) => new Set(c) as ReadonlySet<Action>);
  const hasGoal = probe.entities.some((e) => e.goal);
  let checkSoftlocks = (options.softlocks ?? hasGoal) && probe.canSave;
  let winnable: boolean | undefined;
  const work = options.work ?? Infinity;
  let spent = 0;
  /** A search's budget: its own, or what is left of `work` if that is less. */
  const allow = (budget: number) => Math.max(0, Math.min(budget, work - spent));
  if (checkSoftlocks) {
    // A softlock is a place the game can't be won from: that only means something if it can be won at all.
    const start = solve(make, { quick: true, budget: allow((options.checkBudget ?? 60_000) * 5), deadline: options.deadline });
    spent += start.explored;
    winnable = start.solved ? true : start.exhausted ? false : undefined;
    checkSoftlocks = start.solved;
  }
  const quantum = probe.dimensions === 3 ? 1 : 16;

  const result: FuzzResult = { sessions: 0, frames: 0, wins: 0, cells: 0, crashes: [], softlocks: [], deaths: [], ...(winnable !== undefined ? { winnable } : {}), outOfTime: false, outOfWork: false, work: 0 };
  const seen = new Set<string>();
  const checked = new Set<string>();
  /** Every place inside a softlock found so far, so one trap is reported once. */
  const trapped = new Set<string>();
  /** Places a win was found from (by a check or a lucky session): no need to check them again. */
  const free = new Set<string>();
  const crashMessages = new Set<string>();
  const deaths = new Map<string, Map<string, { x: number; y: number; z?: number; count: number }>>();

  for (let s = 0; s < sessions; s++) {
    if (options.deadline?.()) {
      result.outOfTime = true;
      break;
    }
    if (spent >= work) {
      result.outOfWork = true;
      break;
    }
    result.sessions++;
    const world = make();
    const path: [number, number][] = [];
    let eventsSeen = 0;
    try {
      while (world.frame < maxFrames && !world.over && spent < work && !options.deadline?.()) {
        // Hold one choice for 0.05 to 0.5 s, like someone mashing keys.
        const choice = Math.floor(random() * sets.length);
        const hold = 3 + Math.floor(random() * 28);
        // Recorded before it is played, so a crash halfway through still has the inputs that led to it.
        extend(path, choice, hold);
        for (let f = 0; f < hold && !world.over; f++) {
          world.step(sets[choice]!);
          result.frames++;
          spent++;
        }
        for (; eventsSeen < world.events.length; eventsSeen++) {
          const event = world.events[eventsSeen]!;
          if (event.type !== "die") continue;
          const at = { x: snap(event.x, quantum), y: snap(event.y, quantum), ...(world.dimensions === 3 ? { z: snap(event.z ?? 0, quantum) } : {}) };
          const byPlace = deaths.get(event.cause) ?? new Map();
          const key = `${at.x},${at.y},${at.z ?? ""}`;
          byPlace.set(key, { ...at, count: (byPlace.get(key)?.count ?? 0) + 1 });
          deaths.set(event.cause, byPlace);
        }
        if (world.won) result.wins++;
        const p = world.get(playerId);
        if (!p || world.over) break;
        const key = cellOf(world, p, quantum);
        seen.add(key);
        if (!checkSoftlocks || checked.has(key) || !p.body?.grounded) continue;
        checked.add(key);
        const place = placeKey(p, quantum);
        if (trapped.has(place) || free.has(place)) continue;
        const check = isStuck(make, world, allow(options.checkBudget ?? 60_000), trapped, free, quantum, options.deadline);
        spent += check.explored;
        if (check.stuck) result.softlocks.push(finding(world, p, path, choices));
      }
    } catch (err) {
      if (!(err instanceof ScriptError)) throw err;
      const cause = err.cause instanceof Error ? err.cause.message : err.message.replace(/frame \d+/, "");
      const crashKey = `${err.src}|${err.hook}|${cause}`;
      if (!crashMessages.has(crashKey)) {
        crashMessages.add(crashKey);
        const p = world.get(playerId) ?? player;
        result.crashes.push({ ...finding(world, p, path, choices), message: err.message });
      }
    }
  }

  result.cells = seen.size;
  result.work = spent;
  result.deaths = [...deaths]
    .map(([cause, places]) => ({ cause, count: [...places.values()].reduce((sum, p) => sum + p.count, 0), places: [...places.values()].sort((a, b) => b.count - a.count).slice(0, 5) }))
    .sort((a, b) => b.count - a.count);
  return result;
}

/**
 * True when the game can't be won from this moment: a quick search from a save of it runs out of
 * new places without a win. A search that runs out of budget proves nothing, so it says false.
 */
function isStuck(make: () => World, world: World, budget: number, trapped: Set<string>, free: Set<string>, quantum: number, deadline?: () => boolean): { stuck: boolean; explored: number } {
  if (budget <= 0) return { stuck: false, explored: 0 };
  const save = world.save();
  const from = () => {
    const w = make();
    w.restore(save);
    return w;
  };
  const places = new Set<string>();
  const answer = solve(from, { quick: true, budget, places, placeSize: quantum, deadline });
  if (answer.solved && answer.inputs) {
    // Every place on the way to that win can reach it too.
    const w = from();
    const script = InputScript.parse(answer.inputs);
    const id = findPlayer(w)?.id;
    while (w.frame - world.frame < script.totalFrames && !w.over) {
      w.step(script.at(w.frame - world.frame));
      const p = id ? w.get(id) : undefined;
      if (p) free.add(placeKey(p, quantum));
    }
  }
  if (answer.solved || !answer.exhausted) return { stuck: false, explored: answer.explored };
  for (const place of places) trapped.add(place);
  return { stuck: true, explored: answer.explored };
}

function finding(world: World, p: Entity, path: [number, number][], choices: readonly (readonly Action[])[]): FuzzFinding {
  const round = (v: number) => Math.round(v * 100) / 100;
  // Only the inputs that were played: the last stretch may have been cut short by the event.
  const inputs: [number, number][] = [];
  let left = world.frame;
  for (const [choice, n] of path) {
    if (left <= 0) break;
    inputs.push([choice, Math.min(n, left)]);
    left -= n;
  }
  return {
    inputs: inputs.map(([c, n]) => `${choices[c]!.length > 0 ? choices[c]!.join("+") : "wait"}:${n % 6 === 0 ? `${n / FPS}s` : `${n}f`}`).join(", "),
    frame: world.frame,
    x: round(p.transform.x),
    y: round(p.transform.y),
    ...(world.dimensions === 3 ? { z: round(p.transform.z) } : {}),
  };
}

function cellOf(world: World, p: Entity, q: number): string {
  const t = p.transform;
  return [Math.floor(t.x / q), Math.floor(t.y / q), world.dimensions === 3 ? Math.floor(t.z / q) : "", world.score, world.entities.length].join(",");
}

function snap(v: number, q: number): number {
  return Math.round(v / q) * q;
}
