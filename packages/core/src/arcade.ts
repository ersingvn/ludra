import { at, clampToPatrol, clampToWorld, feet, type PhysicsEngine, type PhysicsHost } from "./physics.ts";
import { FIXED_DT } from "./time.ts";
import type { Entity } from "./world.ts";

const MAX_FALL_SPEED = 1400;
/** Rebounds slower than this stop instead, so bouncing bodies come to rest. */
const MIN_BOUNCE_SPEED = 40;
const EPSILON = 1e-4;

/**
 * Ludra's built-in physics: axis-aligned boxes that never rotate, resolved one
 * axis at a time. Simple on purpose: predictable, easy to reason about from
 * text, and tight enough for classic platformers and top-down games.
 */
export class ArcadePhysics implements PhysicsEngine {
  readonly name = "arcade";

  add(): void {}

  remove(): void {}

  step(host: PhysicsHost): void {
    // Kinematic bodies move first, so anything standing on them can follow.
    const moved = new Map<Entity, { dx: number; dy: number }>();
    const walls = host.entities.filter((e) => e.body?.type === "static" && !e.body.sensor);
    for (const e of host.entities) {
      const b = e.body;
      if (!b || b.type !== "kinematic") continue;
      const { x, y } = e.transform;
      e.transform.x += b.vx * FIXED_DT;
      // A player-steered kinematic body (a paddle) stops at walls; scripted movers pass through.
      if (e.topdown) for (const wall of walls) if (overlaps(e, wall)) e.transform.x = wall.transform.x + (Math.sign(e.transform.x - wall.transform.x) * (wall.body!.width + b.width)) / 2;
      e.transform.y += b.vy * FIXED_DT;
      if (e.topdown) for (const wall of walls) if (overlaps(e, wall)) e.transform.y = wall.transform.y + (Math.sign(e.transform.y - wall.transform.y) * (wall.body!.height + b.height)) / 2;
      if (e.patrol) clampToPatrol(e, e.patrol);
      if (e.topdown?.clampToWorld) clampToWorld(e, host);
      moved.set(e, { dx: e.transform.x - x, dy: e.transform.y - y });
    }

    const solids = host.entities.filter((e) => e.body && !e.body.sensor && e.body.type !== "dynamic");

    for (const e of host.entities) {
      const b = e.body;
      if (!b || b.type !== "dynamic") continue;

      const carried = b.standingOn && moved.get(b.standingOn);
      if (carried) {
        e.transform.x += carried.dx;
        e.transform.y += carried.dy;
      }

      // Top-down movers ignore gravity; everything else falls.
      if (!e.topdown) b.vy = Math.min(b.vy + host.gravity * b.gravityScale * FIXED_DT, MAX_FALL_SPEED);
      const wasGrounded = b.grounded;
      b.grounded = false;
      b.standingOn = undefined;

      // Resolve each axis separately so bodies slide along walls and floors.
      e.transform.x += b.vx * FIXED_DT;
      for (const solid of solids) {
        if (!overlaps(e, solid)) continue;
        const half = (solid.body!.width + b.width) / 2;
        if (b.vx > 0) e.transform.x = solid.transform.x - half;
        else if (b.vx < 0) e.transform.x = solid.transform.x + half;
        b.vx = rebound(e, solid, b.vx, host);
      }

      e.transform.y += b.vy * FIXED_DT;
      for (const solid of solids) {
        if (!overlaps(e, solid)) continue;
        const half = (solid.body!.height + b.height) / 2;
        const falling = b.vy > 0;
        if (b.vy > 0) e.transform.y = solid.transform.y - half;
        else if (b.vy < 0) e.transform.y = solid.transform.y + half;
        b.vy = rebound(e, solid, b.vy, host);
        // A body that stopped on top of something is standing on it; one that bounced off is airborne.
        if (falling && b.vy === 0) {
          b.grounded = true;
          b.standingOn = solid;
        }
      }

      if (e.topdown?.clampToWorld) clampToWorld(e, host);
      if (b.grounded && !wasGrounded) host.emit({ type: "land", entity: e.id, ...feet(e) });
    }
  }

  overlaps(a: Entity, b: Entity, margin = 0): boolean {
    return overlaps(a, b, margin);
  }
}

/**
 * The velocity along one axis after hitting `solid`: 0, or reversed and scaled by `bounce`.
 * Slow impacts stop instead, so resting bodies don't jitter.
 */
function rebound(e: Entity, solid: Entity, velocity: number, host: PhysicsHost): number {
  const bounce = e.body!.bounce;
  if (bounce <= 0 || Math.abs(velocity) * bounce < MIN_BOUNCE_SPEED) return 0;
  host.emit({ type: "bounce", entity: e.id, other: solid.id, ...at(e) });
  return -velocity * bounce;
}

/**
 * Strict overlap: bodies that merely touch (e.g. standing on the ground) do not overlap.
 * A positive `margin` grows both boxes, so touching counts too.
 */
export function overlaps(a: Entity, b: Entity, margin = 0): boolean {
  if (!a.body || !b.body) return false;
  return (
    Math.abs(a.transform.x - b.transform.x) < (a.body.width + b.body.width) / 2 + margin - EPSILON &&
    Math.abs(a.transform.y - b.transform.y) < (a.body.height + b.body.height) / 2 + margin - EPSILON
  );
}
