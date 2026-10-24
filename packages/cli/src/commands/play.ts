import {
  defaultDuration,
  InputScript,
  parseDuration,
  renderAscii,
  ScriptError,
  secondsToFrames,
  simulate,
  World,
  type EntitySnapshot,
  type GameEvent,
} from "@ludra/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fixed, pad, padStart, paint } from "../format.ts";
import { captureScreenshots } from "../headless.ts";
import { CliError, loadProject, requireGame, type Project } from "../project.ts";

export interface PlayOptions {
  inputs?: string;
  duration?: string;
  watch?: string;
  every?: string;
  ascii?: boolean;
  columns?: string;
  screenshot?: string;
  out?: string;
  json?: boolean;
}

interface Row {
  time: number;
  input: string[];
  entities: Record<string, EntitySnapshot | null>;
}

const MAX_EVENTS_SHOWN = 40;

export async function play(dir: string, options: PlayOptions): Promise<number> {
  const project = loadProject(dir);
  const { scene, scripts } = await requireGame(project);
  const script = parse(() => InputScript.parse(options.inputs ?? ""));
  const frames = secondsToFrames(options.duration ? parse(() => parseDuration(options.duration!)) : defaultDuration(script));
  const every = Math.max(1, secondsToFrames(parse(() => parseDuration(options.every ?? "0.25s"))));

  const world = scriptErrors(() => new World(scene, { scripts }));
  const watch = options.watch
    ? options.watch.split(",").map((id) => id.trim()).filter(Boolean)
    : world.entities.filter((e) => e.platformer || e.topdown).map((e) => e.id);
  for (const id of watch) {
    if (!world.get(id)) {
      throw new CliError(`--watch: no entity "${id}". Entities: ${world.entities.map((e) => e.id).join(", ")}.`);
    }
  }

  const rows: Row[] = [];
  scriptErrors(() =>
    simulate(world, script, frames, (w) => {
      if (w.frame % every !== 0 && w.frame !== frames) return;
      const snapshot = w.snapshot();
      const input = w.frame === 0 ? [] : [...script.at(w.frame - 1)];
      rows.push({ time: w.time, input, entities: Object.fromEntries(watch.map((id) => [id, snapshot.entities[id] ?? null])) });
    }),
  );
  const columns = Number(options.columns ?? 80);
  if (!Number.isInteger(columns) || columns < 10) throw new CliError(`--columns must be a whole number of at least 10, got "${options.columns}".`);
  const ascii = options.ascii ? renderAscii(world, { columns }) : undefined;
  const screenshots = options.screenshot ? await takeScreenshots(project, options, frames) : undefined;

  if (options.json) {
    console.log(
      JSON.stringify(
        { duration: frames / 60, frames, inputs: options.inputs ?? "", timeline: rows, events: world.events, final: world.snapshot(), ascii, screenshots },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(
    paint("bold", `▶ ${project.config.name}: simulated ${fixed(frames / 60, 2)}s (${frames} frames)`) +
      paint("dim", `  inputs: ${options.inputs?.trim() || "none"}`),
  );
  if (watch.length > 0) printTimeline(rows, watch);
  printEvents(world.events);
  const outcome = world.won ? paint("green", "level complete") : "level not complete";
  console.log(`\n${paint("bold", "Final:")} ${outcome} · score ${world.score} · deaths ${world.deaths} · ${world.entities.length} entities`);
  if (ascii) console.log(`\n${ascii}`);
  if (screenshots) {
    console.log(`\n${paint("bold", "Screenshots")} ${paint("dim", "(open these PNGs to see the frames)")}`);
    for (const shot of screenshots) console.log(`  ${pad(`${fixed(shot.time, 2)}s`, 7)} ${shot.file}`);
  }
  return 0;
}

interface Screenshot {
  time: number;
  frame: number;
  file: string;
}

/**
 * Renders moments of the same run in a headless browser and writes them as
 * PNGs. `--screenshot` is a comma list of times and/or "end".
 */
async function takeScreenshots(project: Project, options: PlayOptions, lastFrame: number): Promise<Screenshot[]> {
  const requested = options.screenshot!.split(",").map((part) => {
    const token = part.trim();
    if (token === "end") return lastFrame;
    const frame = secondsToFrames(parse(() => parseDuration(token)));
    if (frame > lastFrame) {
      throw new CliError(`--screenshot ${token} is after the end of the run (${fixed(lastFrame / 60, 2)}s). Use a longer --duration.`);
    }
    return frame;
  });
  const frames = [...new Set(requested)].sort((a, b) => a - b);

  const outDir = resolve(project.dir, options.out ?? "screenshots");
  mkdirSync(outDir, { recursive: true });
  const captured = await captureScreenshots(project, { inputs: options.inputs ?? "", frames });
  return captured.map((shot) => {
    const path = join(outDir, `t-${fixed(shot.time, 2)}s.png`);
    writeFileSync(path, Buffer.from(shot.png.slice(shot.png.indexOf(",") + 1), "base64"));
    return { time: shot.time, frame: shot.frame, file: relative(process.cwd(), path).replaceAll("\\", "/") };
  });
}

function printTimeline(rows: Row[], watch: string[]): void {
  const idWidth = Math.max(6, ...watch.map((id) => id.length));
  console.log(
    paint("dim", `\n  ${pad("time", 7)} ${pad("input", 14)} ${pad("entity", idWidth)} ${padStart("x", 8)} ${padStart("y", 8)} ${padStart("vx", 8)} ${padStart("vy", 8)}  grounded`),
  );
  for (const row of rows) {
    watch.forEach((id, i) => {
      const e = row.entities[id];
      const time = i === 0 ? pad(`${fixed(row.time, 2)}s`, 7) : " ".repeat(7);
      const input = i === 0 ? pad(row.input.join("+") || "-", 14) : " ".repeat(14);
      const values = e
        ? `${padStart(fixed(e.x), 8)} ${padStart(fixed(e.y), 8)} ${padStart(fixed(e.vx), 8)} ${padStart(fixed(e.vy), 8)}  ${e.grounded ? "yes" : "no"}`
        : paint("dim", "(removed)");
      console.log(`  ${time} ${input} ${pad(id, idWidth)} ${values}`);
    });
  }
}

function printEvents(events: readonly GameEvent[]): void {
  console.log(`\n${paint("bold", "Events")}${events.length === 0 ? paint("dim", " (none)") : ""}`);
  for (const event of events.slice(0, MAX_EVENTS_SHOWN)) {
    const name = event.type === "custom" ? event.name : event.type;
    console.log(`  ${pad(`${fixed(event.time, 2)}s`, 7)} ${pad(name, 9)} ${describeEvent(event)}`);
  }
  if (events.length > MAX_EVENTS_SHOWN) console.log(paint("dim", `  … ${events.length - MAX_EVENTS_SHOWN} more (use --json for all)`));
}

function describeEvent(event: GameEvent): string {
  switch (event.type) {
    case "collect":
      return `${event.entity} → ${event.item} (+${event.score})`;
    case "stomp":
      return `${event.entity} stomped ${event.enemy}${event.score ? ` (+${event.score})` : ""}`;
    case "die":
      return `${event.entity} ${event.cause === "fall" ? "fell out of the world" : `hit ${event.cause}`}, respawned`;
    case "win":
      return event.entity === event.goal ? `${event.entity} (script) completed the level` : `${event.entity} reached ${event.goal}`;
    case "bounce":
      return `${event.entity} bounced off ${event.other}`;
    case "custom":
      return `from ${event.entity}'s script${event.data === undefined ? "" : ` ${JSON.stringify(event.data)}`}`;
    default:
      return event.entity;
  }
}

/** Reports a failing script as a CLI error naming the file, entity, hook and frame. */
function scriptErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ScriptError) throw new CliError(`Script error in ${err.message}`);
    throw err;
  }
}

/** Turns engine parse errors into user-facing CLI errors. */
function parse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}
