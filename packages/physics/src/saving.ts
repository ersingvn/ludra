import type { Entity } from "@ludra/core";

/**
 * Saving and restoring a Rapier engine, shared by 2D and 3D. Rapier serializes its whole world
 * (bodies, colliders, joints, contacts, islands and solver caches) with `takeSnapshot`, and its
 * handles survive the round trip. What Ludra keeps per entity beside it (a "link") is either a
 * plain number Ludra tracks, or a Rapier object found again by its handle in the restored world.
 */

/** The Rapier objects a link holds, by what both the 2D and 3D modules have in common. */
interface LinkRefs {
  entity: Entity;
  body: { handle: number };
  collider: { handle: number };
  joints: ({ handle: number } | undefined)[];
  anchors: { handle: number }[];
  controller?: unknown;
}

interface HandleWorld<B, C, J> {
  getRigidBody(handle: number): B;
  getCollider(handle: number): C;
  getImpulseJoint(handle: number): J;
}

export interface SavedLink {
  id: string;
  body: number;
  collider: number;
  joints: (number | undefined)[];
  anchors: number[];
  controller: boolean;
  /** Everything else on the link: numbers and small vectors. */
  plain: Record<string, unknown>;
}

export interface SavedEngine {
  snapshot: Uint8Array;
  links: SavedLink[];
  pendingJoints: { id: string; index: number }[];
}

export function saveEngine(snapshot: Uint8Array, links: Iterable<LinkRefs>, pendingJoints: readonly { entity: Entity; index: number }[]): SavedEngine {
  const saved: SavedLink[] = [];
  for (const { entity, body, collider, joints, anchors, controller, ...plain } of links) {
    saved.push({
      id: entity.id,
      body: body.handle,
      collider: collider.handle,
      joints: joints.map((j) => j?.handle),
      anchors: anchors.map((a) => a.handle),
      controller: controller !== undefined,
      plain: copyPlain(plain),
    });
  }
  return { snapshot, links: saved, pendingJoints: pendingJoints.map((p) => ({ id: p.entity.id, index: p.index })) };
}

/**
 * The links of a restored world: each one bound to the restored entity with its id and to the
 * restored world's objects. Characters get a new controller (a controller is settings, no state).
 */
export function restoreLinks<B, C, J, L>(
  saved: SavedEngine,
  entities: readonly Entity[],
  world: HandleWorld<B, C, J>,
  controllerFor: (entity: Entity) => unknown,
): { links: L[]; pendingJoints: { entity: Entity; index: number }[] } {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const links: L[] = [];
  for (const s of saved.links) {
    const entity = byId.get(s.id);
    if (!entity) continue;
    links.push({
      ...copyPlain(s.plain),
      entity,
      body: world.getRigidBody(s.body),
      collider: world.getCollider(s.collider),
      joints: s.joints.map((h) => (h === undefined ? undefined : world.getImpulseJoint(h))),
      anchors: s.anchors.map((h) => world.getRigidBody(h)),
      ...(s.controller ? { controller: controllerFor(entity) } : {}),
    } as L);
  }
  const pendingJoints = saved.pendingJoints.flatMap((p) => {
    const entity = byId.get(p.id);
    return entity ? [{ entity, index: p.index }] : [];
  });
  return { links, pendingJoints };
}

/** A deep copy of numbers, booleans and small objects of them (Infinity included, unlike JSON). */
function copyPlain<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(copyPlain) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = copyPlain(v);
  return out as T;
}
