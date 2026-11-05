import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MARK_KINDS, type Recording, type Take } from "@ludra/core";
import { CliError, loadProject, readScene, scriptPaths, type Project } from "./project.ts";

export const RECORDINGS_DIR = "recordings";
const EXTENSION = ".rec.json";
/** The page makes these ids; the file name comes from them, so nothing else gets through. */
const SESSION_ID = /^[0-9a-z-]{8,40}$/;

/**
 * Identifies everything a run depends on: the scene as served (prefabs merged, colliders filled)
 * and the scripts. Art and sound can change without changing what a recording does.
 */
export function gameHash(project: Project, scenePath?: string): string {
  const { scene } = readScene(project, scenePath);
  if (!scene) return "";
  const hash = createHash("sha256").update(JSON.stringify(scene));
  for (const path of [...scriptPaths(project, scene)].sort()) {
    const file = join(project.dir, path);
    if (existsSync(file)) hash.update(`\0${path}\0`).update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 16);
}

export function recordingPath(project: Project, session: string): string {
  return join(project.dir, RECORDINGS_DIR, `${session}${EXTENSION}`);
}

function isPlace(value: unknown): boolean {
  const place = value as { x?: unknown; y?: unknown } | null;
  return typeof place === "object" && place !== null && Number.isFinite(place.x) && Number.isFinite(place.y);
}

/** Why a take can't be kept, or undefined. What arrives over HTTP or from a file is only trusted after this. */
function takeProblem(take: unknown): string | undefined {
  const t = take as Partial<Take> | null;
  if (typeof t !== "object" || t === null) return "a take must be an object";
  if (typeof t.scene !== "string" || typeof t.version !== "string") return "a take needs its scene and version";
  if (typeof t.inputs !== "string" || !Number.isInteger(t.frames) || t.frames! < 0) return "a take needs its inputs and frames";
  if (!Array.isArray(t.checks) || !t.checks.every((c) => typeof c === "string")) return "a take needs its checks";
  if (!Array.isArray(t.deaths) || !t.deaths.every((d) => isPlace(d) && Number.isInteger(d.frame) && typeof d.cause === "string")) return "a take's deaths are malformed";
  if (!Array.isArray(t.marks) || !t.marks.every((m) => Number.isInteger(m.frame) && (MARK_KINDS as readonly string[]).includes(m.kind))) return "a take's marks are malformed";
  return undefined;
}

export interface TakeUpload {
  recording: Omit<Recording, "takes">;
  index: number;
  take: Take;
}

/**
 * Adds a take to its recording, or updates it: a page sends a take again as it grows. Requests can
 * overtake each other as the page closes, so a take never goes back to an earlier state of itself.
 */
export function saveTake(project: Project, upload: TakeUpload): void {
  const { recording, index, take } = upload ?? {};
  if (typeof recording !== "object" || recording === null) throw new CliError("no recording");
  if (typeof recording.session !== "string" || !SESSION_ID.test(recording.session)) throw new CliError("bad session id");
  if (!Number.isInteger(index) || index < 0 || index > 100_000) throw new CliError("bad take index");
  const problem = takeProblem(take);
  if (problem) throw new CliError(problem);

  const file = recordingPath(project, recording.session);
  mkdirSync(dirname(file), { recursive: true });
  const current: Recording = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Recording)
    : { version: 1, session: recording.session, game: String(recording.game), started: String(recording.started), takes: [] };
  const old = current.takes[index];
  if (old && (old.frames > take.frames || (old.end !== undefined && take.end === undefined) || old.marks.length > take.marks.length)) return;
  current.takes[index] = take;
  // Takes can arrive out of order for a moment; JSON turns the gaps into nulls.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(current, null, 1)}\n`);
  renameSync(temporary, file);
}

/** Reads a recording. A take whose page died has no end: as far as anyone can tell they stopped there. */
export function readRecording(file: string): Recording {
  let raw: Recording;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Recording;
  } catch (err) {
    throw new CliError(`${file} is not a recording: ${(err as Error).message}`);
  }
  if (raw?.version !== 1 || !Array.isArray(raw.takes)) throw new CliError(`${file} is not a Ludra recording (version 1).`);
  const takes = raw.takes.filter((take) => take !== null);
  for (const [i, take] of takes.entries()) {
    const problem = takeProblem(take);
    if (problem) throw new CliError(`${file}, take ${i + 1}: ${problem}.`);
    take.end ??= "stopped";
  }
  return { ...raw, takes };
}

/** The project's recordings, oldest first. */
export function listRecordings(project: Project): string[] {
  const dir = join(project.dir, RECORDINGS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(EXTENSION))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs || a.localeCompare(b));
}

/**
 * What `ludra replay <target>` means: a recording file (the project is the nearest folder with a
 * ludra.json above it), or a project folder, for its newest recording.
 */
export function findRecording(target: string): { project: Project; file: string } {
  const path = resolve(target);
  if (!existsSync(path)) throw new CliError(`${target} does not exist.`);
  if (statSync(path).isDirectory()) {
    const project = loadProject(path);
    const file = listRecordings(project).at(-1);
    if (!file) throw new CliError(`${project.config.name} has no recordings yet. Play it with \`ludra dev\`: every session is recorded in ${RECORDINGS_DIR}/.`);
    return { project, file };
  }
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "ludra.json"))) return { project: loadProject(dir), file: path };
    if (dirname(dir) === dir) throw new CliError(`No ludra.json found above ${path}.`);
  }
}
