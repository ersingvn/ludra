import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EffectDef, EntityDef, SceneDef } from "@ludra/core";
import { CliError } from "./project.ts";

/** Same relative location from `src/` and `dist/`. */
export const BLOCKS_DIR = fileURLToPath(new URL("../blocks/", import.meta.url));

/**
 * A reusable piece of gameplay: entities, the scripts and art they use, and
 * effects. Entity transforms are offsets (`dx`, `dy`) from the anchor given
 * to `ludra add --at`. Every string may use `{id}`, replaced by the id prefix.
 */
export interface BlockManifest {
  name: string;
  description: string;
  tags: string[];
  /** What `--at` means for this block and how to tune it. */
  usage: string;
  /** False for blocks that are not placed in the world (a time limit). */
  positioned?: boolean;
  entities: { id: string; components: Record<string, Record<string, unknown>> }[];
  /** Files copied into the project at the same relative path. */
  files: string[];
  effects?: Record<string, EffectDef>;
}

export interface Block extends BlockManifest {
  dir: string;
}

export function listBlocks(): Block[] {
  if (!existsSync(BLOCKS_DIR)) return [];
  return readdirSync(BLOCKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(BLOCKS_DIR, entry.name, "block.json")))
    .map((entry) => loadBlock(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadBlock(name: string): Block {
  const dir = join(BLOCKS_DIR, name);
  const file = join(dir, "block.json");
  if (!existsSync(file)) {
    const names = existsSync(BLOCKS_DIR) ? readdirSync(BLOCKS_DIR).join(", ") : "none";
    throw new CliError(`Unknown block "${name}". Blocks: ${names}. Run \`ludra blocks\` to see what each one does.`);
  }
  return { ...(JSON.parse(readFileSync(file, "utf8")) as BlockManifest), dir };
}

/** Replaces `{id}` in every string, recursively. */
function substitute<T>(value: T, id: string): T {
  if (typeof value === "string") return value.replaceAll("{id}", id) as T;
  if (Array.isArray(value)) return value.map((v) => substitute(v, id)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, id)])) as T;
  }
  return value;
}

/** Picks `base`, or `base-2`, `base-3`… so none of the block's entity ids clash with the scene. */
function uniquePrefix(block: Block, base: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const prefix = n === 1 ? base : `${base}-${n}`;
    const ids = block.entities.map((e) => e.id.replaceAll("{id}", prefix));
    if (ids.every((id) => !taken.has(id))) return prefix;
  }
}

export interface Placement {
  entities: EntityDef[];
  effects: Record<string, EffectDef>;
  prefix: string;
}

/** Turns a block into concrete entities at `at`, with ids that don't clash with `scene`. */
export function placeBlock(block: Block, scene: SceneDef, at: { x: number; y: number }, idBase?: string): Placement {
  const taken = new Set(scene.entities.map((e) => e.id));
  const prefix = uniquePrefix(block, idBase ?? block.name, taken);
  const entities = block.entities.map((template) => {
    const def = substitute(structuredClone(template), prefix);
    const offset = def.components.transform ?? {};
    def.components.transform = { x: at.x + ((offset.dx as number) ?? 0), y: at.y + ((offset.dy as number) ?? 0) };
    return def as EntityDef;
  });
  return { entities, effects: substitute(block.effects ?? {}, prefix), prefix };
}

export interface AddResult {
  block: string;
  prefix: string;
  entities: { id: string; x: number; y: number }[];
  files: { path: string; status: "added" | "unchanged" | "kept yours" | "replaced" }[];
  effects: string[];
}

/**
 * Adds a block to a project: copies its files (never overwriting a file the
 * user changed unless `force`), appends its entities to the scene and merges
 * effects the scene doesn't define yet.
 */
export function addBlock(
  projectDir: string,
  scenePath: string,
  block: Block,
  at: { x: number; y: number },
  options: { id?: string; force?: boolean } = {},
): AddResult {
  const scene = JSON.parse(readFileSync(scenePath, "utf8")) as SceneDef;
  const placement = placeBlock(block, scene, at, options.id);

  const files: AddResult["files"] = block.files.map((path) => {
    const source = readFileSync(join(block.dir, path));
    const target = join(projectDir, path);
    if (existsSync(target)) {
      if (readFileSync(target).equals(source)) return { path, status: "unchanged" as const };
      if (!options.force) return { path, status: "kept yours" as const };
    }
    const existed = existsSync(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    return { path, status: existed ? ("replaced" as const) : ("added" as const) };
  });

  scene.entities.push(...placement.entities);
  const effects: string[] = [];
  for (const [event, effect] of Object.entries(placement.effects)) {
    scene.effects ??= {};
    if (scene.effects[event]) continue;
    scene.effects[event] = effect;
    effects.push(event);
  }
  writeFileSync(scenePath, `${JSON.stringify(scene, null, 2)}\n`);

  return {
    block: block.name,
    prefix: placement.prefix,
    entities: placement.entities.map((e) => ({ id: e.id, x: e.components.transform!.x as number, y: e.components.transform!.y as number })),
    files,
    effects,
  };
}
