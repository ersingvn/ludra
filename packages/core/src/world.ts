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
  type ScriptComponent,
  type Sprite,
  type Topdown,
  type Transform,
} from "./components.ts";
import {
  getScript,
  ScriptError,
  type DrawContext,
  type Script,
  type ScriptContext,
  type ScriptEntity,
  type ScriptInput,
  type ScriptModules,
  type ScriptWorld,
  type SpawnDef,
} from "./script.ts";
import { FIXED_DT } from "./time.ts";
import { EVENT_TYPES, type Action, type Diagnostic, type EntityDef, type SceneDef } from "./types.ts";
import { validateScene } from "./validate.ts";

export interface BodyState extends Body {
  grounded: boolean;
  /** The solid this body is standing on, so moving platforms can carry it. */
  standingOn?: Entity;
}

export interface PlatformerState extends Platformer {
  coyoteTimer: number;
  /** True from a player-initiated jump until the apex, so only those jumps are cut short on release. */
  jumping: boolean;
  bufferTimer: number;
}

export interface PatrolState extends Patrol {
  originX: number;
  originY: number;
}

export interface ScriptState extends ScriptComponent {
  module: Script;
  started: boolean;
  /** Ids of entities touched last frame, so `touch` fires only when touching starts. */
  touching: Set<string>;
}

export interface Entity {
  id: string;
  /** Script-owned data, kept between frames and included in snapshots. */
  state: Record<string, unknown>;
  /** Set once destroyed or collected, so stale script handles report `exists: false`. */
  removed?: boolean;
  script?: ScriptState;
  transform: Transform;
  body?: BodyState;
  sprite?: Sprite;
  platformer?: PlatformerState;
  topdown?: Topdown;
  /** Where a player respawns after dying. */
  spawn?: { x: number; y: number };
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
  | { type: "bounce"; entity: string; other: string }
  /** Fired by a script with world.emit(name, data). */
  | { type: "custom"; name: string; entity: string; data?: unknown }
);

type EventPayload = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, "frame" | "time"> : never) : never;

export interface EntitySnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  /** Present when a script stored data on the entity. */
  state?: Record<string, unknown>;
}

export interface WorldOptions {
  /** Loaded script modules, keyed by the `src` path used in the scene. */
  scripts?: ScriptModules;
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
/** Bodies this close count as touching for `touch` hooks, so solids (doors, walls) can be touched too. */
const TOUCH_MARGIN = 1;
/** Impacts slower than this (px/s, after bounce) stop instead of bouncing. */
const MIN_BOUNCE_SPEED = 40;
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
  private readonly scripts: ScriptModules | undefined;
  private seed: number;
  private spawnCount = 0;
  private readonly handles = new WeakMap<Entity, ScriptEntity>();
  private scriptApi: ScriptWorld | undefined;
  private scriptInput: ScriptInput = { held: () => false, pressed: () => false };
  /** The script hook currently running, for error messages and event attribution. */
  private current: { entity: Entity; hook: string } | undefined;
  /** True while a draw hook runs: the game can't be changed then. */
  private drawing = false;

  constructor(scene: SceneDef, options: WorldOptions = {}) {
    this.width = scene.world?.width ?? 960;
    this.height = scene.world?.height ?? 540;
    this.gravity = scene.world?.gravity ?? DEFAULT_GRAVITY;
    this.background = scene.world?.background ?? "#1d2333";
    this.seed = scene.world?.seed ?? 1;
    this.scripts = options.scripts;
    this.entities = scene.entities.map((def) => this.createEntity(def));
  }

  /** Validates raw scene JSON and builds a world, throwing on errors. */
  static fromJSON(raw: unknown, options: WorldOptions = {}): World {
    const { scene, diagnostics } = validateScene(raw);
    if (!scene) throw new SceneValidationError(diagnostics);
    return new World(scene, options);
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
    this.updateTopdown(input);
    this.updateScripts(input, pressed);
    if (this.won) return;
    this.updatePatrols();
    this.updateBodies();
    this.updateTouches();
    if (this.won) return;
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
      // A JSON copy, so later frames can't change an earlier snapshot.
      if (Object.keys(e.state).length > 0) entities[e.id]!.state = JSON.parse(JSON.stringify(e.state));
    }
    return { frame: this.frame, time: this.time, score: this.score, deaths: this.deaths, won: this.won, entities };
  }

  private emit(event: EventPayload): void {
    this.events.push({ ...event, frame: this.frame, time: this.time } as GameEvent);
  }

  private remove(entity: Entity): void {
    const index = this.entities.indexOf(entity);
    if (index >= 0) this.entities.splice(index, 1);
    entity.removed = true;
  }

  // ---------------------------------------------------------------- scripts

  private createEntity(def: EntityDef): Entity {
    const entity = createEntity(def);
    const component = def.components.script;
    if (component) {
      const resolved = resolveComponent<ScriptComponent>("script", component);
      const module = getScript(this.scripts, resolved.src);
      if (!module) {
        throw new ScriptError(
          { src: resolved.src, entity: def.id, hook: "load", frame: this.frame },
          "this script is not loaded. Hosts pass loaded modules as new World(scene, { scripts }); the CLI and browser runtime do this for you.",
        );
      }
      entity.script = { ...resolved, params: { ...resolved.params }, module, started: false, touching: new Set() };
    }
    return entity;
  }

  private updateScripts(held: ReadonlySet<Action>, pressed: ReadonlySet<Action>): void {
    this.scriptInput = { held: (action) => held.has(action), pressed: (action) => pressed.has(action) };
    // Iterate over a copy: scripts may spawn or destroy entities.
    for (const e of [...this.entities]) {
      if (!e.script || e.removed) continue;
      if (!e.script.started) {
        e.script.started = true;
        this.callHook(e, "start");
      }
      if (!e.removed && !this.won) this.callHook(e, "update");
      if (this.won) return;
    }
  }

  /** Calls `touch` on scripted entities that started overlapping or touching another body this frame. */
  private updateTouches(): void {
    for (const e of [...this.entities]) {
      if (!e.script?.module.touch || !e.body || e.removed) continue;
      const now = new Set<string>();
      for (const other of this.entities) {
        if (other !== e && other.body && overlaps(e, other, TOUCH_MARGIN)) now.add(other.id);
      }
      for (const id of now) {
        const other = this.get(id);
        if (other && !e.script.touching.has(id) && !e.removed && !this.won) this.callHook(e, "touch", this.handle(other));
      }
      e.script.touching = now;
    }
  }

  private callHook(entity: Entity, hook: "start" | "update" | "touch", other?: ScriptEntity): void {
    const script = entity.script!;
    const fn = script.module[hook];
    if (!fn) return;
    const ctx: ScriptContext = { self: this.handle(entity), world: this.api(), input: this.scriptInput, params: script.params, dt: FIXED_DT };
    this.run(entity, hook, () => (fn as (ctx: ScriptContext, other?: ScriptEntity) => void).call(script.module, ctx, other));
  }

  /**
   * Runs an entity's `draw` or `drawUI` hook. Called by the renderer, never by the
   * simulation. `self` and `world` are read-only for the duration.
   */
  callDrawHook(entity: Entity, hook: "draw" | "drawUI", extras: Omit<DrawContext, "self" | "world" | "params">): void {
    const script = entity.script;
    const fn = script?.module[hook];
    if (!script || !fn || entity.removed) return;
    const ctx: DrawContext = { ...extras, self: this.handle(entity), world: this.api(), params: script.params };
    this.drawing = true;
    try {
      this.run(entity, hook, () => fn.call(script.module, ctx));
    } finally {
      this.drawing = false;
    }
  }

  /** True when any live entity's script has the given hook. */
  hasHook(hook: "draw" | "drawUI"): boolean {
    return this.entities.some((e) => !e.removed && typeof e.script?.module[hook] === "function");
  }

  private run(entity: Entity, hook: string, call: () => void): void {
    const script = entity.script!;
    this.current = { entity, hook };
    try {
      call();
    } catch (err) {
      if (err instanceof ScriptError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ScriptError({ src: script.src, entity: entity.id, hook, frame: this.frame }, message, { cause: err });
    } finally {
      this.current = undefined;
    }
  }

  /** Draw hooks only paint, so the browser can't drift from what tests verified. */
  private guard(what: string): void {
    if (this.drawing) {
      throw this.misuse(`${what} changes the game, which a draw hook can't do. Change the game in update or touch, and keep visual memory in ctx.local.`);
    }
  }

  /** An error caused by how a script used the API, reported against the running script. */
  private misuse(message: string): ScriptError {
    const running = this.current;
    return new ScriptError(
      { src: running?.entity.script?.src ?? "?", entity: running?.entity.id ?? "?", hook: running?.hook ?? "?", frame: this.frame },
      message,
    );
  }

  /** A stable script-facing view of an entity. */
  private handle(e: Entity): ScriptEntity {
    let handle = this.handles.get(e);
    if (handle) return handle;
    const world = this;
    handle = {
      get id() {
        return e.id;
      },
      get x() {
        return e.transform.x;
      },
      set x(value: number) {
        world.guard("Setting x");
        e.transform.x = value;
      },
      get y() {
        return e.transform.y;
      },
      set y(value: number) {
        world.guard("Setting y");
        e.transform.y = value;
      },
      get vx() {
        return e.body?.vx ?? 0;
      },
      set vx(value: number) {
        world.guard("Setting vx");
        if (e.body) e.body.vx = value;
      },
      get vy() {
        return e.body?.vy ?? 0;
      },
      set vy(value: number) {
        world.guard("Setting vy");
        if (e.body) e.body.vy = value;
      },
      get grounded() {
        return e.body?.grounded ?? false;
      },
      get width() {
        return e.body?.width ?? e.sprite?.width ?? 0;
      },
      get height() {
        return e.body?.height ?? e.sprite?.height ?? 0;
      },
      get exists() {
        return !e.removed;
      },
      get state() {
        // A frozen copy while drawing, so a draw hook can't write game state by accident.
        return world.drawing ? Object.freeze({ ...e.state }) : e.state;
      },
      has(component: string) {
        return component === "transform" || (component in e && (e as unknown as Record<string, unknown>)[component] !== undefined);
      },
      touches(other: ScriptEntity | string) {
        const target = world.get(typeof other === "string" ? other : other.id);
        return !!target && target !== e && !e.removed && overlaps(e, target, TOUCH_MARGIN);
      },
    };
    this.handles.set(e, handle);
    return handle;
  }

  private resolve(target: ScriptEntity | string): Entity | undefined {
    return this.get(typeof target === "string" ? target : target.id);
  }

  /** The `world` object scripts receive. */
  private api(): ScriptWorld {
    if (this.scriptApi) return this.scriptApi;
    const world = this;
    this.scriptApi = {
      get time() {
        return world.time;
      },
      get frame() {
        return world.frame;
      },
      get width() {
        return world.width;
      },
      get height() {
        return world.height;
      },
      get score() {
        return world.score;
      },
      get deaths() {
        return world.deaths;
      },
      get won() {
        return world.won;
      },
      set score(value: number) {
        world.guard("Setting score");
        world.score = value;
      },
      get: (id) => {
        const e = world.get(id);
        return e ? world.handle(e) : undefined;
      },
      all: (component) =>
        world.entities.filter((e) => !component || world.handle(e).has(component)).map((e) => world.handle(e)),
      player: () => {
        const e = world.entities.find(isPlayer);
        return e ? world.handle(e) : undefined;
      },
      spawn: (def) => {
        world.guard("world.spawn");
        return world.spawn(def);
      },
      destroy: (target) => {
        world.guard("world.destroy");
        const e = world.resolve(target);
        if (e) world.remove(e);
      },
      kill: (target) => {
        world.guard("world.kill");
        const e = world.resolve(target);
        if (!e) return;
        if (isPlayer(e)) world.kill(e, world.current?.entity.id ?? "script");
        else world.remove(e);
      },
      win: () => {
        world.guard("world.win");
        if (world.won) return;
        const by = world.current?.entity;
        world.won = true;
        world.emit({ type: "win", entity: by?.id ?? "script", goal: by?.id ?? "script", x: by?.transform.x ?? 0, y: by?.transform.y ?? 0 });
      },
      emit: (name, data) => {
        world.guard("world.emit");
        if (typeof name !== "string" || name === "") throw world.misuse("world.emit needs a non-empty event name.");
        if ((EVENT_TYPES as readonly string[]).includes(name)) {
          throw world.misuse(`"${name}" is a built-in event and can't be emitted by scripts. Pick another name, e.g. "${name}-custom".`);
        }
        const by = world.current?.entity;
        world.emit({ type: "custom", name, entity: by?.id ?? "script", data, x: by?.transform.x ?? 0, y: by?.transform.y ?? 0 });
      },
      random: () => {
        world.guard("world.random (it advances the game's seed; use ctx.random in draw hooks)");
        return world.random();
      },
    };
    return this.scriptApi;
  }

  private spawn(def: SpawnDef): ScriptEntity {
    if (typeof def !== "object" || def === null || typeof def.components !== "object") {
      throw this.misuse('world.spawn needs { components: { ... } }, e.g. { components: { transform: { x: 0, y: 0 } } }.');
    }
    const id = def.id ?? `${this.current?.entity.id ?? "spawned"}-${++this.spawnCount}`;
    if (this.get(id)) throw this.misuse(`world.spawn: an entity with id "${id}" already exists. Leave id out to get a unique one.`);
    const { diagnostics } = validateScene({ entities: [{ id, components: def.components }] });
    const errors = diagnostics.filter((d) => d.severity === "error" && d.code !== "E_GOAL_UNREACHABLE");
    if (errors.length > 0) {
      const details = errors.map((d) => `${d.path.replace("entities[0]", id)}: ${d.message}${d.fix ? ` Fix: ${d.fix}` : ""}`);
      throw this.misuse(`world.spawn got an invalid entity. ${details.join(" ")}`);
    }
    const entity = this.createEntity({ id, components: def.components });
    this.entities.push(entity);
    return this.handle(entity);
  }

  /** mulberry32, seeded by world.seed. */
  private random(): number {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ------------------------------------------------------------ built-ins

  /** Entities the player controls: platformers and topdown movers. */
  private players(): Entity[] {
    return this.entities.filter(isPlayer);
  }

  private updateTopdown(held: ReadonlySet<Action>): void {
    for (const e of this.entities) {
      const t = e.topdown;
      const b = e.body;
      if (!t || !b) continue;
      let dx = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
      let dy = (held.has("down") ? 1 : 0) - (held.has("up") ? 1 : 0);
      if (t.directions === "x") dy = 0;
      if (t.directions === "y") dx = 0;
      if (t.directions === "4" && dx !== 0) dy = 0;
      // Diagonals move at the same speed as straight lines.
      const length = Math.hypot(dx, dy) || 1;
      b.vx = (dx / length) * t.speed;
      b.vy = (dy / length) * t.speed;
    }
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
        b.standingOn = undefined;
        p.bufferTimer = 0;
        p.coyoteTimer = 0;
        p.jumping = true;
        this.emit({ type: "jump", entity: e.id, ...feet(e) });
      } else if (p.jumping && p.variableJump && !held.has("jump") && b.vy < -p.jumpSpeed * JUMP_CUT) {
        // Only the player's own jumps are cut short; launches from pads, stomps or scripts are not.
        b.vy = -p.jumpSpeed * JUMP_CUT;
      }
      if (b.vy >= 0) p.jumping = false;

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
    const walls = this.entities.filter((e) => e.body?.type === "static" && !e.body.sensor);
    for (const e of this.entities) {
      const b = e.body;
      if (!b || b.type !== "kinematic") continue;
      const { x, y } = e.transform;
      e.transform.x += b.vx * FIXED_DT;
      // A player-steered kinematic body (a paddle) stops at walls; scripted movers pass through.
      if (e.topdown) for (const wall of walls) if (overlaps(e, wall)) e.transform.x = wall.transform.x + (Math.sign(e.transform.x - wall.transform.x) * (wall.body!.width + b.width)) / 2;
      e.transform.y += b.vy * FIXED_DT;
      if (e.topdown) for (const wall of walls) if (overlaps(e, wall)) e.transform.y = wall.transform.y + (Math.sign(e.transform.y - wall.transform.y) * (wall.body!.height + b.height)) / 2;
      if (e.patrol) clampToPatrol(e, e.patrol);
      if (e.topdown?.clampToWorld) this.clampToWorld(e);
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

      // Top-down movers ignore gravity; everything else falls.
      if (!e.topdown) b.vy = Math.min(b.vy + this.gravity * b.gravityScale * FIXED_DT, MAX_FALL_SPEED);
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
        b.vx = this.rebound(e, solid, b.vx);
      }

      e.transform.y += b.vy * FIXED_DT;
      for (const solid of solids) {
        if (!overlaps(e, solid)) continue;
        const half = (solid.body!.height + b.height) / 2;
        const falling = b.vy > 0;
        if (b.vy > 0) e.transform.y = solid.transform.y - half;
        else if (b.vy < 0) e.transform.y = solid.transform.y + half;
        b.vy = this.rebound(e, solid, b.vy);
        // A body that stopped on top of something is standing on it; one that bounced off is airborne.
        if (falling && b.vy === 0) {
          b.grounded = true;
          b.standingOn = solid;
        }
      }

      if (e.topdown?.clampToWorld) this.clampToWorld(e);
      if (b.grounded && !wasGrounded) this.emit({ type: "land", entity: e.id, ...feet(e) });
    }
  }

  /**
   * The velocity along one axis after hitting `solid`: 0, or reversed and scaled by `bounce`.
   * Slow impacts stop instead, so resting bodies don't jitter.
   */
  private rebound(e: Entity, solid: Entity, velocity: number): number {
    const bounce = e.body!.bounce;
    if (bounce <= 0 || Math.abs(velocity) * bounce < MIN_BOUNCE_SPEED) return 0;
    this.emit({ type: "bounce", entity: e.id, other: solid.id, ...e.transform });
    return -velocity * bounce;
  }

  private clampToWorld(e: Entity): void {
    const halfWidth = (e.body?.width ?? 0) / 2;
    const halfHeight = (e.body?.height ?? 0) / 2;
    e.transform.x = Math.min(this.width - halfWidth, Math.max(halfWidth, e.transform.x));
    e.transform.y = Math.min(this.height - halfHeight, Math.max(halfHeight, e.transform.y));
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
        if (hazard.hazard!.stompable && player.platformer && isStomp(player, hazard)) {
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
    this.deaths++;
    this.emit({ type: "die", entity: player.id, cause, ...player.transform });
    player.transform.x = player.spawn?.x ?? player.transform.x;
    player.transform.y = player.spawn?.y ?? player.transform.y;
    b.vx = 0;
    b.vy = 0;
    b.grounded = false;
    b.standingOn = undefined;
    const p = player.platformer;
    if (p) {
      p.coyoteTimer = 0;
      p.bufferTimer = 0;
      p.jumping = false;
    }
  }
}

function createEntity(def: EntityDef): Entity {
  const c = def.components;
  const transform = c.transform ? resolveComponent<Transform>("transform", c.transform) : { x: 0, y: 0 };
  const entity: Entity = { id: def.id, state: {}, transform };
  if (c.body) entity.body = { ...resolveComponent<Body>("body", c.body), grounded: false };
  if (c.sprite) entity.sprite = resolveComponent<Sprite>("sprite", c.sprite);
  if (c.platformer) {
    entity.platformer = {
      ...resolveComponent<Platformer>("platformer", c.platformer),
      coyoteTimer: 0,
      bufferTimer: 0,
      jumping: false,
    };
  }
  if (c.topdown) entity.topdown = resolveComponent<Topdown>("topdown", c.topdown);
  if (entity.platformer || entity.topdown) entity.spawn = { x: transform.x, y: transform.y };
  if (c.collectible) entity.collectible = resolveComponent<Collectible>("collectible", c.collectible);
  if (c.patrol) entity.patrol = { ...resolveComponent<Patrol>("patrol", c.patrol), originX: transform.x, originY: transform.y };
  if (c.hazard) entity.hazard = resolveComponent<Hazard>("hazard", c.hazard);
  if (c.goal) entity.goal = resolveComponent<Goal>("goal", c.goal);
  if (c.emitter) entity.emitter = resolveComponent<Emitter>("emitter", c.emitter);
  if (c.camera) entity.camera = resolveComponent<Camera>("camera", c.camera);
  return entity;
}

function isPlayer(e: Entity): boolean {
  return !!(e.platformer || e.topdown) && !!e.body;
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
