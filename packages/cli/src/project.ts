import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { collectAssetPaths, validateScene, type Diagnostic, type SceneDef } from "@ludra/core";
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
      const available = listAssets(project.dir);
      return {
        severity: "error" as const,
        code: "E_ASSET_MISSING",
        path: ref.at,
        message: `The ${ref.kind} "${ref.path}" does not exist in the project.`,
        fix: available.length > 0 ? `Create it, or use one of: ${available.join(", ")}.` : `Create it (paths are relative to the folder with ludra.json, e.g. "assets/player.svg").`,
      };
    });
}

function listAssets(dir: string): string[] {
  const assetsDir = join(dir, "assets");
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
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
