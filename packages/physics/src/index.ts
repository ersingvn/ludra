import RAPIER, { type Collider, type ColliderDesc, type KinematicCharacterController, type RigidBody, type World as RapierWorld } from "@dimforge/rapier2d-deterministic-compat";
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
/**
 * Ludra's +y points down; Rapier runs with its natural +y up (its character controller
 * only handles slopes correctly that way). Everything crossing over is mirrored in y:
 * positions, velocities, gravity, and angles (a clockwise turn on screen is negative in Rapier).
 */
function toRapier(x: number, y: number): { x: number; y: number } {
  return { x, y: -y };
}

const PIXELS_PER_METER = 50;
const DEGREES = Math.PI / 180;
/** Impacts slower than this (px/s) don't count as a bounce, as with arcade physics. */
const MIN_BOUNCE_SPEED = 40;
/** A contact whose normal points this much downward (from the body) is ground under it. */
const GROUND_NORMAL = 0.7;
/** Players fall no faster than this, as with arcade physics. */
const MAX_FALL_SPEED = 1400;
/** The gap a character controller keeps from obstacles, in px. */
const CONTROLLER_OFFSET = 0.5;
/** Players stay on the ground when walking down slopes and off small bumps up to this far, in px. */
const SNAP_TO_GROUND = 6;

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
  /** Players are moved by a character controller instead of forces. */
  controller?: KinematicCharacterController;
  /** How far a kinematic mover moved in the last step, so players standing on it ride along. */
  dx: number;
  dy: number;
  /** Gameplay moved the entity itself since the last step (a respawn). */
  teleported: boolean;
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
    this.world = new RAPIER.World(toRapier(0, settings.gravity));
    this.world.timestep = FIXED_DT;
    this.world.integrationParameters.lengthUnit = PIXELS_PER_METER;
    cleanup.register(this, this.world);
  }

  add(entity: Entity): void {
    const b = entity.body;
    if (!b) return;
    const t = entity.transform;
    const player = isPlayer(entity);
    // Scenes put players exactly on the ground; a character controller starting in contact
    // can't keep its gap and sinks in, so lift it clear first.
    if (player) t.y -= CONTROLLER_OFFSET;
    const desc =
      b.type === "dynamic" && !player
        ? RAPIER.RigidBodyDesc.dynamic()
        : b.type === "static"
          ? RAPIER.RigidBodyDesc.fixed()
          : RAPIER.RigidBodyDesc.kinematicPositionBased();
    desc.setTranslation(t.x, -t.y).setRotation(-t.rotation * DEGREES);
    if (b.type === "dynamic" && !player) {
      desc.setGravityScale(entity.topdown ? 0 : b.gravityScale).setLinvel(b.vx, -b.vy).setCcdEnabled(b.bullet);
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
    const link: Link = { entity, body, collider, x: t.x, y: t.y, rotation: t.rotation, angle: body.rotation(), dx: 0, dy: 0, teleported: false };
    if (player) link.controller = this.createController(entity);
    this.links.set(entity, link);
    this.byCollider.set(collider.handle, link);
  }

  remove(entity: Entity): void {
    const link = this.links.get(entity);
    if (!link) return;
    this.byCollider.delete(link.collider.handle);
    this.links.delete(entity);
    if (link.controller) this.world.removeCharacterController(link.controller);
    this.world.removeRigidBody(link.body);
  }

  /**
   * A character controller moves a player the way games expect rather than the way
   * rigid bodies do: up slopes without sliding back while standing, onto small steps,
   * along walls without sticking, and into crates, pushing them.
   */
  private createController(entity: Entity): KinematicCharacterController {
    const b = entity.body!;
    const p = entity.platformer;
    const controller = this.world.createCharacterController(CONTROLLER_OFFSET);
    controller.setSlideEnabled(true);
    const push = p?.push ?? 1;
    controller.setApplyImpulsesToDynamicBodies(push > 0);
    if (push > 0) controller.setCharacterMass(b.density * b.width * b.height * push);
    if (p) {
      controller.setMaxSlopeClimbAngle(p.maxSlope * DEGREES);
      controller.setMinSlopeSlideAngle(p.maxSlope * DEGREES);
      controller.enableSnapToGround(Math.max(SNAP_TO_GROUND, p.stepHeight));
      if (p.stepHeight > 0) controller.enableAutostep(p.stepHeight, b.width / 2, false);
    }
    return controller;
  }

  step(host: PhysicsHost): void {
    // Hand gameplay's changes to Rapier: teleports, velocities, kinematic moves.
    for (const link of this.links.values()) {
      const { entity: e, body } = link;
      const b = e.body!;
      const t = e.transform;
      link.teleported = t.x !== link.x || t.y !== link.y || t.rotation !== link.rotation;
      if (link.teleported) {
        body.setTranslation(toRapier(t.x, t.y), true);
        body.setRotation(-t.rotation * DEGREES, true);
        link.angle = body.rotation();
      }
      if (link.controller) continue;
      if (b.type === "dynamic") {
        body.setLinvel(toRapier(b.vx, b.vy), true);
      } else if (b.type === "kinematic") {
        const { x, y } = t;
        t.x += b.vx * FIXED_DT;
        t.y += b.vy * FIXED_DT;
        if (e.patrol) clampToPatrol(e, e.patrol);
        body.setNextKinematicTranslation(toRapier(t.x, t.y));
        link.dx = t.x - x;
        link.dy = t.y - y;
      }
    }
    for (const link of this.links.values()) if (link.controller) this.moveCharacter(link, host);

    this.world.step(this.events);

    // Read the results back into the entities.
    for (const link of this.links.values()) {
      const { entity: e, body } = link;
      const b = e.body!;
      if (b.type !== "static") {
        const t = e.transform;
        const r = body.translation();
        const p = { x: r.x, y: -r.y };
        t.x = p.x;
        t.y = p.y;
        // Rapier wraps angles to ±180°; accumulate instead, so a ball that rolled two turns reads 720.
        const angle = body.rotation();
        let turn = angle - link.angle;
        if (turn > Math.PI) turn -= 2 * Math.PI;
        else if (turn < -Math.PI) turn += 2 * Math.PI;
        if (turn !== 0) t.rotation -= turn / DEGREES;
        link.angle = angle;
        if (b.type === "dynamic" && !link.controller) {
          const v = body.linvel();
          b.vx = v.x;
          b.vy = -v.y;
          if (e.topdown?.clampToWorld) {
            clampToWorld(e, host);
            if (t.x !== p.x || t.y !== p.y) body.setTranslation(toRapier(t.x, t.y), true);
          }
        }
      }
      link.x = e.transform.x;
      link.y = e.transform.y;
      link.rotation = e.transform.rotation;
    }

    for (const link of this.links.values()) {
      if (link.entity.body!.type === "dynamic" && !link.controller) this.updateGround(link, host);
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

  /**
   * Moves a player by its velocity (plus gravity for platformers, and the platform it
   * stands on) through the character controller, which resolves slopes, steps and walls.
   */
  private moveCharacter(link: Link, host: PhysicsHost): void {
    const { entity: e, body, collider } = link;
    const controller = link.controller!;
    const b = e.body!;
    const t = e.transform;
    const falls = !!e.platformer && b.type === "dynamic";
    const wasGrounded = b.grounded;
    if (link.teleported) {
      // A respawn: start from rest where gameplay put it, just clear of the ground.
      t.y -= CONTROLLER_OFFSET;
      body.setTranslation(toRapier(t.x, t.y), true);
      body.setNextKinematicTranslation(toRapier(t.x, t.y));
      b.grounded = false;
      b.standingOn = undefined;
      return;
    }
    // Gravity only while airborne (or jumping off): pressing a standing player into the ground
    // makes round-bottomed ones slide and lose speed. Snapping keeps it down on slopes.
    if (falls) b.vy = wasGrounded && b.vy >= 0 ? 0 : Math.min(b.vy + host.gravity * b.gravityScale * FIXED_DT, MAX_FALL_SPEED);
    const ownX = b.vx * FIXED_DT;
    const ownY = b.vy * FIXED_DT;
    // Ride along with a moving platform (Rapier's controller doesn't carry a standing character).
    const carrier = b.standingOn ? this.links.get(b.standingOn) : undefined;
    const carryX = carrier?.dx ?? 0;
    const carryY = carrier?.dy ?? 0;
    controller.computeColliderMovement(collider, toRapier(ownX + carryX, ownY + carryY), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (other) => other.handle !== collider.handle);
    const computed = controller.computedMovement();
    const moved = { x: computed.x, y: -computed.y };
    t.x += moved.x;
    t.y += moved.y;
    if (e.topdown?.clampToWorld) clampToWorld(e, host);
    body.setNextKinematicTranslation(toRapier(t.x, t.y));

    // Ground: what's under the player now, if it fell or walked onto something.
    b.grounded = falls && controller.computedGrounded();
    const previous = b.standingOn;
    b.standingOn = undefined;
    if (b.grounded) {
      for (let i = 0; i < controller.numComputedCollisions(); i++) {
        const hit = controller.computedCollision(i);
        const other = hit?.collider ? this.byCollider.get(hit.collider.handle) : undefined;
        if (other && other.entity.transform.y > t.y && Math.abs(hit!.normal1.y) > GROUND_NORMAL) b.standingOn = other.entity;
      }
      // Snapping down a slope reports no collision: it still stands where it stood.
      b.standingOn ??= previous;
    }
    if (b.grounded && b.vy > 0) b.vy = 0;
    // Bumped its head: stop rising.
    if (ownY < 0 && moved.y - carryY > ownY + 1e-3) b.vy = 0;
    if (b.grounded && !wasGrounded) host.emit({ type: "land", entity: e.id, ...feet(e) });
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
        // The normal points from the first collider to the second (flipped swaps them), in
        // Rapier's y-up space: a solid below the body has a normal pointing to -y.
        const down = flipped ? manifold.normal().y : -manifold.normal().y;
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

function isPlayer(e: Entity): boolean {
  return !!(e.platformer || e.topdown) && !!e.body && e.body.type !== "static";
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
