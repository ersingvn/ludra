// The mock's scene file: what `ludra dev --studio` does for /__ludra/file, /edit, /undo and /redo, kept in
// memory. The same rules as the server (all or nothing, 409 on a stale version, 422 when the result has
// errors, 400 for a bad edit), with a small stand-in for `ludra check`. Not the engine's validation.

import type { Diagnostic, Edit, EditRequest, EditResult, FileChange, FileText, UndoResult } from "../protocol.ts";
import { mockScene, MOCK_PROJECT, type MockEntity } from "./scene.ts";

/** What the mock game should do to show a change: like a hot reload. */
export type GameOp =
  | { op: "set"; id: string; path: string[]; value?: unknown }
  | { op: "add"; entity: MockEntity; after?: string | null }
  | { op: "remove"; id: string }
  | { op: "rename"; id: string; to: string }
  | { op: "load"; entities: MockEntity[] };

interface Done {
  path: string;
  label: string;
  before: MockEntity[];
  after: MockEntity[];
  /** The file's version right after this edit: undo refuses when the file has moved on. */
  version: string;
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export class MockSceneFile {
  readonly path = MOCK_PROJECT.entry;
  entities: MockEntity[] = mockScene();
  private n = 1;
  private done: Done[] = [];
  private undone: Done[] = [];

  private readonly changed: (files: FileChange[], by: "studio" | "files", label?: string) => void;
  private readonly apply: (ops: GameOp[]) => void;

  constructor(
    /** Tells Studio a file changed (the /events stream). */
    changed: (files: FileChange[], by: "studio" | "files", label?: string) => void,
    /** Shows a change in the mock game. */
    apply: (ops: GameOp[]) => void,
  ) {
    this.changed = changed;
    this.apply = apply;
  }

  get version(): string {
    return `mock-${this.n}`;
  }

  text(entities = this.entities): string {
    return `${JSON.stringify({ name: "Lantern Steps", entities }, null, 2)}\n`;
  }

  file(path: string): FileText {
    if (path !== this.path) throw new Error(`GET /__ludra/file: 404 (the mock only has ${this.path})`);
    return { path, version: this.version, text: this.text() };
  }

  /** The agent changed the file: a new version, so Studio's older edits are refused. */
  agentChanged(ops: GameOp[]): void {
    for (const op of ops) applyOp(this.entities, op);
    this.n++;
  }

  edit(req: EditRequest): EditResult {
    if (req.path !== this.path) return { ok: false, status: 400, error: `${req.path} isn't a scene in the mock. Edit ${this.path}.` };
    if (req.version !== this.version) return { ok: false, status: 409, error: `${req.path} changed since you loaded it (the agent wrote it). Load it again.`, version: this.version };
    if (!Array.isArray(req.edits) || req.edits.length === 0) return { ok: false, status: 400, error: "edits must be a non-empty list." };
    const next = clone(this.entities);
    const ops: GameOp[] = [];
    for (const edit of req.edits) {
      const problem = editOne(next, edit, ops);
      if (problem) return { ok: false, status: 400, error: problem };
    }
    const errors = check(next);
    if (errors.length > 0) return { ok: false, status: 422, diagnostics: errors };
    const before = this.entities;
    this.write(next, req.label ?? describe(req.edits), ops);
    this.done.push({ path: this.path, label: req.label ?? describe(req.edits), before, after: clone(next), version: this.version });
    this.undone = [];
    return { ok: true, version: this.version, diagnostics: [] };
  }

  undo(): UndoResult {
    return this.travel(this.done, this.undone, "before");
  }

  redo(): UndoResult {
    return this.travel(this.undone, this.done, "after");
  }

  private travel(from: Done[], to: Done[], side: "before" | "after"): UndoResult {
    const entry = from[from.length - 1];
    if (!entry) return { ok: false };
    if (entry.version !== this.version) {
      return { ok: false, status: 409, error: `${entry.path} changed since "${entry.label}" (the agent wrote it), so undoing it would overwrite that work.` };
    }
    from.pop();
    this.write(clone(entry[side]), side === "before" ? `Undo ${entry.label}` : `Redo ${entry.label}`, [{ op: "load", entities: clone(entry[side]) }]);
    entry.version = this.version;
    to.push(entry);
    return { ok: true, path: entry.path, label: entry.label };
  }

  private write(entities: MockEntity[], label: string, ops: GameOp[]): void {
    const diff = lineDiff(this.path, this.text(), this.text(entities));
    this.entities = entities;
    this.n++;
    this.changed([{ path: this.path, kind: "scene", change: "changed", ...(diff ? { diff } : {}) }], "studio", label);
    this.apply(ops);
  }
}

/** Applies one edit to the entity list, or says why it can't. */
function editOne(entities: MockEntity[], edit: Edit, ops: GameOp[]): string | undefined {
  const index = (id: string) => entities.findIndex((e) => e.id === id);
  switch (edit.op) {
    case "set": {
      const at = index(edit.entity);
      if (at < 0) return `There is no entity "${edit.entity}" in the scene file.`;
      const path = String(edit.field ?? "").split(".").filter(Boolean);
      if (path.length === 0) return 'field must name what to change, e.g. "components.transform.x".';
      if (path.length === 1 && path[0] === "id") {
        if (typeof edit.value !== "string" || edit.value === "") return "An id must be a non-empty string.";
        if (index(edit.value) >= 0) return `The id "${edit.value}" is taken. Pick another.`;
        ops.push({ op: "rename", id: edit.entity, to: edit.value });
        entities[at]!.id = edit.value;
        return undefined;
      }
      const op: GameOp = { op: "set", id: edit.entity, path, ...("value" in edit ? { value: clone(edit.value) } : {}) };
      applyOp(entities, op);
      ops.push(op);
      return undefined;
    }
    case "add": {
      const entity = edit.entity as MockEntity;
      if (!entity || typeof entity.id !== "string" || entity.id === "") return "add needs an entity with an id.";
      if (index(entity.id) >= 0) return `The id "${entity.id}" is taken. Pick another.`;
      if (typeof edit.after === "string" && index(edit.after) < 0) return `There is no entity "${edit.after}" to add after.`;
      const op: GameOp = { op: "add", entity: clone({ ...entity, components: entity.components ?? {} }), after: edit.after };
      applyOp(entities, op);
      ops.push(op);
      return undefined;
    }
    case "remove": {
      if (index(edit.entity) < 0) return `There is no entity "${edit.entity}" in the scene file.`;
      applyOp(entities, { op: "remove", id: edit.entity });
      ops.push({ op: "remove", id: edit.entity });
      return undefined;
    }
    case "scene":
      // The mock's scene has nothing but entities worth showing; a scene-level edit is accepted and kept out of the game.
      return undefined;
    default:
      return `Unknown op ${JSON.stringify((edit as { op?: unknown }).op)}. Use set, add, remove or scene.`;
  }
}

/** Shared by the mock file and the mock game, so both show the same thing. */
export function applyOp(entities: MockEntity[], op: GameOp): void {
  const at = (id: string) => entities.findIndex((e) => e.id === id);
  switch (op.op) {
    case "set": {
      const e = entities[at(op.id)];
      if (!e) return;
      let target: any = e;
      for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
      const last = op.path[op.path.length - 1]!;
      if ("value" in op) target[last] = op.value;
      else delete target[last];
      return;
    }
    case "add": {
      // after: null → first; left out (or gone) → last; an id → right after it.
      const after = typeof op.after === "string" ? at(op.after) : -1;
      const where = op.after === null ? 0 : after >= 0 ? after + 1 : entities.length;
      entities.splice(where, 0, op.entity);
      return;
    }
    case "remove": {
      const i = at(op.id);
      if (i >= 0) entities.splice(i, 1);
      return;
    }
    case "rename": {
      const e = entities[at(op.id)];
      if (e) e.id = op.to;
      return;
    }
    case "load":
      entities.splice(0, entities.length, ...op.entities);
  }
}

/** A stand-in for `ludra check`: the errors an edit in the inspector or viewport can cause. */
function check(entities: MockEntity[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  entities.forEach((e, i) => {
    const body = e.components?.body;
    for (const key of ["width", "height"] as const) {
      const value = body?.[key];
      if (body && value !== undefined && !(typeof value === "number" && value > 0)) {
        out.push({
          severity: "error",
          code: "E_INVALID_FIELD",
          path: `entities[${i}].components.body.${key}`,
          message: `body.${key} on entity "${e.id}" must be at least 0.001, got ${JSON.stringify(value)}.`,
          fix: `Collider ${key} (2D px, 3D m).`,
          file: MOCK_PROJECT.entry,
        });
      }
    }
    const x = e.components?.transform?.x;
    if (e.components?.transform && typeof x !== "number") {
      out.push({ severity: "error", code: "E_INVALID_FIELD", path: `entities[${i}].components.transform.x`, message: `transform.x on entity "${e.id}" must be a number, got ${JSON.stringify(x)}.`, fix: "Center x (2D px, 3D m).", file: MOCK_PROJECT.entry });
    }
  });
  return out;
}

function describe(edits: Edit[]): string {
  const first = edits[0]!;
  const what = first.op === "add" ? `Added ${first.entity.id}` : first.op === "remove" ? `Removed ${first.entity}` : first.op === "set" ? `Changed ${first.entity} ${first.field}` : `Changed ${first.field}`;
  return edits.length > 1 ? `${what} and ${edits.length - 1} more` : what;
}

/** A unified diff of the one changed stretch (the mock's files are small and change in one place). */
function lineDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === a.length && start === b.length) return "";
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - 3);
  const toA = Math.min(a.length, endA + 3);
  const toB = Math.min(b.length, endB + 3);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
    ...a.slice(endA, toA).map((l) => ` ${l}`),
  ];
  return lines.join("\n");
}
