import { FPS, fuzz as play, parseDuration, World, type FuzzFinding, type FuzzResult } from "@ludra/core";
import { relative } from "node:path";
import { fixed, paint } from "../format.ts";
import { CliError, loadProject, requireGame } from "../project.ts";
import { parse, positiveInteger, searchTime } from "./solve.ts";

export interface FuzzCommandOptions {
  scene?: string;
  sessions?: string;
  time?: string;
  seconds?: string;
  seed?: string;
  "no-softlocks"?: boolean;
  json?: boolean;
}

/** Death places shown per cause. */
const PLACES_SHOWN = 3;

/** `ludra fuzz`: random play that finds crashes, softlocks and where players die. Exit 1 on crashes or softlocks. */
export async function fuzz(dir: string, options: FuzzCommandOptions): Promise<number> {
  const project = loadProject(dir);
  const { scene, scripts } = await requireGame(project, options.scene);
  const seconds = parse("--time", () => searchTime(options.time ?? "60s"));
  const sessions = options.sessions === undefined ? undefined : positiveInteger("--sessions", options.sessions);
  const perSession = options.seconds === undefined ? undefined : parse("--seconds", () => parseDuration(options.seconds!));
  const seed = options.seed === undefined ? undefined : positiveInteger("--seed", options.seed);

  const started = Date.now();
  const ends = started + seconds * 1000;
  let result: FuzzResult;
  try {
    result = play(() => new World(scene, { scripts }), {
      deadline: () => Date.now() > ends,
      sessions,
      seconds: perSession,
      seed,
      ...(options["no-softlocks"] ? { softlocks: false } : {}),
    });
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  const elapsed = (Date.now() - started) / 1000;
  // A level that can't be won is as broken as one that crashes.
  const failed = result.crashes.length > 0 || result.softlocks.length > 0 || result.winnable === false;

  if (options.json) {
    console.log(JSON.stringify({ ...result, seconds: Math.round(elapsed * 100) / 100 }, null, 2));
    return failed ? 1 : 0;
  }

  const where = relative(process.cwd(), project.dir).replaceAll("\\", "/") || ".";
  const lines = [
    `Played ${result.sessions} random sessions: ${result.frames.toLocaleString("en-US")} frames in ${fixed(elapsed)}s, ` +
      `${result.cells.toLocaleString("en-US")} distinct places, ${result.wins} lucky ${result.wins === 1 ? "win" : "wins"}.` +
      (result.outOfTime ? paint("yellow", ` Stopped by --time ${options.time ?? "60s"}; give it longer to play more.`) : ""),
  ];

  for (const crash of result.crashes) {
    lines.push("", `${paint("red", "✗ CRASH")} ${crash.message}`);
    lines.push(`  at ${place(crash)} after ${time(crash.frame)}. Reproduce it:`);
    lines.push(`  ludra play ${where} --inputs "${crash.inputs}"`);
  }

  for (const trap of result.softlocks) {
    lines.push("", `${paint("red", "✗ SOFTLOCK")} at ${place(trap)}: the player can get here (after ${time(trap.frame)}) but can never win from here, and doesn't die.`);
    lines.push(`  ludra play ${where} --inputs "${trap.inputs}" --screenshot end`);
    lines.push(`  ${paint("cyan", "fix:")} give the player a way out (a ladder, a spring, a ledge low enough to jump) or make falling there cost a life (a hazard or world.fallLimit).`);
  }

  if (result.winnable === false) {
    lines.push("", `${paint("red", "✗ UNWINNABLE")}: the level can't be won from the start, so softlocks weren't looked for.`);
    lines.push(`  Run \`ludra solve ${where}\` to see the closest a player gets.`);
  } else if (result.winnable === undefined && !options["no-softlocks"] && scene.entities.some((e) => e.components.goal)) {
    lines.push("", paint("dim", "Softlocks weren't checked: the first search for a win ran out of budget. `ludra solve` can say whether the level is winnable."));
  }

  if (result.deaths.length > 0) {
    lines.push("", paint("bold", "Where players die") + paint("dim", " (deaths are difficulty, not bugs)"));
    for (const d of result.deaths) {
      const places = d.places.slice(0, PLACES_SHOWN).map((p) => `${place(p)} ×${p.count}`);
      lines.push(`  ${d.cause} ×${d.count}${places.length ? `: most at ${places.join(", ")}` : ""}`);
    }
  }

  if (!failed && result.winnable !== false) lines.push("", paint("green", "✓ No crashes or softlocks found."));
  console.log(lines.join("\n"));
  return failed ? 1 : 0;
}

function place(p: Pick<FuzzFinding, "x" | "y" | "z">): string {
  return p.z === undefined ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : `(${round(p.x)}, ${round(p.y)}, ${round(p.z)})`;
}

function time(frame: number): string {
  return `${fixed(frame / FPS, 2)}s`;
}

function round(n: number): string {
  return String(Math.round(n * 10) / 10);
}

