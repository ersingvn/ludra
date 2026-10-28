import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  closestName,
  collectAssetPaths,
  findRuntimeImports,
  physicsEngineName,
  validateScene,
  validateScriptModule,
  type Diagnostic,
  type SceneDef,
  type Script,
} from "@ludra/core";
import { fillModelColliders } from "./colliders.ts";
import { formatDiagnostics } from "./format.ts";
import { readModel, type ModelSummary } from "./gltf.ts";

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
  /** The scene's path relative to the project, for messages. */
  label: string;
}

/** Every scene in the project: the entry scene, then every .scene.json file under scenes/. */
export function listScenes(project: Project): string[] {
  const inFolder = listFiles(project.dir, "scenes").filter((path) => path.endsWith(".scene.json"));
  return [...new Set([project.entryLabel, ...inFolder])];
}

/** Prefab files (prefabs/<name>.prefab.json) by name, plus problems reading them. */
export function readPrefabs(project: Project): { prefabs: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const prefabs: Record<string, unknown> = {};
  const diagnostics: Diagnostic[] = [];
  for (const path of listFiles(project.dir, "prefabs").filter((p) => p.endsWith(".prefab.json"))) {
    const name = path.slice(path.lastIndexOf("/") + 1, -".prefab.json".length);
    try {
      prefabs[name] = JSON.parse(readFileSync(join(project.dir, path), "utf8"));
    } catch (err) {
      diagnostics.push({ severity: "error", code: "E_JSON_SYNTAX", path, message: `Invalid JSON in ${path}: ${(err as Error).message}` });
    }
  }
  return { prefabs, diagnostics };
}

/**
 * Reads and validates a scene (the entry scene by default), with the project's
 * prefab files merged in. JSON syntax errors become diagnostics too.
 */
export function readScene(project: Project, scenePath: string = project.entryLabel): SceneLoad {
  const file = resolve(project.dir, scenePath);
  const label = relative(project.dir, file).replaceAll("\\", "/");
  if (!isInside(project.dir, file) || !existsSync(file)) {
    const scenes = listScenes(project).filter((s) => existsSync(join(project.dir, s)));
    return {
      label,
      diagnostics: [
        {
          severity: "error",
          code: "E_SCENE_MISSING",
          path: "$",
          message: `Scene ${label} does not exist.`,
          fix:
            label === project.entryLabel
              ? `Create it, or point "entry" in ludra.json at an existing scene.`
              : `Create it${scenes.length > 0 ? `, or use one of: ${scenes.join(", ")}` : ""}.`,
        },
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return {
      label,
      diagnostics: [{ severity: "error", code: "E_JSON_SYNTAX", path: "$", message: `Invalid JSON: ${(err as Error).message}` }],
    };
  }
  // Prefab files are shared by every scene; a scene's own "prefabs" win over files of the same name.
  const files = readPrefabs(project);
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(files.prefabs).length > 0) {
    const own = (raw as { prefabs?: unknown }).prefabs;
    raw = { ...raw, prefabs: { ...files.prefabs, ...(own && typeof own === "object" ? own : {}) } };
  }
  const { scene, diagnostics } = validateScene(raw);
  diagnostics.unshift(...files.diagnostics);
  if (!scene) return { label, diagnostics };

  const missing = missingAssets(project, scene);
  const models = [...modelProblems(project, scene), ...fillModelColliders(project, scene)];
  const ok = missing.length === 0 && !models.some((d) => d.severity === "error") && !files.diagnostics.some((d) => d.severity === "error");
  return { label, scene: ok ? scene : undefined, diagnostics: [...diagnostics, ...missing, ...models] };
}

const EXAMPLE_FILE = { image: "player.svg", audio: "jump.wav", script: "enemy.ts", font: "pixel.woff2", shader: "crt.frag", scene: "level-2.scene.json", model: "knight.glb" } as const;
const FOLDER = { image: "assets", audio: "assets", script: "scripts", font: "assets", shader: "shaders", scene: "scenes", model: "assets" } as const;

/** Files the scene references that are not in the project. */
function missingAssets(project: Project, scene: SceneDef): Diagnostic[] {
  return collectAssetPaths(scene)
    .filter((ref) => !isInside(project.dir, resolve(project.dir, ref.path)) || !existsSync(resolve(project.dir, ref.path)))
    .map((ref) => {
      const folder = FOLDER[ref.kind];
      const available = listFiles(project.dir, folder);
      return {
        severity: "error" as const,
        code: "E_ASSET_MISSING",
        path: ref.at,
        message: `The ${ref.kind} "${ref.path}" does not exist in the project.`,
        fix:
          available.length > 0
            ? `Create it, or use one of: ${available.join(", ")}.`
            : `Create it (paths are relative to the folder with ludra.json, e.g. "${folder}/${EXAMPLE_FILE[ref.kind]}").`,
      };
    });
}

/** Extensions three's GLTFLoader decodes as Ludra sets it up (Draco and meshopt decoders included). */
const LOADER_EXTENSIONS = [
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_mesh_quantization",
  "KHR_texture_transform",
  "EXT_texture_webp",
  "KHR_lights_punctual",
];

const modelCache = new Map<string, { stamp: string; summary?: ModelSummary; error?: string }>();

/** Reads a model once per change of its file (path + mtime + size). */
function cachedModel(file: string): { summary?: ModelSummary; error?: string } {
  const stat = statSync(file);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = modelCache.get(file);
  if (cached?.stamp === stamp) return cached;
  let entry: { stamp: string; summary?: ModelSummary; error?: string };
  try {
    entry = { stamp, summary: readModel(file) };
  } catch (err) {
    entry = { stamp, error: (err as Error).message };
  }
  modelCache.set(file, entry);
  return entry;
}

/** Problems inside the models that meshes use: unreadable files, missing .bin/textures, unknown clips, extensions the renderer can't load. */
function modelProblems(project: Project, scene: SceneDef): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fromPrefabs = new Set<string>();
  const meshes: { mesh: unknown; at: string; prefab: boolean }[] = [
    ...Object.entries(scene.prefabs ?? {}).map(([name, prefab]) => ({ mesh: prefab.components?.mesh, at: `prefabs.${name}.components.mesh`, prefab: true })),
    ...scene.entities.map((entity, i) => ({ mesh: entity.components.mesh, at: `entities[${i}].components.mesh`, prefab: false })),
  ];
  for (const { mesh, at, prefab } of meshes) {
    const { model, animation, animations } = (mesh ?? {}) as { model?: unknown; animation?: unknown; animations?: unknown };
    if (typeof model !== "string" || model === "") continue;
    const file = resolve(project.dir, model);
    if (!isInside(project.dir, file) || !existsSync(file)) continue; // E_ASSET_MISSING
    const found: Diagnostic[] = [];
    const { summary, error } = cachedModel(file);
    if (!summary) {
      found.push({
        severity: "error",
        code: "E_MODEL_INVALID",
        path: `${at}.model`,
        message: error ?? `${model} can't be read.`,
        fix: "Re-export it as a glTF 2.0 binary (.glb), e.g. File > Export > glTF 2.0 in Blender, and check it with `ludra inspect`.",
      });
    } else {
      const missing = summary.externalFiles.filter((f) => !existsSync(join(dirname(file), f)));
      if (missing.length > 0) {
        found.push({
          severity: "error",
          code: "E_MODEL_FILE_MISSING",
          path: `${at}.model`,
          message: `${model} needs ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not next to it.`,
          fix: "Copy the files next to the model, or export a single .glb that embeds them.",
        });
      }

      const clips = summary.animations.map((a) => a.name);
      const fields: [string, unknown][] = [["animation", animation]];
      if (animations && typeof animations === "object") fields.push(...Object.entries(animations).map(([state, clip]): [string, unknown] => [`animations.${state}`, clip]));
      for (const [field, clip] of fields) {
        // "" means no clip.
        if (typeof clip !== "string" || clip === "" || clips.includes(clip)) continue;
        const suggestion = closestName(clip, clips);
        found.push({
          severity: "error",
          code: "E_MODEL_ANIMATION",
          path: `${at}.${field}`,
          message: `${model} has no animation "${clip}".`,
          fix:
            clips.length === 0
              ? `This model has no animations; remove "${field}" or use a model with animations.`
              : `${suggestion ? `Did you mean "${suggestion}"? ` : ""}Its clips: ${clips.map((c) => `"${c}"`).join(", ")}.`,
        });
      }

      const unsupported = summary.extensionsRequired.filter((e) => !LOADER_EXTENSIONS.includes(e) && !e.startsWith("KHR_materials_"));
      if (unsupported.length > 0) {
        found.push({
          severity: "warning",
          code: "W_MODEL_EXTENSION",
          path: `${at}.model`,
          message: unsupported.includes("KHR_texture_basisu")
            ? `${model} uses KTX2 textures (KHR_texture_basisu), which the renderer can't decode yet${unsupported.length > 1 ? `; it also requires ${unsupported.filter((e) => e !== "KHR_texture_basisu").join(", ")}` : ""}.`
            : `${model} requires ${unsupported.join(", ")}, which the renderer can't load.`,
          fix: "Re-export it with PNG, JPEG or WebP textures and without those extensions.",
        });
      }
    }
    // An entity made from a prefab repeats the prefab's problems; report them once, on the prefab.
    for (const d of found) {
      const key = `${d.code}\n${d.message}\n${d.path.slice(at.length)}`;
      if (prefab) fromPrefabs.add(key);
      else if (fromPrefabs.has(key)) continue;
      diagnostics.push(d);
    }
  }
  return diagnostics;
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
export async function loadGame(project: Project, scenePath?: string): Promise<{ game?: Game; diagnostics: Diagnostic[]; label: string }> {
  const { scene, diagnostics, label } = readScene(project, scenePath);
  if (!scene) return { diagnostics, label };
  // Rapier is WebAssembly loaded on demand, so arcade games never pay for it.
  const engine = physicsEngineName(scene);
  if (engine === "rapier") await (await import("@ludra/physics")).loadRapierPhysics();
  if (engine === "rapier3d") await (await import("@ludra/physics")).loadRapier3DPhysics();

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
  return { game: ok ? { scene, scripts } : undefined, diagnostics, label };
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
export async function requireGame(project: Project, scenePath?: string): Promise<Game> {
  const { game, diagnostics, label } = await loadGame(project, scenePath);
  if (!game) {
    throw new CliError(`${formatDiagnostics(diagnostics, label)}\n\nFix the errors above (see \`ludra check\`) and try again.`);
  }
  return game;
}

export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Like `readScene`, but stops with the diagnostics when the scene has errors. */
export function requireScene(project: Project, scenePath?: string): SceneDef {
  const { scene, diagnostics, label } = readScene(project, scenePath);
  if (!scene) {
    throw new CliError(`${formatDiagnostics(diagnostics, label)}\n\nFix the errors above (see \`ludra check\`) and try again.`);
  }
  return scene;
}
