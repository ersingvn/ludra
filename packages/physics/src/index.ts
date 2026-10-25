import RAPIER, {
  type Collider,
  type ColliderDesc,
  type ImpulseJoint,
  type KinematicCharacterController,
  type RigidBody,
  type World as RapierWorld,
} from "@dimforge/rapier2d-deterministic-compat";
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
  type RayHit,
  type RayOptions,
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

/** A point or vector from Rapier's y-up space back to Ludra's. */
function fromRapier(v: { x: number; y: number }): { x: number; y: number } {
  return { x: v.x, y: -v.y };
}

/** How firmly a joint motor drives toward its target speed (it is capped by motorForce). */
const MOTOR_FACTOR = 1000;

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
  /** The joints this entity's `joint` component made, in order, once both ends exist. */
  joints: (ImpulseJoint | undefined)[];
  /** For joints to a point in the world: the fixed bodies holding those points. */
  anchors: RigidBody[];
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
  /** Joints (entity and index in its list) waiting for the body on their other end. */
  private pendingJoints: { entity: Entity; index: number }[] = [];

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
    const link: Link = { entity, body, collider, x: t.x, y: t.y, rotation: t.rotation, angle: body.rotation(), dx: 0, dy: 0, teleported: false, joints: [], anchors: [] };
    if (player) link.controller = this.createController(entity);
    entity.joints?.forEach((_, index) => this.pendingJoints.push({ entity, index }));
    this.links.set(entity, link);
    this.byCollider.set(collider.handle, link);
  }

  remove(entity: Entity): void {
    const link = this.links.get(entity);
    if (!link) return;
    this.byCollider.delete(link.collider.handle);
    this.links.delete(entity);
    if (link.controller) this.world.removeCharacterController(link.controller);
    // Removing a body removes the joints attached to it.
    this.world.removeRigidBody(link.body);
    for (const anchor of link.anchors) this.world.removeRigidBody(anchor);
    this.pendingJoints = this.pendingJoints.filter((pending) => pending.entity !== entity);
  }

  /** Creates the joints whose two ends now both exist. */
  private connectJoints(host: PhysicsHost): void {
    if (this.pendingJoints.length === 0) return;
    const waiting: { entity: Entity; index: number }[] = [];
    for (const pending of this.pendingJoints) {
      const { entity, index } = pending;
      const link = this.links.get(entity);
      const spec = entity.joints![index]!;
      const target = spec.to ? host.entities.find((e) => e.id === spec.to) : undefined;
      const other = target ? this.links.get(target) : undefined;
      if (!link || (spec.to && !other)) {
        waiting.push(pending);
        continue;
      }
      // Where this end of the joint is, in the world (the anchor turns with the body).
      const here = worldPoint(link.body, spec.anchor);
      // Hinges, sliders and welds join both bodies at that same point; ropes and springs
      // run from there to their other end (toAnchor).
      const sameSpot = spec.type === "revolute" || spec.type === "prismatic" || spec.type === "fixed";
      let base: RigidBody;
      let there: { x: number; y: number };
      if (other) {
        base = other.body;
        there = sameSpot ? here : worldPoint(other.body, spec.toAnchor);
      } else {
        // A fixed point in the world: hang the joint on an invisible fixed body there.
        there = sameSpot ? here : { x: entity.transform.x + spec.toAnchor.x, y: entity.transform.y + spec.toAnchor.y };
        base = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(there.x, -there.y));
        link.anchors.push(base);
      }
      // The other body (or the world) comes first, so Rapier measures this body relative to it.
      const baseAnchor = localPoint(base, there);
      const ownAnchor = toRapier(spec.anchor.x, spec.anchor.y);
      const length = spec.length || Math.hypot(there.x - here.x, there.y - here.y);
      const data =
        spec.type === "prismatic"
          ? RAPIER.JointData.prismatic(baseAnchor, ownAnchor, rotateBack(base, toRapier(Math.cos(spec.axis * DEGREES), Math.sin(spec.axis * DEGREES))))
          : spec.type === "fixed"
            ? RAPIER.JointData.fixed(baseAnchor, 0, ownAnchor, base.rotation() - link.body.rotation())
            : spec.type === "rope"
              ? RAPIER.JointData.rope(length, baseAnchor, ownAnchor)
              : spec.type === "spring"
                ? RAPIER.JointData.spring(length, spec.stiffness, spec.damping, baseAnchor, ownAnchor)
                : RAPIER.JointData.revolute(baseAnchor, ownAnchor);
      const joint = this.world.createImpulseJoint(data, base, link.body, true);
      joint.setContactsEnabled(spec.collide);
      if (spec.type === "revolute" || spec.type === "prismatic") {
        const unit = joint as unknown as {
          setLimits(min: number, max: number): void;
          setMotorMaxForce(force: number): void;
          configureMotorVelocity(velocity: number, factor: number): void;
        };
        // Rapier is y-up: a clockwise angle is negative there. Positions along the axis keep their sign.
        if (spec.min < spec.max) {
          if (spec.type === "revolute") unit.setLimits(-spec.max * DEGREES, -spec.min * DEGREES);
          else unit.setLimits(spec.min, spec.max);
        }
        if (spec.motorForce > 0) {
          unit.setMotorMaxForce(spec.motorForce);
          unit.configureMotorVelocity(spec.type === "revolute" ? -spec.motorSpeed * DEGREES : spec.motorSpeed, MOTOR_FACTOR);
        }
      }
      link.joints[index] = joint;
    }
    this.pendingJoints = waiting;
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
    this.connectJoints(host);
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

  mass(e: Entity): number {
    return this.links.get(e)?.collider.mass() ?? 0;
  }

  applyImpulse(e: Entity, x: number, y: number, at?: { x: number; y: number }): void {
    const link = this.links.get(e);
    const b = e.body;
    if (!link || !b || b.type === "static") return;
    if (link.controller) {
      // Players move by velocity: a kick changes it directly.
      const mass = link.collider.mass() || 1;
      b.vx += x / mass;
      b.vy += y / mass;
      return;
    }
    if (b.type !== "dynamic") return;
    if (at) link.body.applyImpulseAtPoint(toRapier(x, y), toRapier(at.x, at.y), true);
    else link.body.applyImpulse(toRapier(x, y), true);
    // Keep the entity's velocity in step, since it is written back to Rapier each step.
    const v = fromRapier(link.body.linvel());
    b.vx = v.x;
    b.vy = v.y;
  }

  angularVelocity(e: Entity): number {
    const body = this.links.get(e)?.body;
    return body ? -body.angvel() / DEGREES : 0;
  }

  setAngularVelocity(e: Entity, value: number): void {
    const link = this.links.get(e);
    if (link && e.body?.type === "dynamic" && !link.controller) link.body.setAngvel(-value * DEGREES, true);
  }

  raycast(_host: PhysicsHost, from: { x: number; y: number }, to: { x: number; y: number }, options: RayOptions = {}): RayHit | undefined {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return undefined;
    const origin = toRapier(from.x, from.y);
    const ignored = new Set((options.ignore ?? []).map((e) => this.links.get(e)?.collider.handle));
    const hit = this.world.castRayAndGetNormal(
      new RAPIER.Ray(origin, toRapier(dx, dy)),
      1,
      true,
      options.sensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      // Like arcade: a ray starting inside a body doesn't hit it, and only Ludra's bodies count.
      (collider) => this.byCollider.has(collider.handle) && !ignored.has(collider.handle) && !collider.containsPoint(origin),
    );
    if (!hit) return undefined;
    const link = this.byCollider.get(hit.collider.handle)!;
    const t = hit.timeOfImpact;
    return { entity: link.entity, x: from.x + dx * t, y: from.y + dy * t, distance: t * length, normal: fromRapier(hit.normal) };
  }

  raw(resolve: (target: unknown) => Entity | undefined): unknown {
    const linkOf = (target: unknown) => {
      const e = resolve(target);
      return e ? this.links.get(e) : undefined;
    };
    return {
      RAPIER,
      world: this.world,
      body: (target: unknown) => linkOf(target)?.body,
      collider: (target: unknown) => linkOf(target)?.collider,
      joint: (target: unknown, index = 0) => linkOf(target)?.joints[index],
      toRapier: (p: { x: number; y: number }) => toRapier(p.x, p.y),
      fromRapier,
    };
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

/** A point given as an offset from a body's center (in its own, turning frame), in Ludra's world. */
function worldPoint(body: RigidBody, offset: { x: number; y: number }): { x: number; y: number } {
  const p = body.translation();
  const angle = body.rotation();
  const local = toRapier(offset.x, offset.y);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return fromRapier({ x: p.x + local.x * cos - local.y * sin, y: p.y + local.x * sin + local.y * cos });
}

/** A Ludra world point in a body's own Rapier frame. */
function localPoint(body: RigidBody, point: { x: number; y: number }): { x: number; y: number } {
  const p = body.translation();
  const r = toRapier(point.x, point.y);
  return rotateBack(body, { x: r.x - p.x, y: r.y - p.y });
}

/** A Rapier world vector in a body's own frame. */
function rotateBack(body: RigidBody, v: { x: number; y: number }): { x: number; y: number } {
  const cos = Math.cos(-body.rotation());
  const sin = Math.sin(-body.rotation());
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
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
  if (b.shape === "polygon" || b.shape === "polyline") {
    // Points are mirrored into Rapier's y-up space.
    const points = new Float32Array(b.points.flatMap(([x, y]) => [x, -y]));
    if (b.shape === "polyline") return RAPIER.ColliderDesc.polyline(points);
    // A degenerate polygon (all points on a line) falls back to the bounding box.
    return RAPIER.ColliderDesc.convexHull(points) ?? RAPIER.ColliderDesc.cuboid(b.width / 2, b.height / 2);
  }
  return RAPIER.ColliderDesc.cuboid(b.width / 2, b.height / 2);
}
