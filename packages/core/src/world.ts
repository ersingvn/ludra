import {
  resolveComponent,
  type Body,
  type Camera,
  type Collectible,
  type Emitter,
  type Goal,
  type Hazard,
  type Patrol,
  type Platformer,
  type Sprite,
  type Transform,
} from "./components.ts";
import { FIXED_DT } from "./time.ts";
import type { Action, Diagnostic, EntityDef, SceneDef } from "./types.ts";
import { validateScene } from "./validate.ts";

export interface BodyState extends Body {
  grounded: boolean;
  /** The solid this body is standing on, so moving platforms can carry it. */
  standingOn?: Entity;
}

export interface PlatformerState extends Platformer {
  coyoteTimer: number;
  bufferTimer: number;
  spawnX: number;
  spawnY: number;
}

export interface PatrolState extends Patrol {
  originX: number;
  originY: number;
}

export interface Entity {
  id: string;
  transform: Transform;
  body?: BodyState;
  sprite?: Sprite;
  platformer?: PlatformerState;
  collectible?: Collectible;
  patrol?: PatrolState;
  hazard?: Hazard;
  goal?: Goal;
  emitter?: Emitter;
  camera?: Camera;
}

/** `x`/`y` is where it happened, e.g. the coin's position for "collect" or the feet for "land". */
export type GameEvent = { frame: number; time: number; x: number; y: number } & (
  | { type: "jump"; entity: string }
  | { type: "land"; entity: string }
  | { type: "collect"; entity: string; item: string; score: number }
  | { type: "die"; entity: string; cause: string }
  | { type: "stomp"; entity: string; enemy: string; score: number }
  | { type: "win"; entity: string; goal: string }
);

type EventPayload = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, "frame" | "time"> : never) : never;

export interface EntitySnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
}

export interface WorldSnapshot {
  frame: number;
  time: number;
  score: number;
  deaths: number;
  won: boolean;
  entities: Record<string, EntitySnapshot>;
}

export class SceneValidationError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    const errors = diagnostics.filter((d) => d.severity === "error");
    super(`Scene has ${errors.length} error(s): ${errors.map((d) => `${d.path}: ${d.message}`).join("; ")}`);
    this.diagnostics = diagnostics;
  }
}

const DEFAULT_GRAVITY = 1800;
const MAX_FALL_SPEED = 1400;
/** When jump is released early, upward speed is capped to this fraction of jumpSpeed. */
const JUMP_CUT = 0.45;
/** Upward speed after stomping an enemy, as a fraction of jumpSpeed. */
const STOMP_BOUNCE = 0.6;
/** How far a player's feet may sink into an enemy and still count as a stomp. */
const STOMP_TOLERANCE = 8;
/** A platformer this far below the bottom of the world has fallen out of it. */
const FALL_MARGIN = 100;
const EPSILON = 1e-4;

/**
 * The simulation. It advances only through `step`, one fixed frame at a time,
 * and contains no randomness or wall-clock time, so the same scene and inputs
 * always produce the same result.
 */
export class World {
  readonly width: number;
  readonly height: number;
  readonly gravity: number;
  readonly background: string;
  readonly entities: Entity[];
  readonly events: GameEvent[] = [];
  frame = 0;
  score = 0;
  deaths = 0;
  /** Set when a player reaches a goal. The simulation stops changing after that. */
  won = false;
  private previousInput: ReadonlySet<Action> = new Set();

  constructor(scene: SceneDef) {
    this.width = scene.world?.width ?? 960;
    this.height = scene.world?.height ?? 540;
    this.gravity = scene.world?.gravity ?? DEFAULT_GRAVITY;
    this.background = scene.world?.background ?? "#1d2333";
    this.entities = scene.entities.map(createEntity);
  }

  /** Validates raw scene JSON and builds a world, throwing on errors. */
  static fromJSON(raw: unknown): World {
    const { scene, diagnostics } = validateScene(raw);
    if (!scene) throw new SceneValidationError(diagnostics);
    return new World(scene);
  }

  get time(): number {
    return this.frame * FIXED_DT;
  }

  get(id: string): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  /** Advances one frame with the given actions held down. */
  step(input: ReadonlySet<Action>): void {
    const pressed = new Set([...input].filter((action) => !this.previousInput.has(action)));
    this.previousInput = new Set(input);
    this.frame++;
    if (this.won) return;

    this.updatePlatformers(input, pressed);
    this.updatePatrols();
    this.updateBodies();
    this.updateCollectibles();
    this.updateHazards();
    this.updateGoals();
  }

  snapshot(): WorldSnapshot {
    const entities: Record<string, EntitySnapshot> = {};
    for (const e of this.entities) {
      entities[e.id] = {
        x: e.transform.x,
        y: e.transform.y,
        vx: e.body?.vx ?? 0,
        vy: e.body?.vy ?? 0,
        grounded: e.body?.grounded ?? false,
      };
    }
    return { frame: this.frame, time: this.time, score: this.score, deaths: this.deaths, won: this.won, entities };
  }

  private emit(event: EventPayload): void {
    this.events.push({ ...event, frame: this.frame, time: this.time } as GameEvent);
  }

  private remove(entity: Entity): void {
    this.entities.splice(this.entities.indexOf(entity), 1);
  }

  private players(): Entity[] {
    return this.entities.filter((e) => e.platformer && e.body);
  }

  private updatePlatformers(held: ReadonlySet<Action>, pressed: ReadonlySet<Action>): void {
    for (const e of this.players()) {
      const p = e.platformer!;
      const b = e.body!;

      const direction = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
      b.vx = direction * p.speed;

      // Timers get a tiny extra margin so a value of 0 still allows a jump on the exact frame.
      if (b.grounded) p.coyoteTimer = p.coyoteTime + EPSILON;
      if (pressed.has("jump")) p.bufferTimer = p.jumpBuffer + EPSILON;

      if (p.bufferTimer > 0 && p.coyoteTimer > 0) {
        b.vy = -p.jumpSpeed;
        b.grounded = false;
        b.standingOn = undefined;
        p.bufferTimer = 0;
        p.coyoteTimer = 0;
        this.emit({ type: "jump", entity: e.id, ...feet(e) });
      } else if (p.variableJump && !held.has("jump") && b.vy < -p.jumpSpeed * JUMP_CUT) {
        b.vy = -p.jumpSpeed * JUMP_CUT;
      }

      p.coyoteTimer = Math.max(0, p.coyoteTimer - FIXED_DT);
      p.bufferTimer = Math.max(0, p.bufferTimer - FIXED_DT);
    }
  }

  /** Points each patrolling body toward the end of its path it is heading for. */
  private updatePatrols(): void {
    for (const e of this.entities) {
      const patrol = e.patrol;
      const b = e.body;
      if (!patrol || !b) continue;
      const alongX = patrol.axis === "x";
      const offset = alongX ? e.transform.x - patrol.originX : e.transform.y - patrol.originY;
      const current = alongX ? b.vx : b.vy;
      let direction = current < 0 ? -1 : 1;
      if (offset >= patrol.distance) direction = -1;
      else if (offset <= 0) direction = 1;
      b.vx = alongX ? direction * patrol.speed : 0;
      b.vy = alongX ? 0 : direction * patrol.speed;
    }
  }

  private updateBodies(): void {
    // Kinematic bodies move first, so anything standing on them can follow.
    const moved = new Map<Entity, { dx: number; dy: number }>();
    for (const e of this.entities) {
      const b = e.body;
      if (!b || b.type !== "kinematic") continue;
      const { x, y } = e.transform;
      e.transform.x += b.vx * FIXED_DT;
      e.transform.y += b.vy * FIXED_DT;
      if (e.patrol) clampToPatrol(e, e.patrol);
      moved.set(e, { dx: e.transform.x - x, dy: e.transform.y - y });
    }

    const solids = this.entities.filter((e) => e.body && !e.body.sensor && e.body.type !== "dynamic");

    for (const e of this.entities) {
      const b = e.body;
      if (!b || b.type !== "dynamic") continue;

      const carried = b.standingOn && moved.get(b.standingOn);
      if (carried) {
        e.transform.x += carried.dx;
        e.transform.y += carried.dy;
      }

      b.vy = Math.min(b.vy + this.gravity * b.gravityScale * FIXED_DT, MAX_FALL_SPEED);
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
        b.vx = 0;
      }

      e.transform.y += b.vy * FIXED_DT;
      for (const solid of solids) {
        if (!overlaps(e, solid)) continue;
        const half = (solid.body!.height + b.height) / 2;
        if (b.vy > 0) {
          e.transform.y = solid.transform.y - half;
          b.grounded = true;
          b.standingOn = solid;
        } else if (b.vy < 0) {
          e.transform.y = solid.transform.y + half;
        }
        b.vy = 0;
      }

      if (b.grounded && !wasGrounded) this.emit({ type: "land", entity: e.id, ...feet(e) });
    }
  }

  private updateCollectibles(): void {
    const players = this.players();
    for (const item of this.entities.filter((e) => e.collectible && e.body)) {
      const collector = players.find((p) => overlaps(p, item));
      if (!collector) continue;
      this.remove(item);
      this.score += item.collectible!.score;
      this.emit({ type: "collect", entity: collector.id, item: item.id, score: item.collectible!.score, ...item.transform });
    }
  }

  private updateHazards(): void {
    for (const player of this.players()) {
      const b = player.body!;
      if (player.transform.y - b.height / 2 > this.height + FALL_MARGIN) {
        this.kill(player, "fall");
        continue;
      }
      for (const hazard of this.entities.filter((e) => e.hazard && e.body)) {
        if (!overlaps(player, hazard)) continue;
        if (hazard.hazard!.stompable && isStomp(player, hazard)) {
          this.remove(hazard);
          b.vy = -player.platformer!.jumpSpeed * STOMP_BOUNCE;
          this.score += hazard.hazard!.score;
          this.emit({ type: "stomp", entity: player.id, enemy: hazard.id, score: hazard.hazard!.score, ...hazard.transform });
          continue;
        }
        this.kill(player, hazard.id);
        break;
      }
    }
  }

  private updateGoals(): void {
    for (const goal of this.entities.filter((e) => e.goal && e.body)) {
      if (this.score < goal.goal!.requireScore) continue;
      const player = this.players().find((p) => overlaps(p, goal));
      if (!player) continue;
      this.won = true;
      this.emit({ type: "win", entity: player.id, goal: goal.id, ...goal.transform });
      return;
    }
  }

  /** Sends a player back to where it started. Collected items stay collected. */
  private kill(player: Entity, cause: string): void {
    const b = player.body!;
    const p = player.platformer!;
    this.deaths++;
    this.emit({ type: "die", entity: player.id, cause, ...player.transform });
    player.transform.x = p.spawnX;
    player.transform.y = p.spawnY;
    b.vx = 0;
    b.vy = 0;
    b.grounded = false;
    b.standingOn = undefined;
    p.coyoteTimer = 0;
    p.bufferTimer = 0;
  }
}

function createEntity(def: EntityDef): Entity {
  const c = def.components;
  const transform = c.transform ? resolveComponent<Transform>("transform", c.transform) : { x: 0, y: 0 };
  const entity: Entity = { id: def.id, transform };
  if (c.body) entity.body = { ...resolveComponent<Body>("body", c.body), grounded: false };
  if (c.sprite) entity.sprite = resolveComponent<Sprite>("sprite", c.sprite);
  if (c.platformer) {
    entity.platformer = {
      ...resolveComponent<Platformer>("platformer", c.platformer),
      coyoteTimer: 0,
      bufferTimer: 0,
      spawnX: transform.x,
      spawnY: transform.y,
    };
  }
  if (c.collectible) entity.collectible = resolveComponent<Collectible>("collectible", c.collectible);
  if (c.patrol) entity.patrol = { ...resolveComponent<Patrol>("patrol", c.patrol), originX: transform.x, originY: transform.y };
  if (c.hazard) entity.hazard = resolveComponent<Hazard>("hazard", c.hazard);
  if (c.goal) entity.goal = resolveComponent<Goal>("goal", c.goal);
  if (c.emitter) entity.emitter = resolveComponent<Emitter>("emitter", c.emitter);
  if (c.camera) entity.camera = resolveComponent<Camera>("camera", c.camera);
  return entity;
}

function feet(e: Entity): { x: number; y: number } {
  return { x: e.transform.x, y: e.transform.y + (e.body?.height ?? 0) / 2 };
}

function clampToPatrol(e: Entity, patrol: PatrolState): void {
  if (patrol.axis === "x") e.transform.x = Math.min(patrol.originX + patrol.distance, Math.max(patrol.originX, e.transform.x));
  else e.transform.y = Math.min(patrol.originY + patrol.distance, Math.max(patrol.originY, e.transform.y));
}

/** A stomp is a falling player whose feet were above the enemy's top on the previous frame. */
function isStomp(player: Entity, enemy: Entity): boolean {
  const b = player.body!;
  if (b.vy <= 0) return false;
  const previousBottom = player.transform.y - b.vy * FIXED_DT + b.height / 2;
  const enemyTop = enemy.transform.y - enemy.body!.height / 2;
  return previousBottom <= enemyTop + STOMP_TOLERANCE;
}

/** Strict overlap: bodies that merely touch (e.g. standing on the ground) do not overlap. */
export function overlaps(a: Entity, b: Entity): boolean {
  if (!a.body || !b.body) return false;
  return (
    Math.abs(a.transform.x - b.transform.x) < (a.body.width + b.body.width) / 2 - EPSILON &&
    Math.abs(a.transform.y - b.transform.y) < (a.body.height + b.body.height) / 2 - EPSILON
  );
}
