import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectAssetPaths,
  findRuntimeImports,
  validateScene,
  validateScriptModule,
  type Diagnostic,
  type SceneDef,
  type Script,
} from "@ludra/core";
import { formatDiagnostics } from "./format.ts";

/** An error whose message is meant for the user (or agent) as-is, without a stack trace. */
export class CliError extends Error {}

export interface ProjectConfig {
  name: string;
  entry: string;
  window: { width: number; height: number };
}

export interface Project {
  dir: string;
  config: ProjectConfig;
  entryPath: string;
  /** Entry path relative to the project, for messages. */
  entryLabel: string;
}

export function loadProject(dir: string): Project {
  const root = resolve(dir);
  const configPath = join(root, "ludra.json");
  if (!existsSync(configPath)) {
    throw new CliError(`No ludra.json found in ${root}.\nRun \`ludra new <folder>\` to create a game, or pass the project folder as an argument.`);
  }

  let raw: Partial<ProjectConfig>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new CliError(`ludra.json is not valid JSON: ${(err as Error).message}`);
  }

  const config: ProjectConfig = {
    name: raw.name ?? "untitled",
    entry: raw.entry ?? "scenes/main.scene.json",
    window: { width: raw.window?.width ?? 960, height: raw.window?.height ?? 540 },
  };
  const entryPath = join(root, config.entry);
  return { dir: root, config, entryPath, entryLabel: relative(root, entryPath).replaceAll("\\", "/") };
}

export interface SceneLoad {
  scene?: SceneDef;
  diagnostics: Diagnostic[];
}

/** Reads and validates the entry scene. JSON syntax errors become diagnostics too. */
export function readScene(project: Project): SceneLoad {
  if (!existsSync(project.entryPath)) {
    return {
      diagnostics: [
        {
          severity: "error",
          code: "E_SCENE_MISSING",
          path: "$",
          message: `Entry scene ${project.entryLabel} does not exist.`,
          fix: `Create it, or point "entry" in ludra.json at an existing scene.`,
        },
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(project.entryPath, "utf8"));
  } catch (err) {
    return {
      diagnostics: [{ severity: "error", code: "E_JSON_SYNTAX", path: "$", message: `Invalid JSON: ${(err as Error).message}` }],
    };
  }
  const { scene, diagnostics } = validateScene(raw);
  if (!scene) return { diagnostics };

  const missing = missingAssets(project, scene);
  return { scene: missing.length === 0 ? scene : undefined, diagnostics: [...diagnostics, ...missing] };
}

/** Image and audio files the scene references that are not in the project. */
function missingAssets(project: Project, scene: SceneDef): Diagnostic[] {
  return collectAssetPaths(scene)
    .filter((ref) => !isInside(project.dir, resolve(project.dir, ref.path)) || !existsSync(resolve(project.dir, ref.path)))
    .map((ref) => {
      const folder = ref.kind === "script" ? "scripts" : "assets";
      const available = listFiles(project.dir, folder);
      return {
        severity: "error" as const,
        code: "E_ASSET_MISSING",
        path: ref.at,
        message: `The ${ref.kind} "${ref.path}" does not exist in the project.`,
        fix:
          available.length > 0
            ? `Create it, or use one of: ${available.join(", ")}.`
            : `Create it (paths are relative to the folder with ludra.json, e.g. "${folder}/${ref.kind === "script" ? "enemy.ts" : "player.svg"}").`,
      };
    });
}

/** Files under a project folder, as project-relative paths with forward slashes. */
function listFiles(dir: string, folder: string): string[] {
  const root = join(dir, folder);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

/** Script files a game can use: those the scene references, plus everything in scripts/ (for world.spawn). */
export function scriptPaths(project: Project, scene: SceneDef): string[] {
  const referenced = collectAssetPaths(scene).filter((ref) => ref.kind === "script").map((ref) => ref.path);
  const inFolder = listFiles(project.dir, "scripts").filter((path) => /\.(ts|js)$/.test(path) && !path.endsWith(".d.ts"));
  return [...new Set([...referenced, ...inFolder])];
}

export interface Game {
  scene: SceneDef;
  scripts: Map<string, Script>;
}

/**
 * Reads the scene and imports its scripts. Node runs TypeScript scripts
 * directly (type stripping), so no build step is needed.
 */
export async function loadGame(project: Project): Promise<{ game?: Game; diagnostics: Diagnostic[] }> {
  const { scene, diagnostics } = readScene(project);
  if (!scene) return { diagnostics };

  const scripts = new Map<string, Script>();
  for (const src of scriptPaths(project, scene)) {
    const file = resolve(project.dir, src);
    if (!isInside(project.dir, file) || !existsSync(file)) continue; // reported by readScene
    const imports = findRuntimeImports(readFileSync(file, "utf8"));
    if (imports.length > 0) {
      diagnostics.push({
        severity: "error",
        code: "E_SCRIPT_IMPORT",
        path: src,
        message: `${src} imports ${imports.map((i) => `"${i}"`).join(", ")}. Scripts run without a bundler and cannot import runtime code.`,
        fix: 'Use "import type" for types (e.g. import type { Script } from "@ludra/core"), and put shared helpers inside the script.',
      });
      continue;
    }
    let module: unknown;
    try {
      module = await import(pathToFileURL(file).href);
    } catch (err) {
      diagnostics.push({ severity: "error", code: "E_SCRIPT_LOAD", path: src, ...describeLoadError(err, src) });
      continue;
    }
    const problems = validateScriptModule(module, src);
    diagnostics.push(...problems);
    if (!problems.some((d) => d.severity === "error")) scripts.set(src, (module as { default: Script }).default);
  }

  const ok = !diagnostics.some((d) => d.severity === "error");
  return { game: ok ? { scene, scripts } : undefined, diagnostics };
}

/**
 * Node's syntax errors carry the location only in the stack: "file:///...:LINE", the source
 * line, then a caret. Pull those out so the diagnostic points at the code.
 */
function describeLoadError(err: unknown, src: string): { message: string; fix?: string } {
  const error = err as Error;
  const lines = String(error.stack ?? "").split("\n");
  const at = lines.findIndex((line) => /^file:\/\/.*:\d+$/.test(line));
  if (at < 0) return { message: `${src} failed to load: ${error.message}` };
  const line = lines[at]!.slice(lines[at]!.lastIndexOf(":") + 1);
  const code = lines[at + 1] ?? "";
  const caret = lines[at + 2] ?? "";
  return { message: `${src}:${line} failed to load: ${error.message}`, fix: `Line ${line}:\n    ${code}\n    ${caret}` };
}

/** Like `loadGame`, but stops with the diagnostics when anything is wrong. */
export async function requireGame(project: Project): Promise<Game> {
  const { game, diagnostics } = await loadGame(project);
  if (!game) {
    throw new CliError(`${formatDiagnostics(diagnostics, project.entryLabel)}\n\nFix the errors above (see \`ludra check\`) and try again.`);
  }
  return game;
}

export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Like `readScene`, but stops with the diagnostics when the scene has errors. */
export function requireScene(project: Project): SceneDef {
  const { scene, diagnostics } = readScene(project);
  if (!scene) {
    throw new CliError(`${formatDiagnostics(diagnostics, project.entryLabel)}\n\nFix the errors above (see \`ludra check\`) and try again.`);
  }
  return scene;
}
