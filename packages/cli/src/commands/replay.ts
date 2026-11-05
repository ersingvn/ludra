import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CHECK_EVERY, fingerprint, InputScript, MARK_LABELS, runTest, World, type Recording, type Take, type TestCase } from "@ludra/core";
import { fixed, pad, paint } from "../format.ts";
import { CliError, loadGame, type Game, type Project } from "../project.ts";
import { findRecording, gameHash, readRecording } from "../recordings.ts";
import { play } from "./play.ts";
import { positiveInteger } from "./solve.ts";

export interface ReplayOptions {
  take?: string;
  mark?: string;
  test?: boolean;
  sheet?: string;
  screenshot?: string;
  debug?: boolean;
  out?: string;
  json?: boolean;
}

/** How a take goes when it is played again on the game as it is now. */
export interface TakeReplay {
  /**
   * same: frame for frame what the player saw. changed: the game changed since, and so did the run.
   * diverged: the same game played differently, so something isn't deterministic. gone: the scene no
   * longer loads.
   */
  status: "same" | "changed" | "diverged" | "gone";
  /** True when the take was played on another version of the scene or scripts. */
  otherVersion: boolean;
  /** The frames between which the run left the original. */
  leftBetween?: [number, number];
  /** What differs at the end, in words: empty when only the details moved. */
  differences: string[];
  /** Why the scene can't be played. */
  problem?: string;
}

/** Plays a take on a game, comparing with what was written down at the time. */
function playAgain(take: Take, game: Game, version: string): TakeReplay {
  const otherVersion = take.version !== version;
  const script = InputScript.parse(take.inputs);
  let world: World;
  let error: string | undefined;
  let leftBetween: [number, number] | undefined;
  let checked = 0;
  const compare = (frame: number, check: string | undefined) => {
    if (check !== undefined && !leftBetween && fingerprint(world) !== check) leftBetween = [checked, frame];
    checked = frame;
  };
  try {
    world = new World(game.scene, { scripts: game.scripts, carry: take.carry });
  } catch (err) {
    return { status: otherVersion ? "changed" : "diverged", otherVersion, differences: [`the scene now fails to start: ${(err as Error).message}`] };
  }
  const regular = Math.floor(take.frames / CHECK_EVERY);
  for (let frame = 0; frame < take.frames; frame++) {
    try {
      world.step(script.at(frame));
    } catch (err) {
      error = (err as Error).message;
      break;
    }
    const next = frame + 1;
    if (next % CHECK_EVERY === 0) compare(next, take.checks[next / CHECK_EVERY - 1]);
    else if (next === take.frames) compare(next, take.checks[regular]);
  }

  const differences: string[] = [];
  const crashed = take.end === "crashed";
  if (crashed && !error) differences.push("the script error no longer happens");
  if (!crashed && error) differences.push(`it now crashes: ${error}`);
  if (!error) {
    const was = take.end === "won" ? "won" : take.end === "lost" ? "lost" : "not finished";
    const now = world.won ? "won" : world.lost ? "lost" : "not finished";
    if (was !== now) differences.push(`it was ${was}, now ${now}`);
    if (world.score !== take.score) differences.push(`score ${take.score} → ${world.score}`);
    if (world.deaths !== take.deathCount) differences.push(`deaths ${take.deathCount} → ${world.deaths}`);
  }
  const same = !leftBetween && differences.length === 0;
  return { status: same ? "same" : otherVersion ? "changed" : "diverged", otherVersion, leftBetween, differences };
}

/** `ludra replay`: plays a recording again, shows it, and turns it into tests. Exit 1 when a take no longer plays out the same. */
export async function replay(target: string, options: ReplayOptions): Promise<number> {
  const { project, file } = findRecording(target);
  const recording = readRecording(file);
  if (recording.takes.length === 0) throw new CliError(`${file} has no takes.`);
  const numbers = chosenTakes(recording, options);

  if (options.mark !== undefined || options.sheet || options.screenshot) return showTake(project, recording, numbers, options);

  const games = new Map<string, Game | undefined>();
  const replays = new Map<number, TakeReplay>();
  for (const n of numbers) {
    const take = recording.takes[n - 1]!;
    if (!games.has(take.scene)) games.set(take.scene, (await loadGame(project, take.scene)).game);
    const game = games.get(take.scene);
    replays.set(n, game ? playAgain(take, game, gameHash(project, take.scene)) : { status: "gone", otherVersion: true, differences: [], problem: `${take.scene} doesn't load` });
  }
  const written = options.test ? await writeTests(project, recording, numbers, replays, games, options.take !== undefined) : undefined;
  const ok = [...replays.values()].every((r) => r.status === "same");

  if (options.json) {
    const takes = numbers.map((n) => ({ take: n, ...recording.takes[n - 1]!, inputs: undefined, checks: undefined, replay: replays.get(n) }));
    console.log(JSON.stringify({ ok, session: recording.session, game: recording.game, started: recording.started, takes, written }, null, 2));
    return ok ? 0 : 1;
  }

  const seconds = recording.takes.reduce((sum, take) => sum + take.frames / 60, 0);
  console.log(paint("bold", `▶ ${recording.game}: ${plural(recording.takes.length, "take")}, ${fixed(seconds, 1)}s of play`) + paint("dim", `  ${shown(file)}, ${recording.started}`));
  for (const n of numbers) printTake(n, recording.takes[n - 1]!, replays.get(n)!);
  if (written) printWritten(written);
  if (!options.test && !ok && [...replays.values()].some((r) => r.status === "diverged")) {
    console.log(paint("dim", "\nSame game, different run: look for Math.random, Date or a module-level variable in a script, or a recording made in a browser other than Chromium."));
  }
  return ok ? 0 : 1;
}

function chosenTakes(recording: Recording, options: ReplayOptions): number[] {
  if (options.take === undefined) return recording.takes.map((_, i) => i + 1);
  const n = positiveInteger("--take", options.take);
  if (n > recording.takes.length) throw new CliError(`--take ${n}: this recording has ${plural(recording.takes.length, "take")}.`);
  return [n];
}

/** Draws one take through `ludra play`, whole or around a mark. */
async function showTake(project: Project, recording: Recording, numbers: number[], options: ReplayOptions): Promise<number> {
  if (numbers.length !== 1) throw new CliError(`Which take? This recording has ${recording.takes.length}: add --take <n>.`);
  const n = numbers[0]!;
  const take = recording.takes[n - 1]!;
  // A crashed take's last frame is the one that threw.
  let last = take.end === "crashed" ? take.frames - 1 : take.frames;
  let from: string | undefined;
  let sheet = options.sheet;
  if (options.mark !== undefined) {
    const m = positiveInteger("--mark", options.mark);
    const mark = take.marks[m - 1];
    if (!mark) throw new CliError(`--mark ${m}: take ${n} has ${plural(take.marks.length, "mark")}.`);
    // The key comes after the feeling, so most of what to see is before the mark.
    from = `${Math.max(0, mark.frame - 180)}f`;
    last = Math.max(1, Math.min(last, mark.frame + 60));
    sheet ??= "0.25s";
    if (!options.json) console.log(paint("bold", `Take ${n}, mark ${m}: ${describeMark(mark.kind, mark.text)} at ${time(mark.frame)}`));
  }
  if (take.version !== gameHash(project, take.scene) && !options.json) {
    console.log(paint("yellow", "This take was played on an older version of the game, so these frames may not be what the player saw."));
  }
  return play(project.dir, {
    scene: take.scene,
    inputs: take.inputs,
    carry: take.carry,
    duration: `${last}f`,
    every: last > 1200 ? "5s" : "1s",
    sheet,
    from: sheet ? from : undefined,
    screenshot: options.screenshot,
    debug: options.debug,
    out: options.out ?? "screenshots/replay",
    json: options.json,
  });
}

interface Written {
  file: string;
  tests: { name: string; pass: boolean; error?: string }[];
  skipped: { take: number; why: string }[];
}

/**
 * Takes that reached an end say something: won, lost, moved on or crashed. Without --take those are
 * the ones written, or the last take when none did.
 */
function worthTesting(recording: Recording, numbers: number[], chosen: boolean): number[] {
  if (chosen) return numbers;
  const ended = numbers.filter((n) => ["won", "lost", "moved", "crashed"].includes(recording.takes[n - 1]!.end ?? ""));
  return ended.length > 0 ? ended : numbers.slice(-1);
}

async function writeTests(project: Project, recording: Recording, numbers: number[], replays: Map<number, TakeReplay>, games: Map<string, Game | undefined>, chosen: boolean): Promise<Written> {
  const path = join(project.dir, "tests", "recordings.test.json");
  let cases: TestCase[] = [];
  if (existsSync(path)) {
    try {
      cases = (JSON.parse(readFileSync(path, "utf8")) as { tests: TestCase[] }).tests;
    } catch (err) {
      throw new CliError(`tests/recordings.test.json is not valid JSON: ${(err as Error).message}`);
    }
  }
  const written: Written = { file: shown(path), tests: [], skipped: [] };
  for (const n of worthTesting(recording, numbers, chosen)) {
    const take = recording.takes[n - 1]!;
    const result = replays.get(n)!;
    const game = games.get(take.scene);
    if (result.status === "diverged" || !game) {
      written.skipped.push({ take: n, why: game ? "the same game no longer plays it the same, so a test of it would flicker" : `${take.scene} doesn't load` });
      continue;
    }
    const test = testOf(recording, n, take);
    const index = cases.findIndex((c) => c.name === test.name);
    if (index >= 0) cases[index] = test;
    else cases.push(test);
    const { pass, error } = runTest(game.scene, test, { scripts: game.scripts });
    written.tests.push({ name: test.name, pass, error });
  }
  if (written.tests.length > 0) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ tests: cases }, null, 2)}\n`);
  }
  return written;
}

/** What the player's run came to, as a test: this game still plays out this way on these inputs. */
function testOf(recording: Recording, n: number, take: Take): TestCase {
  const scene = take.scene.replace(/^.*\//, "").replace(/\.scene\.json$/, "");
  const name = `${recording.session} take ${n}: ${take.end} ${scene} at ${time(take.frames)}`;
  const base: TestCase = { name, recording: recording.session, scene: take.scene, inputs: take.inputs, duration: `${take.frames}f`, ...(take.carry ? { carry: take.carry } : {}), assert: [] };
  // A crash has no end state to hold on to: the test passes once the run gets through, so it is red until the bug is fixed.
  if (take.end === "crashed") return { ...base, assert: ["score >= 0"] };
  const assert = [`score == ${take.score}`, `deaths == ${take.deathCount}`];
  if (take.end === "won") assert.unshift("won == true");
  else if (take.end === "lost") assert.unshift("lost == true");
  else if (take.end === "moved") assert.unshift("events.goto == 1");
  else if (take.last && take.player) {
    // Close to where the player stopped: exact numbers would fail on any harmless change.
    const margin = take.last.z === undefined ? 16 : 1;
    for (const axis of ["x", "y", "z"] as const) {
      const value = take.last[axis];
      if (value === undefined) continue;
      assert.push(`${take.player}.${axis} >= ${Math.floor(value - margin)}`, `${take.player}.${axis} <= ${Math.ceil(value + margin)}`);
    }
  }
  return { ...base, assert };
}

function printTake(n: number, take: Take, result: TakeReplay): void {
  const verdict: Record<TakeReplay["status"], string> = {
    same: paint("green", "✓ plays out the same"),
    changed: paint("yellow", "≠ the game changed, and so does this run"),
    diverged: paint("red", "✗ the same game played differently"),
    gone: paint("red", `✗ ${result.problem}`),
  };
  console.log(`\n${paint("bold", `Take ${n}`)}  ${take.scene}  ${time(take.frames)}  ${take.end}  score ${take.score}  deaths ${take.deathCount}  ${verdict[result.status]}`);
  if (result.status === "same" && result.otherVersion) console.log(paint("dim", "  on an older version of the game, with the same outcome"));
  if (result.leftBetween) console.log(`  left the original between ${time(result.leftBetween[0])} and ${time(result.leftBetween[1])}`);
  for (const difference of result.differences) console.log(`  ${difference}`);
  if (take.error) console.log(paint("red", `  ${take.error}`));
  const moments = [
    ...take.deaths.map((d) => ({ frame: d.frame, text: `died: ${d.cause === "fall" ? "fell" : d.cause} at (${place(d)})` })),
    ...take.marks.map((m, i) => ({ frame: m.frame, text: paint("yellow", `mark ${i + 1}: ${describeMark(m.kind, m.text)}${m.x === undefined ? "" : ` at (${place({ x: m.x, y: m.y ?? 0, z: m.z })})`}`) })),
  ].sort((a, b) => a.frame - b.frame);
  for (const moment of moments) console.log(`  ${pad(time(moment.frame), 8)} ${moment.text}`);
}

function printWritten(written: Written): void {
  console.log(`\n${paint("bold", "Tests")} ${paint("dim", written.file)}`);
  for (const test of written.tests) {
    console.log(`  ${test.pass ? paint("green", "✓") : paint("red", "✗")} ${test.name}${test.error ? paint("dim", `  (${test.error})`) : ""}`);
  }
  for (const skip of written.skipped) console.log(paint("yellow", `  take ${skip.take} left out: ${skip.why}`));
  if (written.tests.some((t) => !t.pass)) console.log(paint("dim", "  A red test means the game doesn't play this run out as the player did. For a crash, that is the bug: fix the game until it passes."));
}

export function describeMark(kind: keyof typeof MARK_LABELS, text?: string): string {
  return text ? `"${text}"` : MARK_LABELS[kind];
}

function time(frame: number): string {
  return `${fixed(frame / 60, 2)}s`;
}

function place(p: { x: number; y: number; z?: number }): string {
  return [p.x, p.y, ...(p.z === undefined ? [] : [p.z])].map((n) => Math.round(n)).join(", ");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function shown(path: string): string {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}
