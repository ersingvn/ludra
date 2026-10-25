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

/** Where a ray first hits a body. */
export interface RayHit {
  entity: Entity;
  /** The hit point in px (3D: metres, with z). */
  x: number;
  y: number;
  z?: number;
  /** From the ray's start to the hit point, in px. */
  distance: number;
  /** The surface's outward normal at the hit point (unit length, +y down). */
  normal: { x: number; y: number; z?: number };
}

export interface RayOptions {
  /** Entities the ray passes through (usually the one casting it). */
  ignore?: readonly Entity[];
  /** Also hit sensors (coins, triggers). Off by default. */
  sensors?: boolean;
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
  /** A body's mass: density × area. */
  mass(e: Entity): number;
  /**
   * Strikes a dynamic body: its velocity changes by impulse / mass. Applied `at` a point
   * (px, in the world) it also spins the body, where the engine supports rotation.
   */
  applyImpulse(e: Entity, x: number, y: number, at?: { x: number; y: number; z?: number }, z?: number): void;
  /** Spin in degrees per second, clockwise. 0 where the engine doesn't rotate bodies. */
  angularVelocity(e: Entity): number;
  setAngularVelocity(e: Entity, value: number): void;
  /** The first body a ray from `from` to `to` hits, if any. */
  raycast(host: PhysicsHost, from: { x: number; y: number; z?: number }, to: { x: number; y: number; z?: number }, options?: RayOptions): RayHit | undefined;
  /** 3D: spin around each axis, in degrees per second. */
  spin?(e: Entity): { x: number; y: number; z: number };
  setSpin?(e: Entity, value: { x: number; y: number; z: number }): void;
  /**
   * The engine's own objects, for scripts that need more than Ludra's components.
   * `resolve` turns what a script passes (an entity handle or id) into an entity.
   */
  raw?(resolve: (target: unknown) => Entity | undefined): unknown;
}

/** A body's mass for engines without their own: density × width × height. */
export function boxMass(e: Entity): number {
  const b = e.body;
  return b ? b.density * b.width * b.height : 0;
}

/**
 * The first axis-aligned box a ray hits (the slab method). Exact for arcade bodies,
 * which are boxes that never rotate.
 */
export function raycastBoxes(host: PhysicsHost, from: { x: number; y: number }, to: { x: number; y: number }, options: RayOptions = {}): RayHit | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return undefined;
  let best: RayHit | undefined;
  for (const e of host.entities) {
    const b = e.body;
    if (!b || (b.sensor && !options.sensors) || options.ignore?.includes(e)) continue;
    const box = { left: e.transform.x - b.width / 2, right: e.transform.x + b.width / 2, top: e.transform.y - b.height / 2, bottom: e.transform.y + b.height / 2 };
    let enter = 0;
    let exit = 1;
    let normal = { x: 0, y: 0 };
    let inside = true;
    for (const [start, delta, low, high, axis] of [
      [from.x, dx, box.left, box.right, "x"],
      [from.y, dy, box.top, box.bottom, "y"],
    ] as const) {
      if (delta === 0) {
        if (start < low || start > high) inside = false;
        continue;
      }
      let t1 = (low - start) / delta;
      let t2 = (high - start) / delta;
      let side = -1;
      if (t1 > t2) {
        [t1, t2] = [t2, t1];
        side = 1;
      }
      if (t1 > enter) {
        enter = t1;
        normal = axis === "x" ? { x: side, y: 0 } : { x: 0, y: side };
      }
      exit = Math.min(exit, t2);
    }
    // A ray starting inside a box doesn't hit it.
    if (!inside || enter > exit || enter <= 0 || enter > 1) continue;
    if (!best || enter * length < best.distance) best = { entity: e, x: from.x + dx * enter, y: from.y + dy * enter, distance: enter * length, normal };
  }
  return best;
}

/** Keeps a patrolling body between its start and `distance` along its axis. */
export function clampToPatrol(e: Entity, patrol: PatrolState): void {
  if (patrol.axis === "x") e.transform.x = Math.min(patrol.originX + patrol.distance, Math.max(patrol.originX, e.transform.x));
  else if (patrol.axis === "z") e.transform.z = Math.min(patrol.originZ + patrol.distance, Math.max(patrol.originZ, e.transform.z));
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
