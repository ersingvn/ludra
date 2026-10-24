import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { validateScene, type Diagnostic, type SceneDef } from "@ludra/core";
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
  return { scene, diagnostics };
}

/** Like `readScene`, but stops with the diagnostics when the scene has errors. */
export function requireScene(project: Project): SceneDef {
  const { scene, diagnostics } = readScene(project);
  if (!scene) {
    throw new CliError(`${formatDiagnostics(diagnostics, project.entryLabel)}\n\nFix the errors above (see \`ludra check\`) and try again.`);
  }
  return scene;
}
