// The contract in docs/studio.md, as types. Keep this file in step with it.

export const FPS = 60;

export interface ProjectInfo {
  name: string;
  dir: string;
  entry: string;
  scenes: string[];
  window: { width: number; height: number; pixelated?: boolean };
  /** Prefab names (prefabs/<name>.prefab.json), for the palette. */
  prefabs?: string[];
  /** The block library (`ludra blocks`), for the palette. */
  blocks?: { name: string; description: string; tags: string[] }[];
}

export type FileKind = "scene" | "prefab" | "script" | "asset" | "config" | "test" | "design" | "other";

export interface FileChange {
  path: string;
  kind: FileKind;
  change: "added" | "changed" | "removed";
  diff?: string;
}

export type ServerEvent =
  | { type: "hello"; version: number | string }
  | {
      type: "change";
      version: number | string;
      at: string;
      files: FileChange[];
      /** "studio" when this server wrote it (an edit, undo or redo, with its label); "files" for anything else (the agent, an editor, git). */
      by?: "studio" | "files";
      label?: string;
    };

export type Command = "check" | "test" | "review";
/** What /__ludra/run takes: the commands, and `add` for the palette ([block, "--at", "x,y", "--id", name]). */
export type RunCommand = Command | "add";

/** A file's text and its version (a hash of the text), from GET /__ludra/file. */
export interface FileText {
  path: string;
  version: string;
  text: string;
}

/** An entity as a scene file holds it. */
export interface EntityJson {
  id: string;
  name?: string;
  prefab?: string;
  components?: Record<string, unknown>;
}

/**
 * One change to a scene file (POST /__ludra/edit). `field` is a dotted path inside the entity
 * ("components.transform.x", "components.sprite", "id" to rename) or the scene ("world.gravity").
 * A `set` without `value` removes the field. `add` goes last, or right after `after`; `after: null` puts it first.
 */
export type Edit =
  | { op: "set"; entity: string; field: string; value?: unknown }
  | { op: "add"; entity: EntityJson; after?: string | null }
  | { op: "remove"; entity: string }
  | { op: "scene"; field: string; value?: unknown };

export interface EditRequest {
  path: string;
  /** The version the edits were made against: stale → 409. */
  version: string;
  edits: Edit[];
  /** What the person did, e.g. "Moved coin-3": for undo and Activity. */
  label?: string;
}

/** 409: the file changed since `version` (fetch it again). 422: the result has errors. 400: a bad edit. */
export type EditResult =
  | { ok: true; version: string; diagnostics: Diagnostic[] }
  | { ok: false; status: 400 | 409 | 422; error?: string; version?: string; diagnostics?: Diagnostic[] };

export type UndoResult = { ok: true; path: string; label: string } | { ok: false; status?: number; error?: string };

export interface RunResponse<T = unknown> {
  ok: boolean;
  exitCode: number;
  result: T;
}

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
  fix?: string;
  file?: string;
}

export interface CheckResult {
  ok: boolean;
  file?: string;
  errors: number;
  warnings: number;
  diagnostics: Diagnostic[];
}

export interface AssertionResult {
  source: string;
  pass: boolean;
  actual: unknown;
  time: number;
  message: string;
}

export interface TestResult {
  name: string;
  pass: boolean;
  duration: number;
  results: AssertionResult[];
  error?: string;
  events?: string[];
}

export interface TestRunResult {
  ok: boolean;
  passed?: number;
  failed?: number;
  error?: string;
  files: { file: string; error?: string; tests: TestResult[] }[];
}

export type ReviewArea = "proof" | "fair" | "feel" | "looks" | "readable" | "players" | "shipping" | "identity";

export interface Finding {
  level: "issue" | "idea";
  area: ReviewArea | string;
  code: string;
  where: string;
  message: string;
  fix: string;
}

export interface ReviewResult {
  ok: boolean;
  issues: number;
  ideas: number;
  findings: Finding[];
}

export interface EntitySummary {
  id: string;
  name?: string;
  prefab?: string;
  parent?: string;
  components: string[];
  x: number;
  y: number;
  z?: number;
}

export interface EntityData {
  id: string;
  name?: string;
  prefab?: string;
  components: Record<string, unknown>;
}

export interface GameStatus {
  frame: number;
  paused: boolean;
  won: boolean;
  lost: boolean;
  score: number;
  lives: number;
  deaths: number;
  fps: number;
}

/** Game → Studio. */
export type GameMessage =
  | { type: "ready"; scene: string; dimensions: 2 | 3; width: number; height: number; physics: string }
  | ({ type: "status" } & GameStatus)
  | { type: "entities"; list: EntitySummary[] }
  | { type: "entity"; id: string; data: EntityData | null }
  | { type: "picked"; id: string | null }
  | { type: "hot"; result: "kept" | "restarted" | "rejected"; frame: number; files: string[]; reason?: string }
  | { type: "event"; event: { type: string; [key: string]: unknown } }
  | { type: "error"; message: string; diagnostics?: Diagnostic[] };

/** Studio → Game. */
export type StudioMessage =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "step"; frames?: number }
  | { type: "restart" }
  | { type: "goto"; scene: string }
  | { type: "inspect"; id: string | null }
  | { type: "highlight"; id: string | null }
  | { type: "pick"; on: boolean }
  | { type: "mute"; on: boolean }
  | { type: "focus" };

/** The Electron preload. Missing in a plain browser. */
export interface StudioBridge {
  version: string;
  platform: string;
  project: { dir: string; url: string } | null;
  openProject(): void;
  openRecent(dir: string): void;
  recent(): Promise<string[]>;
  /** Paths are relative to the project. */
  reveal(path: string): void;
  openInEditor(path: string, line?: number): void;
  /** Menu commands: "play" (toggle), "step", "restart", "pick", "check", "test", "review". Returns unsubscribe. */
  onMenu(cb: (command: string) => void): () => void;
}

declare global {
  interface Window {
    studio?: StudioBridge;
  }
}

export function seconds(frame: number): string {
  return `${(frame / FPS).toFixed(1)} s`;
}
