import {
  resolveComponent,
  type Body,
  type Camera,
  type Collectible,
  type Platformer,
  type Sprite,
  type Transform,
} from "./components.ts";
import { FIXED_DT } from "./time.ts";
import type { Action, Diagnostic, EntityDef, SceneDef } from "./types.ts";
import { validateScene } from "./validate.ts";

export interface BodyState extends Body {
  grounded: boolean;
}

export interface PlatformerState extends Platformer {
  coyoteTimer: number;
  bufferTimer: number;
}

export interface Entity {
  id: string;
  transform: Transform;
  body?: BodyState;
  sprite?: Sprite;
  platformer?: PlatformerState;
  collectible?: Collectible;
  camera?: Camera;
}

export type GameEvent = { frame: number; time: number } & (
  | { type: "jump"; entity: string }
  | { type: "land"; entity: string }
  | { type: "collect"; entity: string; item: string; score: number }
);

type EventPayload = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, "frame" | "time"> : never) : never;

export type GameEventType = GameEvent["type"];
export const EVENT_TYPES: readonly GameEventType[] = ["jump", "land", "collect"];

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
    this.frame++;
    this.updatePlatformers(input, pressed);
    this.updateBodies();
    this.updateCollectibles();
    this.previousInput = new Set(input);
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
    return { frame: this.frame, time: this.time, score: this.score, entities };
  }

  private emit(event: EventPayload): void {
    this.events.push({ ...event, frame: this.frame, time: this.time } as GameEvent);
  }

  private updatePlatformers(held: ReadonlySet<Action>, pressed: ReadonlySet<Action>): void {
    for (const e of this.entities) {
      const p = e.platformer;
      const b = e.body;
      if (!p || !b) continue;

      const direction = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
      b.vx = direction * p.speed;

      // Timers get a tiny extra margin so a value of 0 still allows a jump on the exact frame.
      if (b.grounded) p.coyoteTimer = p.coyoteTime + EPSILON;
      if (pressed.has("jump")) p.bufferTimer = p.jumpBuffer + EPSILON;

      if (p.bufferTimer > 0 && p.coyoteTimer > 0) {
        b.vy = -p.jumpSpeed;
        b.grounded = false;
        p.bufferTimer = 0;
        p.coyoteTimer = 0;
        this.emit({ type: "jump", entity: e.id });
      } else if (p.variableJump && !held.has("jump") && b.vy < -p.jumpSpeed * JUMP_CUT) {
        b.vy = -p.jumpSpeed * JUMP_CUT;
      }

      p.coyoteTimer = Math.max(0, p.coyoteTimer - FIXED_DT);
      p.bufferTimer = Math.max(0, p.bufferTimer - FIXED_DT);
    }
  }

  private updateBodies(): void {
    const solids = this.entities.filter((e) => e.body && !e.body.sensor && e.body.type !== "dynamic");

    for (const e of this.entities) {
      const b = e.body;
      if (!b || b.type === "static") continue;
      if (b.type === "kinematic") {
        e.transform.x += b.vx * FIXED_DT;
        e.transform.y += b.vy * FIXED_DT;
        continue;
      }

      b.vy = Math.min(b.vy + this.gravity * b.gravityScale * FIXED_DT, MAX_FALL_SPEED);
      const wasGrounded = b.grounded;
      b.grounded = false;

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
        } else if (b.vy < 0) {
          e.transform.y = solid.transform.y + half;
        }
        b.vy = 0;
      }

      if (b.grounded && !wasGrounded) this.emit({ type: "land", entity: e.id });
    }
  }

  private updateCollectibles(): void {
    const players = this.entities.filter((e) => e.platformer && e.body);
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const item = this.entities[i]!;
      if (!item.collectible || !item.body) continue;
      const collector = players.find((p) => overlaps(p, item));
      if (!collector) continue;
      this.entities.splice(i, 1);
      this.score += item.collectible.score;
      this.emit({ type: "collect", entity: collector.id, item: item.id, score: item.collectible.score });
    }
  }
}

function createEntity(def: EntityDef): Entity {
  const c = def.components;
  const entity: Entity = {
    id: def.id,
    transform: c.transform ? resolveComponent<Transform>("transform", c.transform) : { x: 0, y: 0 },
  };
  if (c.body) entity.body = { ...resolveComponent<Body>("body", c.body), grounded: false };
  if (c.sprite) entity.sprite = resolveComponent<Sprite>("sprite", c.sprite);
  if (c.platformer) entity.platformer = { ...resolveComponent<Platformer>("platformer", c.platformer), coyoteTimer: 0, bufferTimer: 0 };
  if (c.collectible) entity.collectible = resolveComponent<Collectible>("collectible", c.collectible);
  if (c.camera) entity.camera = resolveComponent<Camera>("camera", c.camera);
  return entity;
}

/** Strict overlap: bodies that merely touch (e.g. standing on the ground) do not overlap. */
export function overlaps(a: Entity, b: Entity): boolean {
  if (!a.body || !b.body) return false;
  return (
    Math.abs(a.transform.x - b.transform.x) < (a.body.width + b.body.width) / 2 - EPSILON &&
    Math.abs(a.transform.y - b.transform.y) < (a.body.height + b.body.height) / 2 - EPSILON
  );
}
