// The edit calls the viewport tools make (docs/editor.md, part A's endpoints), as agreed with part A.
// Until part A's backend lands they may be missing: `editApi` then says so instead of failing later.
// When protocol.ts has Edit / EditResult / FileText, these local copies can go.

import type { Backend } from "./backend.ts";
import type { Command, Diagnostic, RunResponse } from "./protocol.ts";

export interface EntityDefJson {
  id: string;
  name?: string;
  prefab?: string;
  components?: Record<string, unknown>;
  [field: string]: unknown;
}

export type SceneEdit =
  | { op: "set"; entity: string; field: string; value?: unknown }
  | { op: "add"; entity: EntityDefJson; after?: string | null }
  | { op: "remove"; entity: string }
  | { op: "scene"; field: string; value?: unknown };

export interface EditRequest {
  path: string;
  version: string;
  edits: SceneEdit[];
  label?: string;
}

export type EditOutcome =
  | { ok: true; version: string; diagnostics?: Diagnostic[] }
  | { ok: false; status: 409 | 422 | 400; error?: string; version?: string; diagnostics?: Diagnostic[] };

export type UndoOutcome = { ok: true; path: string; label?: string } | { ok: false; status?: number; error?: string };

export interface FileContents {
  path: string;
  version: string;
  text: string;
}

export interface EditApi {
  file(path: string): Promise<FileContents>;
  edit(request: EditRequest): Promise<EditOutcome>;
  undo(): Promise<UndoOutcome>;
  redo(): Promise<UndoOutcome>;
  run<T>(command: Command, args?: string[]): Promise<RunResponse<T>>;
}

/** The backend's edit calls, or undefined when this backend has none yet. */
export function editApi(backend: Backend): EditApi | undefined {
  const b = backend as Backend & Partial<EditApi>;
  if (typeof b.file !== "function" || typeof b.edit !== "function" || typeof b.undo !== "function" || typeof b.redo !== "function") return undefined;
  return {
    file: (path) => b.file!(path),
    edit: (request) => b.edit!(request),
    undo: () => b.undo!(),
    redo: () => b.redo!(),
    run: (command, args) => backend.run(command, args),
  };
}
