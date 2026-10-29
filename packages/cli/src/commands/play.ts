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
import { captureScreenshots, sheetLayout } from "../headless.ts";
import { CliError, loadProject, requireGame, type Project } from "../project.ts";

export interface PlayOptions {
  scene?: string;
  inputs?: string;
  duration?: string;
  watch?: string;
  every?: string;
  ascii?: boolean;
  columns?: string;
  screenshot?: string;
  sheet?: string;
  debug?: boolean;
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
  const { scene, scripts } = await requireGame(project, options.scene);
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
  const { screenshots, sheet } = options.screenshot || options.sheet ? await takeScreenshots(project, options, frames, world.events) : {};

  if (options.json) {
    console.log(
      JSON.stringify(
        { duration: frames / 60, frames, inputs: options.inputs ?? "", timeline: rows, events: world.events, final: world.snapshot(), ascii, screenshots, sheet },
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
  if (sheet) {
    console.log(`\n${paint("bold", "Contact sheet")} ${paint("dim", `(${sheet.cells.length} frames in one image, ${sheet.columns} per row)`)}`);
    console.log(`  ${sheet.file}`);
  }
  return 0;
}

interface Screenshot {
  time: number;
  frame: number;
  file: string;
}

interface Sheet {
  file: string;
  columns: number;
  cells: { time: number; frame: number; events: string[] }[];
}

/** Most frames on one contact sheet; past this the cells get too small to read. */
const MAX_SHEET_FRAMES = 48;

/**
 * Renders moments of the same run in a headless browser and writes them as
 * PNGs. `--screenshot` is a comma list of times and/or "end"; `--sheet` is an
 * interval, and lays every frame at it (and the last one) out in one image.
 */
async function takeScreenshots(
  project: Project,
  options: PlayOptions,
  lastFrame: number,
  events: readonly GameEvent[],
): Promise<{ screenshots?: Screenshot[]; sheet?: Sheet }> {
  const shots = options.screenshot ? screenshotFrames(options.screenshot, lastFrame) : [];
  const sheetFrames = options.sheet ? sheetFramesAt(options.sheet, lastFrame) : [];
  const sheetEvents = sheetFrames.map((frame, i) => eventsBetween(events, i === 0 ? -1 : sheetFrames[i - 1]!, frame));
  const frames = [...new Set([...shots, ...sheetFrames])].sort((a, b) => a - b);

  const outDir = resolve(project.dir, options.out ?? "screenshots");
  mkdirSync(outDir, { recursive: true });
  const captured = await captureScreenshots(project, {
    scene: options.scene,
    inputs: options.inputs ?? "",
    frames,
    debug: options.debug,
    sheet: options.sheet
      ? { frames: sheetFrames, labels: sheetFrames.map((frame, i) => `${fixed(frame / 60, 2)}s  ${sheetEvents[i]!.join(" ")}`.trimEnd()) }
      : undefined,
  });
  const write = (name: string, png: string) => {
    const path = join(outDir, name);
    writeFileSync(path, Buffer.from(png.slice(png.indexOf(",") + 1), "base64"));
    return relative(process.cwd(), path).replaceAll("\\", "/");
  };

  const screenshots = options.screenshot
    ? captured.frames.filter((shot) => shots.includes(shot.frame)).map((shot) => ({ time: shot.time, frame: shot.frame, file: write(`t-${fixed(shot.time, 2)}s.png`, shot.png) }))
    : undefined;
  const sheet = captured.sheet
    ? {
        file: write("sheet.png", captured.sheet),
        columns: sheetLayout(sheetFrames.length, project.config.window.width, project.config.window.height).columns,
        cells: sheetFrames.map((frame, i) => ({ time: frame / 60, frame, events: sheetEvents[i]! })),
      }
    : undefined;
  return { screenshots, sheet };
}

function screenshotFrames(list: string, lastFrame: number): number[] {
  return list.split(",").map((part) => {
    const token = part.trim();
    if (token === "end") return lastFrame;
    const frame = secondsToFrames(parse(() => parseDuration(token)));
    if (frame > lastFrame) {
      throw new CliError(`--screenshot ${token} is after the end of the run (${fixed(lastFrame / 60, 2)}s). Use a longer --duration.`);
    }
    return frame;
  });
}

/** Frame 0, every interval after it, and the last frame. */
function sheetFramesAt(interval: string, lastFrame: number): number[] {
  const step = secondsToFrames(parse(() => parseDuration(interval)));
  if (step < 1) throw new CliError(`--sheet ${interval} is shorter than one frame. Use an interval like 0.5s.`);
  const frames: number[] = [];
  for (let frame = 0; frame < lastFrame; frame += step) frames.push(frame);
  frames.push(lastFrame);
  if (frames.length > MAX_SHEET_FRAMES) {
    const fits = Math.ceil(lastFrame / 60 / (MAX_SHEET_FRAMES - 1) / 0.05) * 0.05;
    throw new CliError(`--sheet ${interval} gives ${frames.length} frames; a sheet holds at most ${MAX_SHEET_FRAMES}. Use --sheet ${fixed(fits, 2)}s or longer, or a shorter --duration.`);
  }
  return frames;
}

/** Names of the events after frame `from` up to and including frame `to`, e.g. ["collect×2", "die"]. */
function eventsBetween(events: readonly GameEvent[], from: number, to: number): string[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const frame = secondsToFrames(event.time);
    if (frame <= from || frame > to) continue;
    const name = event.type === "custom" ? event.name : event.type;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
}

function printTimeline(rows: Row[], watch: string[]): void {
  const idWidth = Math.max(6, ...watch.map((id) => id.length));
  // A rotation column only when something watched turns (rapier physics).
  const turns = rows.some((row) => watch.some((id) => row.entities[id]?.rotation !== undefined));
  // 3D worlds put z in every snapshot.
  const deep = rows.some((row) => watch.some((id) => row.entities[id]?.z !== undefined));
  const z = (label: string) => (deep ? ` ${padStart(label, 8)}` : "");
  console.log(
    paint(
      "dim",
      `\n  ${pad("time", 7)} ${pad("input", 14)} ${pad("entity", idWidth)} ${padStart("x", 8)} ${padStart("y", 8)}${z("z")} ${padStart("vx", 8)} ${padStart("vy", 8)}${z("vz")}${turns ? ` ${padStart("rot°", 8)}` : ""}  grounded`,
    ),
  );
  for (const row of rows) {
    watch.forEach((id, i) => {
      const e = row.entities[id];
      const time = i === 0 ? pad(`${fixed(row.time, 2)}s`, 7) : " ".repeat(7);
      const input = i === 0 ? pad(row.input.join("+") || "-", 14) : " ".repeat(14);
      const rotation = turns ? ` ${padStart(fixed(e?.rotation ?? 0), 8)}` : "";
      const values = e
        ? `${padStart(fixed(e.x), 8)} ${padStart(fixed(e.y), 8)}${z(fixed(e.z ?? 0))} ${padStart(fixed(e.vx), 8)} ${padStart(fixed(e.vy), 8)}${z(fixed(e.vz ?? 0))}${rotation}  ${e.grounded ? "yes" : "no"}`
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
      return `${event.entity} ${event.cause === "fall" ? "fell out of the world" : `hit ${event.cause}`}`;
    case "win":
      return event.entity === event.goal ? `${event.entity} (script) completed the level` : `${event.entity} reached ${event.goal}`;
    case "bounce":
      return `${event.entity} bounced off ${event.other}`;
    case "checkpoint":
      return `${event.entity} reached ${event.checkpoint} (respawns there now)`;
    case "gameover":
      return event.cause === "script" ? `game over (from ${event.entity}'s script)` : `${event.entity} is out of lives: game over`;
    case "goto":
      return `${event.entity} → ${event.scene}`;
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
