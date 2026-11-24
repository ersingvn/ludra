// The running scene's file, as the inspector edits it (docs/editor.md, part A): its JSON and version from
// GET /__ludra/file, the prefabs its entities use, and edits sent with that version. Studio keeps no copy
// of its own beyond this: every edit goes to the file, and the file is read again after each change.

import type { Backend } from "../backend.ts";
import type { Edit, EditResult } from "../protocol.ts";

type Obj = Record<string, unknown>;
export type Components = Record<string, unknown>;

export interface FileEntity {
  index: number;
  id: string;
  prefab?: string;
  components: Components;
}

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export class SceneDoc {
  path: string | null = null;
  version = "";
  scene: Obj | null = null;
  /** Why the file couldn't be read, when it couldn't. */
  error: string | null = null;
  /** Prefab components by name: null when there's no such file. */
  private prefabs = new Map<string, Components | null | "loading">();
  private loads = 0;

  private readonly backend: Backend;
  /** Called whenever what the doc holds changes. */
  private readonly changed: () => void;

  constructor(backend: Backend, changed: () => void) {
    this.backend = backend;
    this.changed = changed;
  }

  get loaded(): boolean {
    return this.scene !== null || this.error !== null;
  }

  async load(path: string | null): Promise<void> {
    const n = ++this.loads;
    if (path !== this.path) {
      this.path = path;
      this.scene = null;
      this.error = null;
      this.version = "";
    }
    if (!path) return this.changed();
    try {
      const file = await this.backend.file(path);
      if (n !== this.loads) return;
      const scene = JSON.parse(file.text) as unknown;
      this.scene = isObject(scene) ? scene : null;
      this.version = file.version;
      this.error = this.scene ? null : `${path} isn't a scene object.`;
    } catch (err) {
      if (n !== this.loads) return;
      this.scene = null;
      this.error = err instanceof SyntaxError ? `${path} isn't valid JSON right now: ${err.message}` : String(err instanceof Error ? err.message : err);
    }
    this.changed();
  }

  /** Reads again what changed: the scene, or a prefab the scene uses. */
  filesChanged(paths: string[]): void {
    let prefab = false;
    for (const name of [...this.prefabs.keys()]) {
      if (paths.includes(prefabPath(name))) {
        this.prefabs.delete(name);
        prefab = true;
      }
    }
    if (this.path && paths.includes(this.path)) void this.load(this.path);
    else if (prefab) this.changed();
  }

  entity(id: string): FileEntity | undefined {
    const list = Array.isArray(this.scene?.entities) ? (this.scene!.entities as unknown[]) : [];
    const index = list.findIndex((e) => isObject(e) && e.id === id);
    if (index < 0) return undefined;
    const e = list[index] as Obj;
    return { index, id, prefab: typeof e.prefab === "string" ? e.prefab : undefined, components: isObject(e.components) ? e.components : {} };
  }

  entityAt(index: number): string | undefined {
    const e = Array.isArray(this.scene?.entities) ? (this.scene!.entities as unknown[])[index] : undefined;
    return isObject(e) && typeof e.id === "string" ? e.id : undefined;
  }

  /** The tilemap entity that makes `id` (named `<tilemap>-<row>-<col>`), if one does. */
  tilemapOf(id: string): string | undefined {
    const list = Array.isArray(this.scene?.entities) ? (this.scene!.entities as unknown[]) : [];
    for (const e of list) {
      if (!isObject(e) || typeof e.id !== "string" || !isObject(e.components) || e.components.tilemap === undefined) continue;
      if (id.startsWith(`${e.id}-`) && /^\d+-\d+$/.test(id.slice(e.id.length + 1))) return e.id;
    }
    return undefined;
  }

  ids(): Set<string> {
    const list = Array.isArray(this.scene?.entities) ? (this.scene!.entities as unknown[]) : [];
    return new Set(list.filter(isObject).map((e) => String(e.id)));
  }

  /**
   * A prefab's components: the scene's own "prefabs" first (they win, as in `ludra check`), else
   * prefabs/<name>.prefab.json. Undefined while it loads (then `changed` fires), null if there's none.
   */
  prefab(name: string): Components | null | undefined {
    const own = isObject(this.scene?.prefabs) ? (this.scene!.prefabs as Obj)[name] : undefined;
    if (isObject(own)) return isObject(own.components) ? own.components : {};
    const cached = this.prefabs.get(name);
    if (cached === "loading") return undefined;
    if (cached !== undefined) return cached;
    this.prefabs.set(name, "loading");
    this.backend.file(prefabPath(name)).then(
      (file) => {
        let components: Components | null = null;
        try {
          const json = JSON.parse(file.text) as unknown;
          components = isObject(json) && isObject(json.components) ? json.components : {};
        } catch {
          components = null;
        }
        this.prefabs.set(name, components);
        this.changed();
      },
      () => {
        this.prefabs.set(name, null);
        this.changed();
      },
    );
    return undefined;
  }

  /** Sends edits against the version on hand. On success the file is read again before this returns. */
  async edit(edits: Edit[], label: string): Promise<EditResult> {
    if (!this.path) return { ok: false, status: 400, error: "No scene is open." };
    const result = await this.backend.edit({ path: this.path, version: this.version, edits, label });
    if (result.ok) {
      this.version = result.version;
      await this.load(this.path);
    } else if (result.status === 409) {
      await this.load(this.path);
    }
    return result;
  }
}

export function prefabPath(name: string): string {
  return name.includes("/") || name.endsWith(".json") ? name : `prefabs/${name}.prefab.json`;
}

/** A prefab's components with the entity's overrides on top, one level deep; null drops one (as the engine merges them). */
export function mergeComponents(base: Components | null | undefined, overrides: Components): Components {
  const merged: Components = {};
  for (const [name, value] of Object.entries(base ?? {})) if (isObject(value)) merged[name] = { ...value };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete merged[name];
    else if (isObject(value) && isObject(merged[name])) merged[name] = { ...(merged[name] as Obj), ...value };
    else merged[name] = value;
  }
  return merged;
}
