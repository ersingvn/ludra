// The viewport tools' arithmetic (docs/editor.md, part B), kept apart from the DOM so it can be tested:
// screen ↔ world, snapping, axis lock, fresh ids, the edits that duplicate, reorder and place.

import type { Edit, EntityJson, GameView } from "./protocol.ts";

export interface Point {
  x: number;
  y: number;
}

/** An entity's box in the world: centre and size. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point in the game frame (CSS px from its top left) to the world, through the game's last view. */
export function toWorld(view: GameView, p: Point): Point {
  const r = view.rect;
  const px = ((p.x - r.left) / (r.width || 1)) * view.width;
  const py = ((p.y - r.top) / (r.height || 1)) * view.height;
  return { x: view.cameraX + px / view.zoom, y: view.cameraY + py / view.zoom };
}

/** A world point to the game frame (CSS px), the other way round. */
export function toScreen(view: GameView, w: Point): Point {
  const r = view.rect;
  return {
    x: r.left + (((w.x - view.cameraX) * view.zoom) / (view.width || 1)) * r.width,
    y: r.top + (((w.y - view.cameraY) * view.zoom) / (view.height || 1)) * r.height,
  };
}

/** CSS px per world px on screen. */
export function screenScale(view: GameView): number {
  return (view.zoom * view.rect.width) / (view.width || 1);
}

export function snap(value: number, grid: number): number {
  return grid > 0 ? Math.round(value / grid) * grid : Math.round(value);
}

/**
 * Where a dragged entity goes: where it started plus how far the pointer moved, along one axis with
 * Shift (whichever it has moved further on), snapped to the grid when there is one, whole px otherwise.
 */
export function dragTo(from: Point, pointerStart: Point, pointer: Point, options: { grid: number; axisLock: boolean }): Point {
  let dx = pointer.x - pointerStart.x;
  let dy = pointer.y - pointerStart.y;
  if (options.axisLock) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  return {
    x: dx === 0 ? from.x : snap(from.x + dx, options.grid),
    y: dy === 0 ? from.y : snap(from.y + dy, options.grid),
  };
}

/** A new id like this one that nothing has: coin-3 → coin-4 (or the next free), player → player-2. */
export function freshId(id: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const m = /^(.*?)-(\d+)$/.exec(id);
  const base = m ? m[1]! : id;
  let n = m ? Number(m[2]) + 1 : 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** An entity's box from its components (body, then sprite, then an emitter's area, then a 24 px square), at its transform. */
export function entityBox(components: Record<string, unknown> | undefined, at?: Point): Box {
  const c = (components ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const t = c.transform ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const area = Array.isArray(c.emitter?.area) ? (c.emitter.area as unknown[]) : [];
  const width = num(c.body?.width) ?? num(c.sprite?.width) ?? num(c.sprite?.frameWidth) ?? num(area[0]) ?? 24;
  const height = num(c.body?.height) ?? num(c.sprite?.height) ?? num(c.sprite?.frameHeight) ?? num(area[1]) ?? 24;
  return { x: at?.x ?? (Number(t.x) || 0), y: at?.y ?? (Number(t.y) || 0), width, height };
}

/** The camera F looks through to frame a box: its centre, zoomed so it fills about a third of the view. */
export function frameLook(box: Box, view: Pick<GameView, "width" | "height" | "zoom">): { x: number; y: number; zoom: number } {
  const fit = Math.min(view.width / (box.width * 3), view.height / (box.height * 3));
  const zoom = Math.max(0.25, Math.min(4, Math.max(view.zoom, fit)));
  return { x: box.x, y: box.y, zoom: Math.round(zoom * 100) / 100 };
}

/** The entities a scene file holds, in order. */
export function sceneEntities(text: string): EntityJson[] {
  const scene = JSON.parse(text) as { entities?: unknown };
  return Array.isArray(scene.entities) ? (scene.entities.filter((e) => e && typeof e === "object" && typeof (e as EntityJson).id === "string") as EntityJson[]) : [];
}

/** A copy of an entity with a fresh id, moved by `offset`. */
export function duplicate(entity: EntityJson, taken: Iterable<string>, offset: Point): EntityJson {
  const copy = JSON.parse(JSON.stringify(entity)) as EntityJson;
  copy.id = freshId(entity.id, taken);
  const components = (copy.components ??= {});
  const t = (components.transform ?? {}) as Record<string, unknown>;
  // A prefab entity may leave transform to the prefab; the copy gets its own, moved.
  components.transform = { ...t, x: (Number(t.x) || 0) + offset.x, y: (Number(t.y) || 0) + offset.y };
  return copy;
}

/** The edit that duplicates an entity: added right after it in the file. */
export function duplicateEdit(entity: EntityJson, taken: Iterable<string>, offset: Point): Edit & { op: "add" } {
  return { op: "add", entity: duplicate(entity, taken, offset), after: entity.id };
}

/**
 * The edits that move `id` before or after `target` in the file's entity list: a remove and an add
 * (docs/editor.md). Undefined when it wouldn't change the order.
 */
export function reorderEdits(entities: EntityJson[], id: string, target: string, place: "before" | "after"): Edit[] | undefined {
  if (id === target) return undefined;
  const moving = entities.find((e) => e.id === id);
  if (!moving || !entities.some((e) => e.id === target)) return undefined;
  const rest = entities.filter((e) => e.id !== id);
  const at = rest.findIndex((e) => e.id === target) + (place === "after" ? 1 : 0);
  const after = at === 0 ? null : rest[at - 1]!.id;
  const now = entities.findIndex((e) => e.id === id);
  if ((now === 0 && after === null) || (now > 0 && entities[now - 1]!.id === after)) return undefined;
  return [
    { op: "remove", entity: id },
    { op: "add", entity: JSON.parse(JSON.stringify(moving)) as EntityJson, after },
  ];
}

/** The id a placed prefab gets: its name, numbered past what's taken (coin → coin-1, coin-2...). */
export function placeId(prefab: string, taken: Iterable<string>): string {
  return freshId(`${prefabName(prefab)}-0`, taken);
}

/** "coin" from "coin" or "prefabs/coin.prefab.json". Scenes name prefabs by name. */
export function prefabName(prefab: string): string {
  return prefab.replace(/^.*\//, "").replace(/\.prefab\.json$/, "");
}

/** The edit that places a prefab at a world point. */
export function placeEdit(prefab: string, at: Point, taken: Iterable<string>): Edit & { op: "add" } {
  return { op: "add", entity: { id: placeId(prefab, taken), prefab: prefabName(prefab), components: { transform: { x: Math.round(at.x), y: Math.round(at.y) } } } };
}

/** What Activity says for a Studio edit: "Moved coin-3" → "You moved coin-3". */
export function youDid(label: string | undefined): string {
  if (!label) return "You changed the scene";
  const lower = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  // The server labels undo and redo "Undo <label>" and "Redo <label>".
  const again = /^(Undo|Redo) (.+)$/.exec(label);
  if (again) return `You ${again[1] === "Undo" ? "undid" : "redid"}: ${lower(again[2]!)}`;
  return `You ${lower(label)}`;
}
