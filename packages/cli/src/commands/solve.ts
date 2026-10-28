import {
  evaluateAssertion,
  FPS,
  parseAssertion,
  parseDuration,
  solve as search,
  World,
  type SolveResult,
  type TimingWindow,
} from "@ludra/core";
import { relative } from "node:path";
import { fixed, pad, paint } from "../format.ts";
import { CliError, loadProject, requireGame } from "../project.ts";

export interface SolveCommandOptions {
  scene?: string;
  time?: string;
  budget?: string;
  "allow-deaths"?: boolean;
  seed?: string;
  goal?: string;
  json?: boolean;
}

/** At or under this (0.1 s) a person misses the timing often; over FORGIVING it is easy. In frames. */
const TIGHT = 6;
const FORGIVING = 15;

/** `ludra solve`: searches the inputs for a way to win, and how much slack each press has. Exit 1 when unsolved. */
export async function solve(dir: string, options: SolveCommandOptions): Promise<number> {
  const project = loadProject(dir);
  const { scene, scripts } = await requireGame(project, options.scene);
  const seconds = parse("--time", () => searchTime(options.time ?? "30s"));
  const budget = options.budget === undefined ? undefined : positiveInteger("--budget", options.budget);
  const seed = options.seed === undefined ? undefined : positiveInteger("--seed", options.seed);
  const goal = options.goal === undefined ? undefined : goalFrom(options.goal);

  const started = Date.now();
  const ends = started + seconds * 1000;
  let result: SolveResult;
  try {
    result = search(() => new World(scene, { scripts }), {
      deadline: () => Date.now() > ends,
      budget,
      seed,
      goal,
      allowDeaths: options["allow-deaths"] ?? false,
    });
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  const elapsed = (Date.now() - started) / 1000;
  const outOfTime = !result.solved && !result.exhausted && Date.now() > ends;

  if (options.json) {
    console.log(JSON.stringify({ ...result, seconds: Math.round(elapsed * 100) / 100, outOfTime }, null, 2));
    return result.solved ? 0 : 1;
  }

  const where = relative(process.cwd(), project.dir).replaceAll("\\", "/") || ".";
  const target = options.goal ? `"${options.goal}"` : "a win";
  const lines: string[] = [];
  if (result.solved) {
    lines.push(`${paint("green", "✓ SOLVED")}: ${target} at ${time(result.frame!)} (frame ${result.frame})`);
    lines.push(`  ludra play ${where} --inputs "${result.inputs}"`);
    lines.push("", paint("bold", "Timing"));
    lines.push(...formatWindows(result.windows ?? []));
    const assertion = options.goal ?? "won == true";
    const testCase = { name: `the solver's route reaches ${options.goal ? options.goal : "the goal"}`, inputs: result.inputs, assert: [assertion] };
    lines.push("", paint("bold", "As a test") + paint("dim", " (add it to a tests/*.test.json file's \"tests\" list)"));
    lines.push(`  ${JSON.stringify(testCase)}`);
  } else {
    lines.push(`${paint("red", "✗ UNSOLVED")}: no way to reach ${target} found.`);
    if (result.exhausted) {
      lines.push(`  Every reachable place was tried${options["allow-deaths"] ? "" : " without dying"}: as far as the search can tell, it can't be done.`);
      if (!options["allow-deaths"]) lines.push(paint("dim", "  If the route is meant to cost a life, try --allow-deaths."));
    } else {
      const why = outOfTime ? `ran out of time after ${fixed(elapsed)}s` : "ran out of budget";
      lines.push(`  The search ${why} before trying everything: it may still be possible. Try --time ${nextTime(seconds)}${outOfTime ? "" : " or a bigger --budget"}.`);
    }
    if (result.closest) {
      const c = result.closest;
      const at = c.z === undefined ? `(${round(c.x)}, ${round(c.y)})` : `(${round(c.x)}, ${round(c.y)}, ${round(c.z)})`;
      lines.push("", paint("bold", "Closest approach") + ` ${round(c.distance)} from the goal, at ${at} at ${time(c.frame)}:`);
      lines.push(`  ludra play ${where} --inputs "${c.inputs}" --screenshot end`);
    }
  }
  lines.push("", paint("dim", `explored ${result.explored.toLocaleString("en-US")} frames, ${result.cells.toLocaleString("en-US")} cells, method ${result.method}, ${fixed(elapsed)}s`));
  console.log(lines.join("\n"));
  return result.solved ? 0 : 1;
}

function formatWindows(windows: readonly TimingWindow[]): string[] {
  if (windows.length === 0) return [paint("dim", "  No presses to time: holding directions is enough.")];
  return windows.map((w) => {
    const label = w.width <= TIGHT ? paint("yellow", "tight") : w.width > FORGIVING ? paint("green", "forgiving") : "fair";
    const span = `${w.width} frames (${fixed(w.width / FPS, 2)}s): ${w.early} early, ${w.late} late`;
    return `  ${pad(w.action, 7)} at ${pad(`${time(w.frame)} (frame ${w.frame})`, 20)} window ${pad(span, 38)} ${label}`;
  });
}

/** `--goal "<assertion>"`: the same syntax as tests, checked on the world after every frame. */
function goalFrom(source: string): (world: World) => boolean {
  const assertion = parse("--goal", () => parseAssertion(source));
  if (/\sat\s+\S+\s*$/.test(source)) throw new CliError(`--goal "${source}": leave out "at …"; the solver checks the goal on every frame.`);
  return (world) => evaluateAssertion(assertion, world.snapshot(), world.events).pass;
}

function parse<T>(flag: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw new CliError(`${flag}: ${(err as Error).message}`);
  }
}

/** Like a test duration, plus minutes ("2m"): searches run longer than any test. */
function searchTime(text: string): number {
  const minutes = /^\s*(\d+(?:\.\d+)?)m\s*$/.exec(text);
  return minutes ? Number(minutes[1]) * 60 : parseDuration(text);
}

function positiveInteger(flag: string, text: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`${flag} must be a whole number above 0, not "${text}".`);
  return n;
}

function time(frame: number): string {
  return `${fixed(frame / FPS, 2)}s`;
}

function nextTime(seconds: number): string {
  const doubled = seconds * 2;
  return doubled >= 60 && doubled % 60 === 0 ? `${doubled / 60}m` : `${Math.ceil(doubled)}s`;
}

function round(n: number): string {
  return String(Math.round(n * 100) / 100);
}
