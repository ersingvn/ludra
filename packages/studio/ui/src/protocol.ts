// The contract in docs/studio.md, as types. Keep this file in step with it.

export const FPS = 60;

export interface ProjectInfo {
  name: string;
  dir: string;
  entry: string;
  scenes: string[];
  window: { width: number; height: number; pixelated?: boolean };
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
  | { type: "change"; version: number | string; at: string; files: FileChange[] };

export type Command = "check" | "test" | "review";

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
