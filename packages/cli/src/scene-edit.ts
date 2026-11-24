import { createHash } from "node:crypto";

/**
 * Studio's edits to a scene file (docs/editor.md, part A): apply a list of edits to the file's JSON,
 * all or none, and write it back the way the agent wrote it. Everything the edits didn't touch is
 * copied from the old text byte for byte (key order, indentation, inline objects and arrays, number
 * spelling), so moving one entity is a one-line diff.
 */

export type Edit =
  | { op: "set"; entity: string; field: string; value?: unknown }
  | { op: "add"; entity: { id: string; [key: string]: unknown }; after?: string | null }
  | { op: "remove"; entity: string }
  | { op: "scene"; field: string; value?: unknown };

/** The version of a text, as /__ludra/file and /__ludra/edit name it. */
export function textVersion(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** A bad edit: the request is wrong, not the scene (400). */
export class EditError extends Error {}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Applies `edits` to a scene file's text and returns the new text. Throws EditError for a bad edit
 * (an unknown entity, one a tilemap makes, a taken id, a field that can't be reached).
 */
export function applyEdits(text: string, edits: unknown): string {
  let scene: unknown;
  try {
    scene = JSON.parse(text);
  } catch (err) {
    throw new EditError(`The file isn't valid JSON (${(err as Error).message}). Fix it in the file first.`);
  }
  if (!isObject(scene) || !Array.isArray(scene.entities)) throw new EditError('The file isn\'t a scene: it needs an "entities" list.');
  if (!Array.isArray(edits) || edits.length === 0) throw new EditError("edits must be a non-empty list.");
  const next = structuredClone(scene);
  for (const [i, edit] of edits.entries()) {
    try {
      applyOne(next, edit);
    } catch (err) {
      if (err instanceof EditError && edits.length > 1) throw new EditError(`edits[${i}]: ${err.message}`);
      throw err;
    }
  }
  return printLike(text, next as Json);
}

function applyOne(scene: Obj, edit: unknown): void {
  if (!isObject(edit)) throw new EditError("Each edit is an object with an op: set, add, remove or scene.");
  const entities = scene.entities as unknown[];
  const indexOf = (id: string) => entities.findIndex((e) => isObject(e) && e.id === id);
  const find = (id: unknown): number => {
    if (typeof id !== "string" || id === "") throw new EditError("entity must be the id of an entity in the scene file.");
    const at = indexOf(id);
    if (at < 0) throw new EditError(missing(scene, id));
    return at;
  };
  switch (edit.op) {
    case "set": {
      const entity = entities[find(edit.entity)] as Obj;
      const path = fieldPath(edit.field);
      if (path.length === 1 && path[0] === "id") {
        if (!("value" in edit) || typeof edit.value !== "string" || edit.value.trim() === "") throw new EditError("An id must be a non-empty string.");
        if (edit.value !== entity.id && indexOf(edit.value) >= 0) throw new EditError(`The id "${edit.value}" is taken. Pick another.`);
        entity.id = edit.value;
        return;
      }
      setPath(entity, path, edit, `entity "${String(edit.entity)}"`);
      return;
    }
    case "add": {
      const entity = edit.entity;
      if (!isObject(entity) || typeof entity.id !== "string" || entity.id.trim() === "") throw new EditError("add needs an entity with an id: { id, components }.");
      if (indexOf(entity.id) >= 0) throw new EditError(`The id "${entity.id}" is taken. Pick another.`);
      for (const key of keysDeep(entity)) if (FORBIDDEN.has(key)) throw new EditError(`"${key}" isn't a field.`);
      const copy = structuredClone(entity);
      if (edit.after === null) entities.unshift(copy);
      else if (edit.after === undefined) entities.push(copy);
      else {
        if (typeof edit.after !== "string") throw new EditError("after must be an entity id, null (first) or left out (last).");
        const at = indexOf(edit.after);
        if (at < 0) throw new EditError(`There is no entity "${edit.after}" to add after.`);
        entities.splice(at + 1, 0, copy);
      }
      return;
    }
    case "remove":
      entities.splice(find(edit.entity), 1);
      return;
    case "scene": {
      const path = fieldPath(edit.field);
      if (path[0] === "entities") throw new EditError('Entities aren\'t a scene field: use "set", "add" and "remove".');
      setPath(scene, path, edit, "the scene");
      return;
    }
    default:
      throw new EditError(`Unknown op ${JSON.stringify(edit.op)}. Use set, add, remove or scene.`);
  }
}

/** Why an id isn't in the file: a tilemap makes it, or nothing does. */
function missing(scene: Obj, id: string): string {
  for (const e of scene.entities as unknown[]) {
    if (!isObject(e) || typeof e.id !== "string" || !isObject(e.components) || e.components.tilemap === undefined) continue;
    if (new RegExp(`^${e.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+-\\d+$`).test(id)) {
      return `"${id}" is a cell of the tilemap "${e.id}", not an entity in the file. Edit the tilemap instead (components.tilemap.rows on "${e.id}").`;
    }
  }
  return `There is no entity "${id}" in the scene file. Entities spawned by scripts or made by a tilemap can't be edited here.`;
}

function fieldPath(field: unknown): string[] {
  if (typeof field !== "string" || field === "") throw new EditError('field must name what to change, e.g. "components.transform.x".');
  const path = field.split(".");
  if (path.some((part) => part === "")) throw new EditError(`"${field}" isn't a field path: parts are separated by single dots.`);
  for (const part of path) if (FORBIDDEN.has(part)) throw new EditError(`"${part}" isn't a field.`);
  return path;
}

/** Sets (or, without `value`, removes) a dotted path, making the objects on the way. */
function setPath(root: Obj, path: string[], edit: Obj, where: string): void {
  let target: unknown = root;
  for (const [i, key] of path.slice(0, -1).entries()) {
    const holder = target as Obj | unknown[];
    let next = Array.isArray(holder) ? holder[arrayIndex(holder, key, path, i)] : holder[key];
    if (next === undefined) {
      if (!("value" in edit)) return; // removing what isn't there
      next = {};
      if (Array.isArray(holder)) holder[Number(key)] = next;
      else holder[key] = next;
    }
    if (typeof next !== "object" || next === null) {
      throw new EditError(`${path.slice(0, i + 1).join(".")} on ${where} is ${JSON.stringify(next)}, not an object, so it has no "${path[i + 1]}".`);
    }
    target = next;
  }
  const last = path[path.length - 1]!;
  if ("value" in edit && edit.value !== undefined) {
    for (const key of keysDeep(edit.value)) if (FORBIDDEN.has(key)) throw new EditError(`"${key}" isn't a field.`);
  }
  if (Array.isArray(target)) {
    const at = arrayIndex(target, last, path, path.length - 1, true);
    if (!("value" in edit) || edit.value === undefined) target.splice(at, 1);
    else target[at] = structuredClone(edit.value);
  } else {
    const obj = target as Obj;
    if (!("value" in edit) || edit.value === undefined) delete obj[last];
    else obj[last] = structuredClone(edit.value);
  }
}

function arrayIndex(list: unknown[], key: string, path: string[], i: number, append = false): number {
  const n = Number(key);
  if (!/^\d+$/.test(key) || n > list.length || (!append && n === list.length)) {
    throw new EditError(`${path.slice(0, i).join(".")} is a list of ${list.length}: "${key}" isn't an index in it.`);
  }
  return n;
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Printing like the old text.

/** A parsed JSON value with where it is in the text. */
type Node =
  | { kind: "object"; start: number; end: number; value: Json; members: { key: string; node: Node }[] }
  | { kind: "array"; start: number; end: number; value: Json; items: Node[] }
  | { kind: "primitive"; start: number; end: number; value: Json };

/** Parses JSON text that JSON.parse already accepted, keeping each value's span. */
function parseSpans(text: string): Node {
  let i = 0;
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++;
  };
  const string = (): string => {
    const start = i;
    i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): Node => {
    ws();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const members: { key: string; node: Node }[] = [];
      const obj: Record<string, Json> = {};
      ws();
      if (text[i] === "}") i++;
      else {
        for (;;) {
          ws();
          const key = string();
          ws();
          i++; // :
          const node = value();
          members.push({ key, node });
          obj[key] = node.value;
          ws();
          if (text[i++] === "}") break; // else ,
        }
      }
      return { kind: "object", start, end: i, value: obj, members };
    }
    if (c === "[") {
      i++;
      const items: Node[] = [];
      ws();
      if (text[i] === "]") i++;
      else {
        for (;;) {
          items.push(value());
          ws();
          if (text[i++] === "]") break;
        }
      }
      return { kind: "array", start, end: i, value: items.map((n) => n.value), items };
    }
    if (c === '"') {
      const s = string();
      return { kind: "primitive", start, end: i, value: s };
    }
    while (i < text.length && /[-+0-9.eEtrufalsn]/.test(text[i]!)) i++;
    return { kind: "primitive", start, end: i, value: JSON.parse(text.slice(start, i)) as Json };
  };
  return value();
}

interface Style {
  /** One level of indentation. */
  unit: string;
  eol: string;
}

/** `next` printed the way `text` is: unchanged parts copied, changed parts in the file's style. */
export function printLike(text: string, next: Json): string {
  const root = parseSpans(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indented = /\n([ \t]+)\S/.exec(text);
  const unit = indented ? (indented[1]!.startsWith("\t") ? "\t" : " ".repeat(Math.min(indented[1]!.length, 8))) : "  ";
  const style: Style = { unit, eol };
  const lead = text.slice(0, root.start);
  const tail = text.slice(root.end);
  return `${lead}${print(next, root, text, "", style)}${tail.endsWith("\n") ? tail : `${tail}${eol}`}`;
}

/** The indentation of the line `at` is on. */
function lineIndent(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))![0];
}

function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as Json[];
    return a.length === bb.length && a.every((v, i) => sameJson(v, bb[i]!));
  }
  const ka = Object.keys(a);
  const bo = b as Record<string, Json>;
  return ka.length === Object.keys(bo).length && ka.every((k) => Object.hasOwn(bo, k) && sameJson((a as Record<string, Json>)[k]!, bo[k]!));
}

function print(value: Json, node: Node | undefined, text: string, indent: string, style: Style): string {
  if (node && sameJson(node.value, value)) return text.slice(node.start, node.end);
  if (Array.isArray(value)) {
    if (node?.kind === "array") return printArray(value, node, text, indent, style);
    return fresh(value, indent, style, false);
  }
  if (value !== null && typeof value === "object") {
    if (node?.kind === "object") return printObject(value, node, text, indent, style);
    return fresh(value, indent, style, false);
  }
  return JSON.stringify(value);
}

/** A value with nothing in the old text to copy: JSON.stringify's layout, or one line when inline. */
function fresh(value: Json, indent: string, style: Style, inline: boolean): string {
  if (inline) return oneLine(value);
  return JSON.stringify(value, null, style.unit).replaceAll("\n", `${style.eol}${indent}`);
}

function oneLine(value: Json): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.map(oneLine).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length === 0 ? "{}" : `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

function printObject(value: Record<string, Json>, node: Extract<Node, { kind: "object" }>, text: string, indent: string, style: Style): string {
  const old = new Map(node.members.map((m) => [m.key, m.node]));
  // Old keys in their old order (JS objects put integer-like keys first), then new keys.
  const keys = [...node.members.map((m) => m.key).filter((k) => Object.hasOwn(value, k)), ...Object.keys(value).filter((k) => !old.has(k))];
  if (keys.length === 0) return "{}";
  const span = text.slice(node.start, node.end);
  const first = node.members[0]?.node;
  const colon = first ? (/"\s*:\s*$/.exec(text.slice(node.start, first.start))?.[0].slice(1) ?? ": ") : ": ";
  if (node.members.length > 0 && !span.includes("\n")) {
    // Written on one line: keep it on one line.
    const pad = span.startsWith("{ ") ? " " : "";
    const sep = /,\s/.test(span) || pad ? ", " : ",";
    return `{${pad}${keys.map((k) => `${JSON.stringify(k)}${colon}${old.has(k) ? print(value[k]!, old.get(k), text, indent, style) : oneLine(value[k]!)}`).join(sep)}${pad}}`;
  }
  const inner = first ? lineIndent(text, first.start) : `${indent}${style.unit}`;
  const memberIndent = first && inner.length > indent.length ? inner : `${indent}${style.unit}`;
  const lines = keys.map((k) => `${memberIndent}${JSON.stringify(k)}${colon}${print(value[k]!, old.get(k), text, memberIndent, style)}`);
  return `{${style.eol}${lines.join(`,${style.eol}`)}${style.eol}${indent}}`;
}

function printArray(value: Json[], node: Extract<Node, { kind: "array" }>, text: string, indent: string, style: Style): string {
  if (value.length === 0) return "[]";
  const span = text.slice(node.start, node.end);
  const items = matchItems(value, node.items);
  if (node.items.length > 0 && !span.includes("\n")) {
    const pad = span.startsWith("[ ") ? " " : "";
    const sep = /,\s/.test(span) || pad ? ", " : ",";
    return `[${pad}${value.map((v, i) => (items[i] ? print(v, items[i], text, indent, style) : oneLine(v))).join(sep)}${pad}]`;
  }
  const first = node.items[0];
  const inner = first ? lineIndent(text, first.start) : "";
  const itemIndent = first && inner.length > indent.length ? inner : `${indent}${style.unit}`;
  // Several short items on one line (a list of numbers wrapped by hand) can't be matched line by line; print them plainly.
  const lines = value.map((v, i) => `${itemIndent}${print(v, items[i], text, itemIndent, style)}`);
  return `[${style.eol}${lines.join(`,${style.eol}`)}${style.eol}${indent}]`;
}

/**
 * Which old item each new item came from: the same value (an entity that moved in the list), else
 * the same id (an entity that changed), else the one at the same place when it's the same kind
 * (a renamed entity). A wrong guess only costs formatting: what's printed is always the new value.
 */
function matchItems(value: Json[], old: Node[]): (Node | undefined)[] {
  const byText = new Map<string, Node[]>();
  for (const n of old) {
    const key = JSON.stringify(n.value);
    const list = byText.get(key);
    if (list) list.push(n);
    else byText.set(key, [n]);
  }
  const used = new Set<Node>();
  const out: (Node | undefined)[] = value.map((v) => {
    const n = byText.get(JSON.stringify(v))?.find((c) => !used.has(c));
    if (n) used.add(n);
    return n;
  });
  const idOf = (v: Json) => (v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.id === "string" ? v.id : undefined);
  const byId = new Map<string, Node>();
  for (const n of old) {
    const id = idOf(n.value);
    if (id !== undefined && !used.has(n)) byId.set(id, n);
  }
  value.forEach((v, i) => {
    if (out[i]) return;
    const id = idOf(v);
    const n = id !== undefined ? byId.get(id) : undefined;
    if (n && !used.has(n)) {
      out[i] = n;
      used.add(n);
    }
  });
  value.forEach((v, i) => {
    // A renamed entity has no old id to match, so it falls through to here too.
    if (out[i]) return;
    const n = old[i];
    if (n && !used.has(n) && n.kind === (Array.isArray(v) ? "array" : v !== null && typeof v === "object" ? "object" : "primitive")) {
      out[i] = n;
      used.add(n);
    }
  });
  return out;
}
