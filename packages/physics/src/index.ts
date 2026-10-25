import RAPIER, { type Collider, type ColliderDesc, type RigidBody, type World as RapierWorld } from "@dimforge/rapier2d-deterministic-compat";
import {
  at,
  clampToPatrol,
  clampToWorld,
  feet,
  FIXED_DT,
  registerPhysics,
  type Body,
  type Entity,
  type PhysicsEngine,
  type PhysicsHost,
  type PhysicsSettings,
} from "@ludra/core";

/**
 * Rapier works in any unit; this tells it how big "one meter" is in pixels, so its
 * tolerances suit pixel-sized games. Positions, sizes and velocities stay in pixels.
 */
const PIXELS_PER_METER = 50;
const DEGREES = Math.PI / 180;
/** Impacts slower than this (px/s) don't count as a bounce, as with arcade physics. */
const MIN_BOUNCE_SPEED = 40;
/** A contact whose normal points this much downward (from the body) is ground under it. */
const GROUND_NORMAL = 0.7;

/** A Ludra entity, its Rapier body and collider, and the transform last written to it. */
interface Link {
  entity: Entity;
  body: RigidBody;
  collider: Collider;
  x: number;
  y: number;
  rotation: number;
  /** Rapier's own angle (radians, wrapped to ±π) at that time, to accumulate turns. */
  angle: number;
}

let loading: Promise<void> | undefined;

/**
 * Loads Rapier's WebAssembly and registers the "rapier" engine, so scenes with
 * `"physics": "rapier"` can be created. Safe to call more than once.
 */
export function loadRapierPhysics(): Promise<void> {
  loading ??= RAPIER.init().then(() => registerPhysics("rapier", (settings) => new RapierPhysics(settings)));
  return loading;
}

// Rapier's memory lives in WebAssembly; free it when a world is garbage collected.
const cleanup = new FinalizationRegistry<RapierWorld>((world) => world.free());

/**
 * Ludra's real physics engine: Rapier's deterministic build, so a simulation is
 * bit-for-bit identical on every machine and in the browser, and tests stay valid.
 * Bodies rotate, can be circles or capsules, and have friction and mass.
 */
export class RapierPhysics implements PhysicsEngine {
  readonly name = "rapier";
  /** The Rapier world itself, for anything the components don't cover. */
  readonly world: RapierWorld;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly links = new Map<Entity, Link>();
  private readonly byCollider = new Map<number, Link>();

  constructor(settings: PhysicsSettings) {
    this.world = new RAPIER.World({ x: 0, y: settings.gravity });
    this.world.timestep = FIXED_DT;
    this.world.integrationParameters.lengthUnit = PIXELS_PER_METER;
    cleanup.register(this, this.world);
  }

  add(entity: Entity): void {
    const b = entity.body;
    if (!b) return;
    const t = entity.transform;
    const desc =
      b.type === "dynamic"
        ? RAPIER.RigidBodyDesc.dynamic()
        : b.type === "kinematic"
          ? RAPIER.RigidBodyDesc.kinematicPositionBased()
          : RAPIER.RigidBodyDesc.fixed();
    desc.setTranslation(t.x, t.y).setRotation(t.rotation * DEGREES);
    if (b.type === "dynamic") {
      desc.setGravityScale(entity.topdown ? 0 : b.gravityScale).setLinvel(b.vx, b.vy).setCcdEnabled(b.bullet);
      // Players and fixed-rotation bodies stay upright.
      if (b.fixedRotation || entity.platformer || entity.topdown) desc.lockRotations();
    }
    const body = this.world.createRigidBody(desc);
    const collider = this.world.createCollider(
      shape(b)
        .setSensor(b.sensor)
        .setRestitution(b.bounce)
        // A bouncy ball stays bouncy against a dull wall, as with arcade physics.
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setFriction(b.friction)
        .setDensity(b.density)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        // Detect every pair, including sensors against static and kinematic bodies.
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL),
      body,
    );
    const link: Link = { entity, body, collider, x: t.x, y: t.y, rotation: t.rotation, angle: body.rotation() };
    this.links.set(entity, link);
    this.byCollider.set(collider.handle, link);
  }

  remove(entity: Entity): void {
    const link = this.links.get(entity);
    if (!link) return;
    this.byCollider.delete(link.collider.handle);
    this.links.delete(entity);
    this.world.removeRigidBody(link.body);
  }

  step(host: PhysicsHost): void {
    // Hand gameplay's changes to Rapier: teleports, velocities, kinematic moves.
    for (const link of this.links.values()) {
      const { entity: e, body } = link;
      const b = e.body!;
      const t = e.transform;
      if (t.x !== link.x || t.y !== link.y || t.rotation !== link.rotation) {
        body.setTranslation({ x: t.x, y: t.y }, true);
        body.setRotation(t.rotation * DEGREES, true);
        link.angle = body.rotation();
      }
      if (b.type === "dynamic") {
        body.setLinvel({ x: b.vx, y: b.vy }, true);
      } else if (b.type === "kinematic") {
        t.x += b.vx * FIXED_DT;
        t.y += b.vy * FIXED_DT;
        if (e.patrol) clampToPatrol(e, e.patrol);
        if (e.topdown?.clampToWorld) clampToWorld(e, host);
        body.setNextKinematicTranslation({ x: t.x, y: t.y });
      }
    }

    this.world.step(this.events);

    // Read the results back into the entities.
    for (const link of this.links.values()) {
      const { entity: e, body } = link;
      const b = e.body!;
      if (b.type !== "static") {
        const t = e.transform;
        const p = body.translation();
        t.x = p.x;
        t.y = p.y;
        // Rapier wraps angles to ±180°; accumulate instead, so a ball that rolled two turns reads 720.
        const angle = body.rotation();
        let turn = angle - link.angle;
        if (turn > Math.PI) turn -= 2 * Math.PI;
        else if (turn < -Math.PI) turn += 2 * Math.PI;
        if (turn !== 0) t.rotation += turn / DEGREES;
        link.angle = angle;
        if (b.type === "dynamic") {
          const v = body.linvel();
          b.vx = v.x;
          b.vy = v.y;
          if (e.topdown?.clampToWorld) {
            clampToWorld(e, host);
            if (t.x !== p.x || t.y !== p.y) body.setTranslation({ x: t.x, y: t.y }, true);
          }
        }
      }
      link.x = e.transform.x;
      link.y = e.transform.y;
      link.rotation = e.transform.rotation;
    }

    for (const link of this.links.values()) {
      if (link.entity.body!.type === "dynamic") this.updateGround(link, host);
    }

    this.events.drainCollisionEvents((handle1, handle2, started) => {
      if (!started) return;
      const a = this.byCollider.get(handle1);
      const c = this.byCollider.get(handle2);
      if (!a || !c || a.collider.isSensor() || c.collider.isSensor()) return;
      for (const [self, other] of [
        [a, c],
        [c, a],
      ] as const) {
        const b = self.entity.body!;
        if (b.type !== "dynamic" || b.bounce <= 0 || Math.hypot(b.vx, b.vy) < MIN_BOUNCE_SPEED) continue;
        host.emit({ type: "bounce", entity: self.entity.id, other: other.entity.id, ...at(self.entity) });
      }
    });
  }

  /** A body is grounded when a solid touches it from below; it then stands on that solid. */
  private updateGround(link: Link, host: PhysicsHost): void {
    const b = link.entity.body!;
    const wasGrounded = b.grounded;
    b.grounded = false;
    b.standingOn = undefined;
    this.world.contactPairsWith(link.collider, (other) => {
      if (b.grounded || other.isSensor()) return;
      this.world.contactPair(link.collider, other, (manifold, flipped) => {
        if (b.grounded || manifold.numContacts() === 0) return;
        // The normal points from the first collider to the second; flipped swaps them.
        const down = flipped ? -manifold.normal().y : manifold.normal().y;
        if (down > GROUND_NORMAL) {
          b.grounded = true;
          b.standingOn = this.byCollider.get(other.handle)?.entity;
        }
      });
    });
    if (b.grounded && !wasGrounded) host.emit({ type: "land", entity: link.entity.id, ...feet(link.entity) });
  }

  overlaps(a: Entity, b: Entity, margin = 0): boolean {
    const la = this.links.get(a);
    const lb = this.links.get(b);
    if (!la || !lb) return false;
    if (la.collider.isSensor() || lb.collider.isSensor()) return this.world.intersectionPair(la.collider, lb.collider);
    let hit = false;
    this.world.contactPair(la.collider, lb.collider, (manifold) => {
      for (let i = 0; i < manifold.numContacts(); i++) if (manifold.contactDist(i) < margin) hit = true;
    });
    return hit;
  }
}

function shape(b: Body): ColliderDesc {
  if (b.shape === "circle") return RAPIER.ColliderDesc.ball(b.width / 2);
  if (b.shape === "capsule") {
    // Rapier's capsules stand upright; lay it down when the body is wider than tall.
    if (b.height >= b.width) return RAPIER.ColliderDesc.capsule((b.height - b.width) / 2, b.width / 2);
    return RAPIER.ColliderDesc.capsule((b.width - b.height) / 2, b.height / 2).setRotation(Math.PI / 2);
  }
  return RAPIER.ColliderDesc.cuboid(b.width / 2, b.height / 2);
}
