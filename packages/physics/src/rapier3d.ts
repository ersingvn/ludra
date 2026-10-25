import RAPIER, {
  type Collider,
  type ColliderDesc,
  type ImpulseJoint,
  type KinematicCharacterController,
  type RigidBody,
  type World as RapierWorld,
} from "@dimforge/rapier3d-deterministic-compat";
import { FIXED_DT, registerPhysics, type Body, type Entity, type PhysicsEngine, type PhysicsHost, type PhysicsSettings, type RayHit, type RayOptions } from "@ludra/core";

/**
 * Ludra's 3D worlds use Rapier's own conventions: metres, +y up, right-handed (+z toward
 * the viewer). Nothing is mirrored, unlike 2D. Rotations are degrees in Ludra, applied
 * y (turn), then x (tilt), then z (roll), and quaternions in Rapier.
 */

interface Vec3 {
  x: number;
  y: number;
  z: number;
}
interface Quat extends Vec3 {
  w: number;
}

const DEGREES = Math.PI / 180;
/** How firmly a joint motor drives toward its target speed (it is capped by motorForce). */
const MOTOR_FACTOR = 1000;
/** Impacts slower than this (m/s) don't count as a bounce. */
const MIN_BOUNCE_SPEED = 0.8;
/** A contact whose normal points this much up (toward the body) is ground under it. */
const GROUND_NORMAL = 0.7;
/** Players fall no faster than this, in m/s. */
const MAX_FALL_SPEED = 50;
/** The gap a character controller keeps from obstacles, in metres. */
const CONTROLLER_OFFSET = 0.01;
/** Players stay on the ground walking down slopes and off bumps up to this far, in metres. */
const SNAP_TO_GROUND = 0.2;
/** How far inside the feet the look-down for the ground starts, in metres. */
const FEET_PROBE = 0.05;
/** A standing player that loses contact still counts as grounded for this many steps. */
const COYOTE_STEPS = 3;

/** A Ludra entity, its Rapier body and collider, and the transform last written to it. */
interface Link {
  entity: Entity;
  body: RigidBody;
  collider: Collider;
  /** The position and rotation (degrees) last exchanged with Rapier, to notice gameplay's changes. */
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  /** The rotation last exchanged, as Rapier's quaternion: unchanged means no Euler round trip. */
  q: Quat;
  controller?: KinematicCharacterController;
  /** How far a kinematic mover moved in the last step, so players standing on it ride along. */
  d: Vec3;
  teleported: boolean;
  airborne: number;
  joints: (ImpulseJoint | undefined)[];
  anchors: RigidBody[];
}

let loading: Promise<void> | undefined;

/**
 * Loads Rapier 3D's WebAssembly and registers the "rapier3d" engine, which every scene with
 * `"dimensions": 3` runs on. Safe to call more than once.
 */
export function loadRapier3DPhysics(): Promise<void> {
  loading ??= RAPIER.init().then(() => registerPhysics("rapier3d", (settings) => new Rapier3DPhysics(settings)));
  return loading;
}

const cleanup = new FinalizationRegistry<RapierWorld>((world) => world.free());

/** Degrees (applied y, then x, then z) to a quaternion. */
export function quaternionFromDegrees(x: number, y: number, z: number): Quat {
  const half = (a: number) => (a * DEGREES) / 2;
  const qy = { x: 0, y: Math.sin(half(y)), z: 0, w: Math.cos(half(y)) };
  const qx = { x: Math.sin(half(x)), y: 0, z: 0, w: Math.cos(half(x)) };
  const qz = { x: 0, y: 0, z: Math.sin(half(z)), w: Math.cos(half(z)) };
  return multiply(multiply(qy, qx), qz);
}

/** A quaternion back to degrees (y, then x, then z), as three.js's "YXZ" order reads it. */
export function degreesFromQuaternion(q: Quat): Vec3 {
  const { x, y, z, w } = q;
  const m13 = 2 * (x * z + y * w);
  const m21 = 2 * (x * y + z * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m31 = 2 * (x * z - y * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const m11 = 1 - 2 * (y * y + z * z);
  const tilt = Math.asin(Math.max(-1, Math.min(1, -m23)));
  // Looking straight up or down, turn and roll are the same thing: put it all in turn.
  const gimbal = Math.abs(m23) > 0.9999999;
  return {
    x: tilt / DEGREES,
    y: (gimbal ? Math.atan2(-m31, m11) : Math.atan2(m13, m33)) / DEGREES,
    z: gimbal ? 0 : Math.atan2(m21, m22) / DEGREES,
  };
}

function multiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function conjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** v rotated by q. */
function rotate(q: Quat, v: Vec3): Vec3 {
  const p = multiply(multiply(q, { ...v, w: 0 }), conjugate(q));
  return { x: p.x, y: p.y, z: p.z };
}

const sameQuat = (a: Quat, b: Quat) => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;

/**
 * Ludra's 3D physics engine: Rapier 3D's deterministic build, so a simulation is bit-for-bit
 * the same on every machine and in the browser. Bodies rotate in 3D, can be boxes, spheres,
 * capsules, cylinders or convex hulls, and have friction and mass; players walk through
 * Rapier's character controller.
 */
export class Rapier3DPhysics implements PhysicsEngine {
  readonly name = "rapier3d";
  readonly world: RapierWorld;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly links = new Map<Entity, Link>();
  private readonly byCollider = new Map<number, Link>();
  private pendingJoints: { entity: Entity; index: number }[] = [];

  constructor(settings: PhysicsSettings) {
    this.world = new RAPIER.World({ x: 0, y: -settings.gravity, z: 0 });
    this.world.timestep = FIXED_DT;
    cleanup.register(this, this.world);
  }

  add(entity: Entity): void {
    const b = entity.body;
    if (!b) return;
    const t = entity.transform;
    const player = isPlayer(entity);
    // A character controller starting in contact can't keep its gap: lift it clear first.
    if (player) t.y += CONTROLLER_OFFSET;
    const desc =
      b.type === "dynamic" && !player ? RAPIER.RigidBodyDesc.dynamic() : b.type === "static" ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.kinematicPositionBased();
    const q = quaternionFromDegrees(t.rotationX, t.rotationY, t.rotation);
    desc.setTranslation(t.x, t.y, t.z).setRotation(q);
    if (b.type === "dynamic" && !player) {
      desc.setGravityScale(b.gravityScale).setLinvel(b.vx, b.vy, b.vz).setCcdEnabled(b.bullet);
      if (b.fixedRotation) desc.lockRotations();
    }
    const body = this.world.createRigidBody(desc);
    const collider = this.world.createCollider(
      shape(b)
        .setSensor(b.sensor)
        .setRestitution(b.bounce)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setFriction(b.friction)
        .setDensity(b.density)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL),
      body,
    );
    const link: Link = {
      entity,
      body,
      collider,
      x: t.x,
      y: t.y,
      z: t.z,
      rx: t.rotationX,
      ry: t.rotationY,
      rz: t.rotation,
      q,
      d: { x: 0, y: 0, z: 0 },
      teleported: false,
      airborne: Infinity,
      joints: [],
      anchors: [],
    };
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
      const ownAnchor = vec(spec.anchor);
      const here = worldPoint(link.body, ownAnchor);
      // Hinges, sliders, welds and ball joints join both bodies at that same point; ropes and
      // springs run from there to their other end (toAnchor).
      const sameSpot = spec.type !== "rope" && spec.type !== "spring";
      let base: RigidBody;
      let there: Vec3;
      if (other) {
        base = other.body;
        there = sameSpot ? here : worldPoint(other.body, vec(spec.toAnchor));
      } else {
        const t = entity.transform;
        const offset = vec(spec.toAnchor);
        there = sameSpot ? here : { x: t.x + offset.x, y: t.y + offset.y, z: t.z + offset.z };
        base = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(there.x, there.y, there.z));
        link.anchors.push(base);
      }
      const baseAnchor = localPoint(base, there);
      // The axis is given in the world; each body measures it in its own frame.
      const axis = jointAxis(spec.axis, spec.type);
      const baseQ = base.rotation();
      const ownQ = link.body.rotation();
      const length = spec.length || Math.hypot(there.x - here.x, there.y - here.y, there.z - here.z);
      const data =
        spec.type === "prismatic"
          ? RAPIER.JointData.prismatic(baseAnchor, ownAnchor, rotate(conjugate(baseQ), axis))
          : spec.type === "fixed"
            ? // Welded as they are now: frame1 · base = own.
              RAPIER.JointData.fixed(baseAnchor, multiply(conjugate(baseQ), ownQ), ownAnchor, { x: 0, y: 0, z: 0, w: 1 })
            : spec.type === "rope"
              ? RAPIER.JointData.rope(length, baseAnchor, ownAnchor)
              : spec.type === "spring"
                ? RAPIER.JointData.spring(length, spec.stiffness, spec.damping, baseAnchor, ownAnchor)
                : spec.type === "spherical"
                  ? RAPIER.JointData.spherical(baseAnchor, ownAnchor)
                  : RAPIER.JointData.revoluteWithAxes(baseAnchor, ownAnchor, rotate(conjugate(baseQ), axis), rotate(conjugate(ownQ), axis));
      const joint = this.world.createImpulseJoint(data, base, link.body, true);
      joint.setContactsEnabled(spec.collide);
      if (spec.type === "revolute" || spec.type === "prismatic") {
        const unit = joint as unknown as {
          setLimits(min: number, max: number): void;
          setMotorMaxForce(force: number): void;
          configureMotorVelocity(velocity: number, factor: number): void;
        };
        // Angles follow the right-hand rule around the axis; positions run along it.
        const scale = spec.type === "revolute" ? DEGREES : 1;
        if (spec.min < spec.max) unit.setLimits(spec.min * scale, spec.max * scale);
        if (spec.motorForce > 0) {
          unit.setMotorMaxForce(spec.motorForce);
          unit.configureMotorVelocity(spec.motorSpeed * scale, MOTOR_FACTOR);
        }
      }
      link.joints[index] = joint;
    }
    this.pendingJoints = waiting;
  }

  private createController(entity: Entity): KinematicCharacterController {
    const b = entity.body!;
    const c = entity.character;
    const controller = this.world.createCharacterController(CONTROLLER_OFFSET);
    controller.setSlideEnabled(true);
    const push = c?.push ?? 1;
    controller.setApplyImpulsesToDynamicBodies(push > 0);
    if (push > 0) controller.setCharacterMass(b.density * volume(b) * push);
    if (c) {
      controller.setMaxSlopeClimbAngle(c.maxSlope * DEGREES);
      controller.setMinSlopeSlideAngle(c.maxSlope * DEGREES);
      controller.enableSnapToGround(Math.max(SNAP_TO_GROUND, c.stepHeight));
      if (c.stepHeight > 0) controller.enableAutostep(c.stepHeight, b.width / 2, false);
    }
    return controller;
  }

  step(host: PhysicsHost): void {
    this.connectJoints(host);
    for (const link of this.links.values()) {
      const { entity: e, body } = link;
      const b = e.body!;
      const t = e.transform;
      const moved = t.x !== link.x || t.y !== link.y || t.z !== link.z;
      const turned = t.rotationX !== link.rx || t.rotationY !== link.ry || t.rotation !== link.rz;
      if (turned) link.q = quaternionFromDegrees(t.rotationX, t.rotationY, t.rotation);
      // Players turn to face where they walk: that's not a teleport.
      link.teleported = moved || (turned && !link.controller);
      if (link.controller) {
        if (turned) body.setNextKinematicRotation(link.q);
        continue;
      }
      if (link.teleported) {
        body.setTranslation(t, true);
        body.setRotation(link.q, true);
      }
      if (b.type === "dynamic") {
        body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
      } else if (b.type === "kinematic") {
        const before = { x: t.x, y: t.y, z: t.z };
        t.x += b.vx * FIXED_DT;
        t.y += b.vy * FIXED_DT;
        t.z += b.vz * FIXED_DT;
        if (e.patrol) clampToPatrol3D(e);
        body.setNextKinematicTranslation(t);
        if (turned) body.setNextKinematicRotation(link.q);
        link.d = { x: t.x - before.x, y: t.y - before.y, z: t.z - before.z };
      }
    }
    for (const link of this.links.values()) if (link.controller) this.moveCharacter(link, host);

    this.world.step(this.events);

    for (const link of this.links.values()) {
      const { entity: e, body } = link;
      const b = e.body!;
      const t = e.transform;
      if (b.type !== "static") {
        const p = body.translation();
        t.x = p.x;
        t.y = p.y;
        t.z = p.z;
        const q = body.rotation();
        // Only a body that really turned goes through quaternion → degrees, so set rotations stay exact.
        if (!sameQuat(q, link.q) && !link.controller) {
          const r = degreesFromQuaternion(q);
          t.rotationX = r.x;
          t.rotationY = r.y;
          t.rotation = r.z;
          link.q = { x: q.x, y: q.y, z: q.z, w: q.w };
        }
        if (b.type === "dynamic" && !link.controller) {
          const v = body.linvel();
          b.vx = v.x;
          b.vy = v.y;
          b.vz = v.z;
        }
      }
      link.x = t.x;
      link.y = t.y;
      link.z = t.z;
      link.rx = t.rotationX;
      link.ry = t.rotationY;
      link.rz = t.rotation;
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
        if (b.type !== "dynamic" || b.bounce <= 0 || Math.hypot(b.vx, b.vy, b.vz) < MIN_BOUNCE_SPEED) continue;
        host.emit({ type: "bounce", entity: self.entity.id, other: other.entity.id, ...at(self.entity) });
      }
    });
  }

  /**
   * Moves a player by its velocity (plus gravity, and the platform it stands on) through the
   * character controller, which resolves slopes, steps and walls.
   */
  private moveCharacter(link: Link, host: PhysicsHost): void {
    const { entity: e, body, collider } = link;
    const controller = link.controller!;
    const b = e.body!;
    const t = e.transform;
    const falls = !!e.character;
    const wasGrounded = b.grounded;
    if (link.teleported) {
      // A respawn: start from rest where gameplay put it, just clear of the ground.
      t.y += CONTROLLER_OFFSET;
      body.setTranslation(t, true);
      body.setNextKinematicTranslation(t);
      body.setNextKinematicRotation(link.q);
      b.grounded = false;
      b.standingOn = undefined;
      link.airborne = Infinity;
      return;
    }
    // Gravity only while not touching the ground (or jumping off), as in 2D.
    if (falls) b.vy = link.airborne === 0 && b.vy <= 0 ? 0 : Math.max(b.vy - host.gravity * b.gravityScale * FIXED_DT, -MAX_FALL_SPEED);
    const own = { x: b.vx * FIXED_DT, y: b.vy * FIXED_DT, z: b.vz * FIXED_DT };
    // Ride along with a moving platform: the controller doesn't carry a standing character, and
    // sliding it across the platform's top through the controller catches on it now and then,
    // so the rider moves with the platform as one piece and the controller resolves only its own walk.
    const carrier = b.standingOn ? this.links.get(b.standingOn) : undefined;
    const carry = carrier?.d ?? { x: 0, y: 0, z: 0 };
    controller.computeColliderMovement(
      collider,
      own,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      (other) => other.handle !== collider.handle,
    );
    const moved = controller.computedMovement();
    t.x += moved.x + carry.x;
    t.y += moved.y + carry.y;
    t.z += moved.z + carry.z;
    body.setNextKinematicTranslation(t);

    const touching = falls && controller.computedGrounded();
    link.airborne = touching ? 0 : link.airborne + 1;
    b.grounded = touching || (falls && wasGrounded && b.vy <= 0 && link.airborne <= COYOTE_STEPS);
    const previous = b.standingOn;
    b.standingOn = undefined;
    let ceiling = false;
    for (let i = 0; i < controller.numComputedCollisions(); i++) {
      const hit = controller.computedCollision(i);
      if (!hit) continue;
      // Normals point at the player: up from the ground, down from a ceiling.
      if (hit.normal1.y > GROUND_NORMAL && b.grounded && hit.collider) b.standingOn = this.byCollider.get(hit.collider.handle)?.entity;
      if (hit.normal1.y < -GROUND_NORMAL) ceiling = true;
    }
    if (b.grounded) {
      // Snapping onto the ground reports no contact, so look down from the feet for what's there.
      const feetY = t.y - b.height / 2;
      const below = this.world.castRay(
        new RAPIER.Ray({ x: t.x, y: feetY + FEET_PROBE, z: t.z }, { x: 0, y: -1, z: 0 }),
        FEET_PROBE + CONTROLLER_OFFSET + SNAP_TO_GROUND,
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider,
      );
      const ground = below ? this.byCollider.get(below.collider.handle)?.entity : undefined;
      b.standingOn = ground ?? b.standingOn ?? previous;
    }
    if (touching && b.vy < 0) b.vy = 0;
    // Bumped its head: stop rising (a wall it slides up doesn't count).
    if (own.y > 0 && moved.y < own.y - 1e-6 && ceiling) b.vy = 0;
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
        // The normal points from the first collider to the second: a solid below has one pointing down.
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

  applyImpulse(e: Entity, x: number, y: number, at?: { x: number; y: number; z?: number }, z = 0): void {
    const link = this.links.get(e);
    const b = e.body;
    if (!link || !b || b.type === "static") return;
    if (link.controller) {
      const mass = link.collider.mass() || 1;
      b.vx += x / mass;
      b.vy += y / mass;
      b.vz += z / mass;
      return;
    }
    if (b.type !== "dynamic") return;
    const impulse = { x, y, z };
    if (at) link.body.applyImpulseAtPoint(impulse, { x: at.x, y: at.y, z: at.z ?? e.transform.z }, true);
    else link.body.applyImpulse(impulse, true);
    const v = link.body.linvel();
    b.vx = v.x;
    b.vy = v.y;
    b.vz = v.z;
  }

  /** Spin around z, in degrees per second (the axis the screen faces). */
  angularVelocity(e: Entity): number {
    const body = this.links.get(e)?.body;
    return body ? body.angvel().z / DEGREES : 0;
  }

  setAngularVelocity(e: Entity, value: number): void {
    const link = this.links.get(e);
    if (!link || e.body?.type !== "dynamic" || link.controller) return;
    const w = link.body.angvel();
    link.body.setAngvel({ x: w.x, y: w.y, z: value * DEGREES }, true);
  }

  raycast(_host: PhysicsHost, from: { x: number; y: number; z?: number }, to: { x: number; y: number; z?: number }, options: RayOptions = {}): RayHit | undefined {
    const origin = { x: from.x, y: from.y, z: from.z ?? 0 };
    const dir = { x: to.x - from.x, y: to.y - from.y, z: (to.z ?? 0) - origin.z };
    const length = Math.hypot(dir.x, dir.y, dir.z);
    if (length === 0) return undefined;
    const ignored = new Set((options.ignore ?? []).map((e) => this.links.get(e)?.collider.handle));
    const hit = this.world.castRayAndGetNormal(
      new RAPIER.Ray(origin, dir),
      1,
      true,
      options.sensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      (collider) => this.byCollider.has(collider.handle) && !ignored.has(collider.handle) && !collider.containsPoint(origin),
    );
    if (!hit) return undefined;
    const link = this.byCollider.get(hit.collider.handle)!;
    const t = hit.timeOfImpact;
    return {
      entity: link.entity,
      x: origin.x + dir.x * t,
      y: origin.y + dir.y * t,
      z: origin.z + dir.z * t,
      distance: t * length,
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
    } as RayHit;
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

function vec(v: { x: number; y: number; z?: number }): Vec3 {
  return { x: v.x, y: v.y, z: v.z ?? 0 };
}

/** The joint's direction in the world: a vector in 3D, or the default for its type. */
function jointAxis(axis: number | { x?: number; y?: number; z?: number }, type: string): Vec3 {
  const v = typeof axis === "object" ? { x: axis.x ?? 0, y: axis.y ?? 0, z: axis.z ?? 0 } : type === "prismatic" ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/** A point given as an offset from a body's center (in its own, turning frame), in the world. */
function worldPoint(body: RigidBody, offset: Vec3): Vec3 {
  const p = body.translation();
  const r = rotate(body.rotation(), offset);
  return { x: p.x + r.x, y: p.y + r.y, z: p.z + r.z };
}

/** A world point in a body's own frame. */
function localPoint(body: RigidBody, point: Vec3): Vec3 {
  const p = body.translation();
  return rotate(conjugate(body.rotation()), { x: point.x - p.x, y: point.y - p.y, z: point.z - p.z });
}

function at(e: Entity): Vec3 {
  return { x: e.transform.x, y: e.transform.y, z: e.transform.z };
}

/** Where a body stands: the bottom of it (+y is up). */
function feet(e: Entity): Vec3 {
  return { x: e.transform.x, y: e.transform.y - (e.body?.height ?? 0) / 2, z: e.transform.z };
}

function clampToPatrol3D(e: Entity): void {
  const p = e.patrol!;
  const t = e.transform;
  if (p.axis === "x") t.x = Math.min(p.originX + p.distance, Math.max(p.originX, t.x));
  else if (p.axis === "z") t.z = Math.min(p.originZ + p.distance, Math.max(p.originZ, t.z));
  else t.y = Math.min(p.originY + p.distance, Math.max(p.originY, t.y));
}

function isPlayer(e: Entity): boolean {
  return !!e.character && !!e.body && e.body.type !== "static";
}

function depth(b: Body): number {
  return b.depth || b.width;
}

function volume(b: Body): number {
  return b.width * b.height * depth(b);
}

function shape(b: Body): ColliderDesc {
  if (b.shape === "sphere") return RAPIER.ColliderDesc.ball(b.width / 2);
  // Capsules and cylinders stand upright: height is end to end, width the diameter.
  if (b.shape === "capsule") return RAPIER.ColliderDesc.capsule(Math.max(0, b.height - b.width) / 2, b.width / 2);
  if (b.shape === "cylinder") return RAPIER.ColliderDesc.cylinder(b.height / 2, b.width / 2);
  if (b.shape === "convex") {
    const points = new Float32Array(b.points.flatMap(([x, y, z]) => [x!, y!, z ?? 0]));
    return RAPIER.ColliderDesc.convexHull(points) ?? RAPIER.ColliderDesc.cuboid(b.width / 2, b.height / 2, depth(b) / 2);
  }
  return RAPIER.ColliderDesc.cuboid(b.width / 2, b.height / 2, depth(b) / 2);
}
