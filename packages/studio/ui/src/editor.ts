// What the viewport tools, the palette and the hierarchy's menu do to the scene file (docs/editor.md,
// part B), through part A's /__ludra/file, /edit, /undo and /redo. Studio keeps no copy of the scene:
// it reads the file before an edit and names the version it read, so an edit never lands on top of
// work the agent wrote in between. No DOM here, so it can be tested against the mock's scene file.

import type { Backend } from "./backend.ts";
import type { Diagnostic, Edit, EntityJson } from "./protocol.ts";
import type { Toast } from "./studio.ts";
import { duplicateEdit, placeEdit, reorderEdits, sceneEntities, type Point } from "./tools.ts";

export interface EditorHost {
  backend: Pick<Backend, "file" | "edit" | "undo" | "redo" | "run">;
  /** The running scene's file, or null before the game is ready. */
  scene(): string | null;
  /** Ids the running world has, so a new id is free in the game too, not only in the file. */
  liveIds(): string[];
  toast(t: Toast): void;
}

interface Loaded {
  path: string;
  version: string;
  entities: EntityJson[];
}

export class Editor {
  private readonly host: EditorHost;
  private loaded: Loaded | null = null;
  /** One edit at a time, in the order the person made them. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(host: EditorHost) {
    this.host = host;
  }

  /** A file changed (anyone wrote it): read it again before the next edit. */
  changed(paths: string[]): void {
    if (this.loaded && paths.includes(this.loaded.path)) this.loaded = null;
  }

  /** The scene file's entities as they are now. */
  async entities(): Promise<EntityJson[]> {
    return (await this.load()).entities;
  }

  /** The entity as the scene file holds it, or undefined when the file doesn't (a tilemap made it, or a script spawned it). */
  async entity(id: string): Promise<EntityJson | undefined> {
    return (await this.load()).entities.find((e) => e.id === id);
  }

  move(id: string, to: Point): Promise<boolean> {
    return this.on(id, (e) => {
      const t = (e.components?.transform ?? {}) as Record<string, unknown>;
      const edits: Edit[] = [];
      if (t.x !== to.x) edits.push({ op: "set", entity: id, field: "components.transform.x", value: to.x });
      if (t.y !== to.y) edits.push({ op: "set", entity: id, field: "components.transform.y", value: to.y });
      return edits.length > 0 ? { edits, label: `Moved ${id}` } : undefined;
    });
  }

  /** Alt+drag and Ctrl+D: a copy with a fresh id, `offset` from the original. */
  duplicate(id: string, offset: Point): Promise<string | undefined> {
    let made: string | undefined;
    return this.on(id, (e, all) => {
      const edit = duplicateEdit(e, [...all.map((x) => x.id), ...this.host.liveIds()], offset);
      made = edit.entity.id;
      return { edits: [edit], label: `Duplicated ${id} as ${made}` };
    }).then((ok) => (ok ? made : undefined));
  }

  remove(id: string): Promise<boolean> {
    return this.on(id, () => ({ edits: [{ op: "remove", entity: id }], label: `Deleted ${id}` }));
  }

  rename(id: string, to: string): Promise<boolean> {
    const next = to.trim();
    if (!next || next === id) return Promise.resolve(false);
    return this.on(id, (_e, all) => {
      if (all.some((x) => x.id === next) || this.host.liveIds().includes(next)) {
        this.host.toast({ kind: "error", title: `"${next}" is taken`, detail: "Pick another id." });
        return undefined;
      }
      return { edits: [{ op: "set", entity: id, field: "id", value: next }], label: `Renamed ${id} to ${next}` };
    });
  }

  /** Drag in the hierarchy: moves `id` before or after `target` in the file. */
  reorder(id: string, target: string, place: "before" | "after"): Promise<boolean> {
    return this.on(id, (_e, all) => {
      if (!all.some((x) => x.id === target)) return undefined;
      const edits = reorderEdits(all, id, target, place);
      return edits ? { edits, label: `Moved ${id} ${place} ${target}` } : undefined;
    });
  }

  /** The palette: a prefab where the person clicked. Answers the new id. */
  placePrefab(prefab: string, at: Point): Promise<string | undefined> {
    let made: string | undefined;
    return this.write(async () => {
      const { entities } = await this.load();
      const edit = placeEdit(prefab, at, [...entities.map((e) => e.id), ...this.host.liveIds()]);
      made = edit.entity.id;
      return { edits: [edit], label: `Placed ${made}` };
    }).then((ok) => (ok ? made : undefined));
  }

  /** The palette: a block from the library, through `ludra add <block> --at x,y`. */
  placeBlock(block: string, at: Point): Promise<boolean> {
    return this.serial(async () => {
      try {
        const res = await this.host.backend.run<{ error?: string }>("add", [block, "--at", `${Math.round(at.x)},${Math.round(at.y)}`]);
        const error = res.result && typeof res.result === "object" ? res.result.error : undefined;
        if (!res.ok || error) {
          this.host.toast({ kind: "error", title: `Couldn't add ${block}`, detail: error ?? `ludra add exited with ${res.exitCode}` });
          return false;
        }
        this.loaded = null;
        return true;
      } catch (err) {
        this.host.toast({ kind: "error", title: `Couldn't add ${block}`, detail: message(err) });
        return false;
      }
    });
  }

  undo(): Promise<boolean> {
    return this.history("undo");
  }

  redo(): Promise<boolean> {
    return this.history("redo");
  }

  private history(which: "undo" | "redo"): Promise<boolean> {
    return this.serial(async () => {
      try {
        const res = await (which === "undo" ? this.host.backend.undo() : this.host.backend.redo());
        if (res.ok) {
          this.loaded = null;
          return true;
        }
        if (res.status === 409) this.host.toast({ kind: "error", title: `Can't ${which}`, detail: res.error ?? "The agent changed that file since, and undoing would overwrite its work." });
        else this.host.toast({ kind: "info", title: which === "undo" ? "Nothing to undo" : "Nothing to redo" });
        return false;
      } catch (err) {
        this.host.toast({ kind: "error", title: `Couldn't ${which}`, detail: message(err) });
        return false;
      }
    });
  }

  /** An edit to one entity the scene file holds; says why not when it doesn't hold it. */
  private on(id: string, make: (e: EntityJson, all: EntityJson[]) => { edits: Edit[]; label: string } | undefined): Promise<boolean> {
    return this.write(async () => {
      const { path, entities } = await this.load();
      const e = entities.find((x) => x.id === id);
      if (!e) {
        this.host.toast({ kind: "error", title: `${id} isn't in ${path}`, detail: "A tilemap or a script made it, so edit what made it instead." });
        return undefined;
      }
      return make(e, entities);
    });
  }

  /**
   * Makes edits against the file as it is and sends them. When the agent wrote the file in between
   * (409), reads it again and makes them once more against the new version, so a drag isn't lost and
   * nothing the agent wrote is overwritten: the edits only touch what the person changed.
   */
  private write(make: () => Promise<{ edits: Edit[]; label: string } | undefined>): Promise<boolean> {
    return this.serial(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let made: { edits: Edit[]; label: string } | undefined;
        let path: string;
        let version: string;
        try {
          ({ path, version } = await this.load());
          made = await make();
        } catch (err) {
          this.host.toast({ kind: "error", title: "Couldn't read the scene", detail: message(err) });
          return false;
        }
        if (!made || made.edits.length === 0) return false;
        let res;
        try {
          res = await this.host.backend.edit({ path, version, edits: made.edits, label: made.label });
        } catch (err) {
          this.host.toast({ kind: "error", title: `Couldn't save: ${made.label}`, detail: message(err) });
          return false;
        }
        if (res.ok) {
          // The text changed; the next edit reads it again (the change event says so too).
          this.loaded = null;
          return true;
        }
        this.loaded = null;
        if (res.status === 409 && attempt === 0) continue;
        this.host.toast(refusal(made.label, res.status, res.error, res.diagnostics));
        return false;
      }
      return false;
    });
  }

  private async load(): Promise<Loaded> {
    const path = this.host.scene();
    if (!path) throw new Error("The game hasn't started a scene yet.");
    if (this.loaded?.path === path) return this.loaded;
    const file = await this.host.backend.file(path);
    this.loaded = { path, version: file.version, entities: sceneEntities(file.text) };
    return this.loaded;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function refusal(label: string, status: number, error?: string, diagnostics?: Diagnostic[]): Toast {
  if (status === 422) {
    const d = diagnostics?.find((x) => x.severity === "error") ?? diagnostics?.[0];
    return { kind: "error", title: `Not saved: ${label}`, detail: d ? `${d.message}${d.fix ? ` ${d.fix}` : ""}` : "The scene wouldn't pass check." };
  }
  if (status === 409) return { kind: "error", title: `Not saved: ${label}`, detail: "The agent keeps changing this scene. Try again in a moment." };
  return { kind: "error", title: `Not saved: ${label}`, detail: error ?? `The server refused it (${status}).` };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
