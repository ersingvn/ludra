import type { Entity, GameEvent, PatrolState } from "./world.ts";

/** Collision events a physics engine reports while it moves bodies. */
export type PhysicsEvent = Extract<GameEvent, { type: "land" } | { type: "bounce" }> extends infer E
  ? E extends GameEvent
    ? Omit<E, "frame" | "time">
    : never
  : never;

/** What a physics engine sees of the world it moves. */
export interface PhysicsHost {
  /** Every entity, in scene order. The same array the world mutates. */
  readonly entities: readonly Entity[];
  readonly width: number;
  readonly height: number;
  /** Downward acceleration in px/s². */
  readonly gravity: number;
  emit(event: PhysicsEvent): void;
}

/**
 * Moves bodies and answers overlap queries. Gameplay (controllers, patrols,
 * pickups, hazards, goals) stays in the World and only talks to bodies through
 * their velocities, `grounded`/`standingOn` and `overlaps`, so engines can be
 * swapped underneath without changing the rules of a game.
 *
 * The entity's transform is the source of truth between steps: gameplay may
 * teleport an entity (a respawn) or change its velocity, and the engine picks
 * that up on its next step.
 */
export interface PhysicsEngine {
  /** Name used in scenes and messages, e.g. "arcade". */
  readonly name: string;
  /** An entity was created or spawned. */
  add(entity: Entity, host: PhysicsHost): void;
  /** An entity was destroyed or collected. */
  remove(entity: Entity, host: PhysicsHost): void;
  /**
   * Advances every body by one fixed step (`FIXED_DT`): kinematic movers, gravity,
   * collisions. Sets `grounded` and `standingOn`, and emits `land` and `bounce`.
   */
  step(host: PhysicsHost): void;
  /** True when two bodies overlap. A positive `margin` grows both, so touching counts too. */
  overlaps(a: Entity, b: Entity, margin?: number): boolean;
}

/** Keeps a patrolling body between its start and `distance` along its axis. */
export function clampToPatrol(e: Entity, patrol: PatrolState): void {
  if (patrol.axis === "x") e.transform.x = Math.min(patrol.originX + patrol.distance, Math.max(patrol.originX, e.transform.x));
  else e.transform.y = Math.min(patrol.originY + patrol.distance, Math.max(patrol.originY, e.transform.y));
}

/** Keeps a body's box inside the world. */
export function clampToWorld(e: Entity, host: Pick<PhysicsHost, "width" | "height">): void {
  const halfWidth = (e.body?.width ?? 0) / 2;
  const halfHeight = (e.body?.height ?? 0) / 2;
  e.transform.x = Math.min(host.width - halfWidth, Math.max(halfWidth, e.transform.x));
  e.transform.y = Math.min(host.height - halfHeight, Math.max(halfHeight, e.transform.y));
}

/** Where an entity is, for events: its center. */
export function at(e: Entity): { x: number; y: number } {
  return { x: e.transform.x, y: e.transform.y };
}

/** The bottom center of an entity's body: where it stands. */
export function feet(e: Entity): { x: number; y: number } {
  return { x: e.transform.x, y: e.transform.y + (e.body?.height ?? 0) / 2 };
}
