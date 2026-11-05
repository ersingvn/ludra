import { relative } from "node:path";
import { MARK_KINDS, type MarkKind, type Place } from "@ludra/core";
import { fixed, pad, paint } from "../format.ts";
import { loadProject, type Project } from "../project.ts";
import { gameHash, listRecordings, RECORDINGS_DIR, readRecording } from "../recordings.ts";
import { describeMark } from "./replay.ts";

/** Moments this close together (px, or metres in 3D) are the same place to a player. */
const NEAR_2D = 64;
const NEAR_3D = 4;
/** Words kept per group of marks. */
const NOTES_SHOWN = 5;

interface Reference {
  /** How many of these came from a version of the game that isn't the current one. */
  older: number;
  count: number;
  at?: Place;
  /** A command that shows one of them. */
  replay: string;
}

export interface MarkGroup extends Reference {
  kind: MarkKind;
  notes: string[];
}

export interface DeathGroup extends Reference {
  cause: string;
}

export interface CrashGroup extends Reference {
  error: string;
}

export interface SceneFeedback {
  scene: string;
  takes: number;
  seconds: number;
  wins: number;
  /** Takes played on this scene as it is now. */
  current: number;
  marks: MarkGroup[];
  deaths: DeathGroup[];
  /** Where people closed the game without finishing the scene. */
  stopped: Reference[];
  crashes: CrashGroup[];
}

export interface Feedback {
  sessions: number;
  takes: number;
  seconds: number;
  scenes: SceneFeedback[];
}

/** Puts together what every recording says about the game. */
export function collectFeedback(project: Project): Feedback {
  const recordings = listRecordings(project).map((file) => ({ file, recording: readRecording(file) }));
  const scenes = new Map<string, SceneFeedback>();
  const versions = new Map<string, string>();
  const versionOf = (scene: string) => {
    if (!versions.has(scene)) versions.set(scene, gameHash(project, scene));
    return versions.get(scene)!;
  };
  /** Finds the group a moment belongs to in a list, or starts it. */
  const group = <T extends Reference>(list: T[], belongs: (candidate: T) => boolean, make: () => T, older: boolean): T => {
    let found = list.find(belongs);
    if (!found) list.push((found = make()));
    found.count++;
    if (older) found.older++;
    return found;
  };

  let seconds = 0;
  let takes = 0;
  for (const { file, recording } of recordings) {
    const command = (n: number, extra = "") => `ludra replay ${shown(file)} --take ${n}${extra}`;
    recording.takes.forEach((take, i) => {
      const n = i + 1;
      takes++;
      seconds += take.frames / 60;
      const info = sceneOf(scenes, take.scene);
      const older = take.version !== versionOf(take.scene);
      info.takes++;
      info.seconds += take.frames / 60;
      if (take.end === "won") info.wins++;
      if (!older) info.current++;
      take.marks.forEach((mark, m) => {
        const at = placeOf(mark);
        const found = group(info.marks, (g) => g.kind === mark.kind && near(g.at, at), () => ({ kind: mark.kind, notes: [], count: 0, older: 0, at, replay: command(n, ` --mark ${m + 1}`) }), older);
        if (mark.text) found.notes.push(mark.text);
      });
      for (const death of take.deaths) {
        const at = placeOf(death);
        group(info.deaths, (g) => g.cause === death.cause && near(g.at, at), () => ({ cause: death.cause, count: 0, older: 0, at, replay: command(n) }), older);
      }
      if (take.end === "crashed") {
        const error = take.error ?? "unknown error";
        group(info.crashes, (g) => g.error === error, () => ({ error, count: 0, older: 0, at: take.last, replay: command(n) }), older);
      }
      if (take.end === "stopped" && i === recording.takes.length - 1) {
        group(info.stopped, (g) => near(g.at, take.last), () => ({ count: 0, older: 0, at: take.last, replay: command(n) }), older);
      }
    });
  }

  const order = <T extends Reference>(list: T[]) => list.sort((a, b) => b.count - b.older - (a.count - a.older) || b.count - a.count);
  for (const info of scenes.values()) {
    info.marks.sort((a, b) => MARK_KINDS.indexOf(a.kind) - MARK_KINDS.indexOf(b.kind) || b.count - a.count);
    order(info.deaths);
    order(info.stopped);
    order(info.crashes);
  }
  return { sessions: recordings.length, takes, seconds, scenes: [...scenes.values()].sort((a, b) => b.seconds - a.seconds) };
}

/** `ludra feedback`: what players felt, in one screen, each line with the command that shows it. */
export function feedback(dir: string, options: { json?: boolean }): number {
  const project = loadProject(dir);
  const result = collectFeedback(project);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.sessions === 0) {
    console.log(paint("yellow", `Nobody has played ${project.config.name} yet. Have someone play it with \`ludra dev\`: sessions land in ${RECORDINGS_DIR}/.`));
    return 0;
  }
  console.log(paint("bold", `${project.config.name}: ${result.sessions} session${result.sessions === 1 ? "" : "s"}, ${result.takes} take${result.takes === 1 ? "" : "s"}, ${minutes(result.seconds)} of play`));
  for (const info of result.scenes) printScene(info);
  return 0;
}

function printScene(info: SceneFeedback): void {
  const older = info.takes - info.current;
  const note = older > 0 ? paint("dim", `  (${older} on an older version)`) : "";
  console.log(`\n${paint("bold", info.scene)}  ${info.takes} take${info.takes === 1 ? "" : "s"}, ${minutes(info.seconds)}, won ${info.wins}${note}`);
  for (const crash of info.crashes) line(paint("red", "crash"), crash.error, crash);
  for (const mark of info.marks) {
    const said = mark.notes.slice(0, NOTES_SHOWN).map((text) => `"${text}"`).join(" ");
    line(paint(mark.kind === "great" ? "green" : "yellow", describeMark(mark.kind)), said, mark);
  }
  for (const death of info.deaths) line("died", death.cause === "fall" ? "fell" : `on ${death.cause}`, death);
  for (const stop of info.stopped) line("stopped", "left the game here", stop);
}

function line(what: string, detail: string, group: Reference): void {
  const where = group.at ? `at (${[group.at.x, group.at.y, ...(group.at.z === undefined ? [] : [group.at.z])].map((n) => Math.round(n)).join(", ")})` : "";
  const older = group.older > 0 ? paint("dim", ` (${group.older} older)`) : "";
  console.log(`  ${pad(`×${group.count}`, 5)} ${what} ${where} ${detail}${older}`.trimEnd());
  console.log(paint("dim", `        ${group.replay}`));
}

function sceneOf(scenes: Map<string, SceneFeedback>, scene: string): SceneFeedback {
  let info = scenes.get(scene);
  if (!info) scenes.set(scene, (info = { scene, takes: 0, seconds: 0, wins: 0, current: 0, marks: [], deaths: [], stopped: [], crashes: [] }));
  return info;
}

/** Whether two moments are the same place to a player. A grid would split neighbours across its lines. */
function near(a: Place | undefined, b: Place | undefined): boolean {
  if (!a || !b) return a === b;
  const reach = a.z === undefined ? NEAR_2D : NEAR_3D;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)) <= reach;
}

function placeOf(moment: Partial<Place>): Place | undefined {
  const { x, y, z } = moment;
  if (x === undefined || y === undefined) return undefined;
  return z === undefined ? { x, y } : { x, y, z };
}

function minutes(seconds: number): string {
  return seconds < 60 ? `${fixed(seconds, 1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function shown(path: string): string {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}
