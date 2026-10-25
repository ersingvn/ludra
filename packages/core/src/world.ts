import {
  resolveComponent,
  type Body,
  type Camera,
  type Camera3D,
  type Character,
  type Light,
  type Mesh,
  type Collectible,
  type Emitter,
  type Goal,
  type Hazard,
  type Joint,
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
  type SoundContext,
  type RenderContext,
  type Script,
  type ScriptContext,
  type ScriptEntity,
  type ScriptInput,
  type ScriptModules,
  type ScriptWorld,
  type SpawnDef,
} from "./script.ts";
import { atan2 } from "./dmath.ts";
import { createPhysics, physicsEngineName } from "./engines.ts";
import type { CameraZone } from "./camera.ts";
import { advanceTween, createTween, startTween, type Tween, type TweenState } from "./tween.ts";
import { at, feet, type PhysicsEngine, type PhysicsHost } from "./physics.ts";
import { FIXED_DT } from "./time.ts";
import { EVENT_TYPES, type Action, type Diagnostic, type EntityDef, type SceneDef } from "./types.ts";
import { mergeComponents, validateScene } from "./validate.ts";

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
  originZ: number;
}

export interface CharacterState extends Character {
  coyoteTimer: number;
  jumping: boolean;
  bufferTimer: number;
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
  /** The 3D player. */
  character?: CharacterState;
  topdown?: Topdown;
  /** Where a player respawns after dying. */
  spawn?: { x: number; y: number; z: number };
  collectible?: Collectible;
  patrol?: PatrolState;
  hazard?: Hazard;
  goal?: Goal;
  checkpoint?: Record<string, never>;
  /** Every joint this entity's `joint` component declares (one object or a list). */
  joints?: Joint[];
  emitter?: Emitter;
  camera?: Camera;
  cameraZone?: CameraZone;
  /** 3D presentation, read by the renderer (@ludra/three). */
  mesh?: Mesh;
  light?: Light;
  camera3d?: Camera3D;
  /** Tweens declared on the entity or started by its scripts. */
  tweens?: TweenState[];
}

/** `x`/`y` is where it happened, e.g. the coin's position for "collect" or the feet for "land". */
/** `z` is there in 3D worlds only. */
export type GameEvent = { frame: number; time: number; x: number; y: number; z?: number } & (
  | { type: "jump"; entity: string }
  | { type: "land"; entity: string }
  | { type: "collect"; entity: string; item: string; score: number }
  | { type: "die"; entity: string; cause: string }
  | { type: "stomp"; entity: string; enemy: string; score: number }
  | { type: "win"; entity: string; goal: string }
  | { type: "bounce"; entity: string; other: string }
  | { type: "checkpoint"; entity: string; checkpoint: string }
  | { type: "gameover"; entity: string; cause: string }
  | { type: "goto"; entity: string; scene: string }
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
  /** Degrees, clockwise. Present only when the entity is rotated (rapier physics). 3D: around z. */
  rotation?: number;
  /** 3D only: depth position and velocity, always present in a 3D world. */
  z?: number;
  vz?: number;
  /** 3D only: degrees around x and y, present when not 0. */
  rotationX?: number;
  rotationY?: number;
  /** Present when a script stored data on the entity. */
  state?: Record<string, unknown>;
}

export interface WorldOptions {
  /** Loaded script modules, keyed by the `src` path used in the scene. */
  scripts?: ScriptModules;
  /** The physics engine that moves bodies. Defaults to the one the scene names (`world.physics`), arcade if none. */
  physics?: PhysicsEngine;
  /** Values carried over from the previous scene, so a run keeps its score and lives. */
  carry?: { score?: number; deaths?: number; lives?: number };
}

export interface WorldSnapshot {
  frame: number;
  time: number;
  score: number;
  deaths: number;
  won: boolean;
  lost: boolean;
  /** Lives left; undefined when the scene has unlimited retries. */
  lives?: number;
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
/** 3D worlds are in metres: Earth's gravity, in m/s². */
const DEFAULT_GRAVITY_3D = 9.81;
/** When jump is released early, upward speed is capped to this fraction of jumpSpeed. */
const JUMP_CUT = 0.45;
/** Upward speed after stomping an enemy, as a fraction of jumpSpeed. */
const STOMP_BOUNCE = 0.6;
/** How far a player's feet may sink into an enemy and still count as a stomp. */
const STOMP_TOLERANCE = 8;
const STOMP_TOLERANCE_3D = 0.15;
/** 3D: players falling below this height die, unless the scene sets world.fallLimit. */
const DEFAULT_FALL_LIMIT = -50;
/** A platformer this far below the bottom of the world has fallen out of it. */
const FALL_MARGIN = 100;
/** Bodies this close count as touching for `touch` hooks, so solids (doors, walls) can be touched too. */
const TOUCH_MARGIN = 1;
const EPSILON = 1e-4;

/**
 * The simulation. It advances only through `step`, one fixed frame at a time,
 * and contains no randomness or wall-clock time, so the same scene and inputs
 * always produce the same result.
 */
export class World {
  /** 2, or 3 for a 3D world (metres, +y up, Rapier 3D). */
  readonly dimensions: 2 | 3;
  /** 3D: players falling below this height die. */
  readonly fallLimit: number;
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
  /** Set when the game is over: out of lives, or a script called world.lose(). */
  lost = false;
  /** Lives left, or undefined for unlimited retries. */
  lives: number | undefined;
  /** The scene to play next (a won goal's `next`, or world.goto). Hosts that can load scenes move on to it. */
  exit: string | undefined;
  private readonly prefabs: Record<string, { components: Record<string, Record<string, unknown>> }>;
  private readonly reached = new Set<string>();
  /** Moves bodies; gameplay below only talks to it through velocities, grounded and overlaps. */
  readonly physics: PhysicsEngine;
  private readonly physicsHost: PhysicsHost;
  private previousInput: ReadonlySet<Action> = new Set();
  /** World events the tweens have already looked at, to start those waiting for one. */
  private tweenEvents = 0;
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
    this.dimensions = scene.world?.dimensions ?? 2;
    this.fallLimit = scene.world?.fallLimit ?? DEFAULT_FALL_LIMIT;
    this.width = scene.world?.width ?? 960;
    this.height = scene.world?.height ?? 540;
    this.gravity = scene.world?.gravity ?? (this.dimensions === 3 ? DEFAULT_GRAVITY_3D : DEFAULT_GRAVITY);
    this.background = scene.world?.background ?? "#1d2333";
    this.seed = scene.world?.seed ?? 1;
    this.scripts = options.scripts;
    this.prefabs = scene.prefabs ?? {};
    this.score = options.carry?.score ?? 0;
    this.deaths = options.carry?.deaths ?? 0;
    this.lives = options.carry?.lives ?? scene.world?.lives;
    this.physics = options.physics ?? createPhysics(physicsEngineName(scene), { width: this.width, height: this.height, gravity: this.gravity });
    const world = this;
    this.physicsHost = {
      get entities() {
        return world.entities;
      },
      width: this.width,
      height: this.height,
      gravity: this.gravity,
      emit: (event) => this.emit(event),
    };
    this.entities = [];
    for (const def of scene.entities) this.entities.push(this.createEntity(def));
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

  /** True once nothing more happens in this scene: won, lost, or moving on to another scene. */
  get over(): boolean {
    return this.won || this.lost || this.exit !== undefined;
  }

  get(id: string): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  /** Advances one frame with the given actions held down. */
  step(input: ReadonlySet<Action>): void {
    const pressed = new Set([...input].filter((action) => !this.previousInput.has(action)));
    this.previousInput = new Set(input);
    this.frame++;
    if (this.over) return;

    this.updatePlatformers(input, pressed);
    this.updateCharacters(input, pressed);
    this.updateTopdown(input);
    this.updateScripts(input, pressed);
    if (this.over) return;
    this.updatePatrols();
    this.updateTweens();
    this.physics.step(this.physicsHost);
    this.updateTouches();
    if (this.over) return;
    this.updateCollectibles();
    this.updateCheckpoints();
    this.updateHazards();
    if (this.over) return;
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
      if (e.transform.rotation !== 0) entities[e.id]!.rotation = e.transform.rotation;
      if (this.dimensions === 3) {
        entities[e.id]!.z = e.transform.z;
        entities[e.id]!.vz = e.body?.vz ?? 0;
        if (e.transform.rotationX !== 0) entities[e.id]!.rotationX = e.transform.rotationX;
        if (e.transform.rotationY !== 0) entities[e.id]!.rotationY = e.transform.rotationY;
      }
      // A JSON copy, so later frames can't change an earlier snapshot.
      if (Object.keys(e.state).length > 0) entities[e.id]!.state = JSON.parse(JSON.stringify(e.state));
    }
    return { frame: this.frame, time: this.time, score: this.score, deaths: this.deaths, won: this.won, lost: this.lost, lives: this.lives, entities };
  }

  private emit(event: EventPayload): void {
    this.events.push({ ...event, frame: this.frame, time: this.time } as GameEvent);
  }

  private remove(entity: Entity): void {
    const index = this.entities.indexOf(entity);
    if (index >= 0) this.entities.splice(index, 1);
    entity.removed = true;
    this.physics.remove(entity, this.physicsHost);
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
    this.physics.add(entity, this.physicsHost);
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
      if (!e.removed && !this.over) this.callHook(e, "update");
      if (this.over) return;
    }
  }

  /** Calls `touch` on scripted entities that started overlapping or touching another body this frame. */
  private updateTouches(): void {
    for (const e of [...this.entities]) {
      if (!e.script?.module.touch || !e.body || e.removed) continue;
      const now = new Set<string>();
      for (const other of this.entities) {
        if (other !== e && other.body && this.physics.overlaps(e, other, TOUCH_MARGIN)) now.add(other.id);
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

  /**
   * Runs an entity's `sound` hook. Called by the browser, never by the simulation.
   * Like draw hooks, `self` and `world` are read-only for the duration.
   */
  callSoundHook(entity: Entity, extras: Omit<SoundContext, "self" | "world" | "params">): void {
    const script = entity.script;
    const fn = script?.module.sound;
    if (!script || !fn || entity.removed) return;
    const ctx: SoundContext = { ...extras, self: this.handle(entity), world: this.api(), params: script.params };
    this.drawing = true;
    try {
      this.run(entity, "sound", () => fn.call(script.module, ctx));
    } finally {
      this.drawing = false;
    }
  }

  /**
   * Runs an entity's `render` hook (3D). Called by the 3D renderer, never by the simulation.
   * Like draw hooks, `self` and `world` are read-only for the duration.
   */
  callRenderHook(entity: Entity, extras: Omit<RenderContext, "self" | "world" | "params">): void {
    const script = entity.script;
    const fn = script?.module.render;
    if (!script || !fn || entity.removed) return;
    const ctx: RenderContext = { ...extras, self: this.handle(entity), world: this.api(), params: script.params };
    this.drawing = true;
    try {
      this.run(entity, "render", () => fn.call(script.module, ctx));
    } finally {
      this.drawing = false;
    }
  }

  /** True when any live entity's script has the given hook. */
  hasHook(hook: "draw" | "drawUI" | "sound" | "render"): boolean {
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
      throw this.misuse(`${what} changes the game, which a ${this.current?.hook === "sound" || this.current?.hook === "render" ? this.current.hook : "draw"} hook can't do. Change the game in update or touch, and keep presentation memory in ctx.local.`);
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
      get z() {
        return e.transform.z;
      },
      set z(value: number) {
        world.guard("Setting z");
        e.transform.z = value;
      },
      get vz() {
        return e.body?.vz ?? 0;
      },
      set vz(value: number) {
        world.guard("Setting vz");
        if (e.body) e.body.vz = value;
      },
      get grounded() {
        return e.body?.grounded ?? false;
      },
      get rotation() {
        return e.transform.rotation;
      },
      set rotation(value: number) {
        world.guard("Setting rotation");
        e.transform.rotation = value;
      },
      get rotationX() {
        return e.transform.rotationX;
      },
      set rotationX(value: number) {
        world.guard("Setting rotationX");
        e.transform.rotationX = value;
      },
      get rotationY() {
        return e.transform.rotationY;
      },
      set rotationY(value: number) {
        world.guard("Setting rotationY");
        e.transform.rotationY = value;
      },
      get spin() {
        return e.body && world.physics.spin ? world.physics.spin(e) : { x: 0, y: 0, z: e.body ? world.physics.angularVelocity(e) : 0 };
      },
      set spin(value: { x: number; y: number; z: number }) {
        world.guard("Setting spin");
        if (!e.body) return;
        if (world.physics.setSpin) world.physics.setSpin(e, { x: value.x ?? 0, y: value.y ?? 0, z: value.z ?? 0 });
        else world.physics.setAngularVelocity(e, value.z ?? 0);
      },
      get angularVelocity() {
        return e.body ? world.physics.angularVelocity(e) : 0;
      },
      set angularVelocity(value: number) {
        world.guard("Setting angularVelocity");
        if (e.body) world.physics.setAngularVelocity(e, value);
      },
      get mass() {
        return e.body ? world.physics.mass(e) : 0;
      },
      applyImpulse(x: number | { x?: number; y?: number; z?: number }, y?: number | { x: number; y: number; z?: number }, at?: { x: number; y: number; z?: number }) {
        world.guard("applyImpulse");
        // 3D style: a vector, then optionally where it strikes.
        const v = typeof x === "object" ? { x: x.x ?? 0, y: x.y ?? 0, z: x.z ?? 0 } : { x, y: y as number, z: 0 };
        const point = typeof x === "object" ? (y as { x: number; y: number; z?: number } | undefined) : at;
        if (e.body) world.physics.applyImpulse(e, v.x, v.y, point, v.z);
      },
      tween(def: Parameters<ScriptEntity["tween"]>[0]) {
        world.guard("tween");
        const { diagnostics } = validateScene({ entities: [{ id: e.id, components: { transform: { x: 0, y: 0 }, ...(e.sprite ? { sprite: {} } : {}), tween: def as Record<string, unknown> } }] });
        const problem = diagnostics.find((d) => d.severity === "error");
        if (problem) throw world.misuse(`self.tween: ${problem.message}${problem.fix ? ` ${problem.fix}` : ""}`);
        const spec = resolveComponent<Tween>("tween", { ...def, on: "" });
        // A new tween of the same property replaces the old one.
        e.tweens = [...(e.tweens ?? []).filter((t) => t.property !== spec.property), createTween(spec, readTweened(e, spec.property))];
      },
      applyForce(x: number | { x?: number; y?: number; z?: number }, y?: number | { x: number; y: number; z?: number }, at?: { x: number; y: number; z?: number }) {
        world.guard("applyForce");
        const v = typeof x === "object" ? { x: x.x ?? 0, y: x.y ?? 0, z: x.z ?? 0 } : { x, y: y as number, z: 0 };
        const point = typeof x === "object" ? (y as { x: number; y: number; z?: number } | undefined) : at;
        // A force acts over the frame: the impulse it delivers in one step.
        if (e.body) world.physics.applyImpulse(e, v.x * FIXED_DT, v.y * FIXED_DT, point, v.z * FIXED_DT);
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
        return !!target && target !== e && !e.removed && world.physics.overlaps(e, target, TOUCH_MARGIN);
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
      get lost() {
        return world.lost;
      },
      get exit() {
        return world.exit;
      },
      get lives() {
        return world.lives;
      },
      set lives(value: number | undefined) {
        world.guard("Setting lives");
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) throw world.misuse("world.lives must be a number.");
        world.lives = value;
        if (value !== undefined && value <= 0) world.gameOver(world.current?.entity.id ?? "script", "script");
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
      lose: () => {
        world.guard("world.lose");
        world.gameOver(world.current?.entity.id ?? "script", "script");
      },
      goto: (scene) => {
        world.guard("world.goto");
        if (typeof scene !== "string" || scene === "") throw world.misuse('world.goto needs a scene path, e.g. "scenes/level-1.scene.json".');
        if (world.exit !== undefined) return;
        world.exit = scene;
        const by = world.current?.entity;
        world.emit({ type: "goto", entity: by?.id ?? "script", scene, x: by?.transform.x ?? 0, y: by?.transform.y ?? 0 });
      },
      emit: (name, data) => {
        world.guard("world.emit");
        if (typeof name !== "string" || name === "") throw world.misuse("world.emit needs a non-empty event name.");
        if ((EVENT_TYPES as readonly string[]).includes(name)) {
          throw world.misuse(`"${name}" is a built-in event and can't be emitted by scripts. Pick another name, e.g. "${name}-custom".`);
        }
        const by = world.current?.entity;
        world.emit({ type: "custom", name, entity: by?.id ?? "script", data, x: by?.transform.x ?? 0, y: by?.transform.y ?? 0, ...(world.dimensions === 3 ? { z: by?.transform.z ?? 0 } : {}) });
      },
      raycast: (from, to, options = {}) => {
        const ignore = [options.ignore ?? []].flat().map((target) => world.resolve(target)).filter((e): e is Entity => !!e);
        const hit = world.physics.raycast(world.physicsHost, from, to, { ignore, sensors: options.sensors });
        return hit ? { ...hit, entity: world.handle(hit.entity) } : undefined;
      },
      physics: {
        get name() {
          return world.physics.name;
        },
        get raw() {
          world.guard("world.physics.raw");
          return world.physics.raw?.((target) => (target && (typeof target === "string" || typeof target === "object") ? world.resolve(target as ScriptEntity | string) : undefined));
        },
      },
      random: () => {
        world.guard("world.random (it advances the game's seed; use ctx.random in draw hooks)");
        return world.random();
      },
    };
    return this.scriptApi;
  }

  private spawn(def: SpawnDef): ScriptEntity {
    if (typeof def !== "object" || def === null || (def.prefab === undefined && typeof def.components !== "object")) {
      throw this.misuse('world.spawn needs { components: { ... } } or { prefab: "name" }, e.g. { prefab: "bullet", components: { transform: { x: 0, y: 0 } } }.');
    }
    let components = def.components ?? {};
    if (def.prefab !== undefined) {
      const prefab = this.prefabs[def.prefab];
      if (!prefab) {
        const names = Object.keys(this.prefabs);
        throw this.misuse(`world.spawn: prefab "${def.prefab}" does not exist.${names.length > 0 ? ` Prefabs: ${names.join(", ")}.` : " Create prefabs/<name>.prefab.json."}`);
      }
      components = mergeComponents(prefab.components, components);
    }
    const id = def.id ?? `${this.current?.entity.id ?? "spawned"}-${++this.spawnCount}`;
    if (this.get(id)) throw this.misuse(`world.spawn: an entity with id "${id}" already exists. Leave id out to get a unique one.`);
    const { diagnostics } = validateScene({ entities: [{ id, components }] });
    const errors = diagnostics.filter((d) => d.severity === "error" && d.code !== "E_GOAL_UNREACHABLE");
    if (errors.length > 0) {
      const details = errors.map((d) => `${d.path.replace("entities[0]", id)}: ${d.message}${d.fix ? ` Fix: ${d.fix}` : ""}`);
      throw this.misuse(`world.spawn got an invalid entity. ${details.join(" ")}`);
    }
    const entity = this.createEntity({ id, components });
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

  /** Where an entity is, for events. 3D adds z. */
  private at(e: Entity): { x: number; y: number; z?: number } {
    return this.dimensions === 3 ? { x: e.transform.x, y: e.transform.y, z: e.transform.z } : at(e);
  }

  /** Where an entity stands: the bottom of its body (below its center in 3D, where +y is up). */
  private feet(e: Entity): { x: number; y: number; z?: number } {
    if (this.dimensions !== 3) return feet(e);
    return { x: e.transform.x, y: e.transform.y - (e.body?.height ?? 0) / 2, z: e.transform.z };
  }

  /**
   * 3D players walk on the ground plane: left/right along x, up/down along z (up is away
   * from the viewer, -z), and jump straight up (+y).
   */
  private updateCharacters(held: ReadonlySet<Action>, pressed: ReadonlySet<Action>): void {
    for (const e of this.entities) {
      const c = e.character;
      const b = e.body;
      if (!c || !b) continue;
      const dx = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
      const dz = (held.has("down") ? 1 : 0) - (held.has("up") ? 1 : 0);
      // Diagonals walk at the same speed as straight lines.
      const length = Math.hypot(dx, dz) || 1;
      b.vx = (dx / length) * c.speed;
      b.vz = (dz / length) * c.speed;
      // Facing -z is a turn of 0; walking right (+x) is -90 (turning right is clockwise from above).
      // dmath: the same bits on every machine, so the facing angle is part of the golden hash safely.
      if (c.faceMovement && (dx !== 0 || dz !== 0)) e.transform.rotationY = (atan2(-dx, -dz) * 180) / Math.PI;

      if (b.grounded) c.coyoteTimer = c.coyoteTime + EPSILON;
      if (pressed.has("jump")) c.bufferTimer = c.jumpBuffer + EPSILON;
      if (c.bufferTimer > 0 && c.coyoteTimer > 0) {
        b.vy = c.jumpSpeed;
        b.grounded = false;
        b.standingOn = undefined;
        c.bufferTimer = 0;
        c.coyoteTimer = 0;
        c.jumping = true;
        this.emit({ type: "jump", entity: e.id, ...this.feet(e) });
      } else if (c.jumping && c.variableJump && !held.has("jump") && b.vy > c.jumpSpeed * JUMP_CUT) {
        b.vy = c.jumpSpeed * JUMP_CUT;
      }
      if (b.vy <= 0) c.jumping = false;
      c.coyoteTimer = Math.max(0, c.coyoteTimer - FIXED_DT);
      c.bufferTimer = Math.max(0, c.bufferTimer - FIXED_DT);
    }
  }

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
        this.emit({ type: "jump", entity: e.id, ...this.feet(e) });
      } else if (p.jumping && p.variableJump && !held.has("jump") && b.vy < -p.jumpSpeed * JUMP_CUT) {
        // Only the player's own jumps are cut short; launches from pads, stomps or scripts are not.
        b.vy = -p.jumpSpeed * JUMP_CUT;
      }
      if (b.vy >= 0) p.jumping = false;

      p.coyoteTimer = Math.max(0, p.coyoteTimer - FIXED_DT);
      p.bufferTimer = Math.max(0, p.bufferTimer - FIXED_DT);
    }
  }

  /**
   * Eases tweened values. Moving bodies get the velocity that lands them on this step's
   * value, so the physics engine moves them (and carries riders); everything else is set.
   */
  private updateTweens(): void {
    // Tweens waiting for an event start when it fires.
    const fresh = this.events.slice(this.tweenEvents);
    this.tweenEvents = this.events.length;
    const fired = new Set(fresh.map((e) => (e.type === "custom" ? e.name : e.type)));
    for (const e of this.entities) {
      if (!e.tweens) continue;
      for (const tween of e.tweens) {
        if (!tween.active && !tween.done && tween.on !== "" && fired.has(tween.on)) startTween(tween, readTweened(e, tween.property));
        const settling = tween.done && tween.settle;
        const value = advanceTween(tween, FIXED_DT);
        const b = e.body;
        const moved = (tween.property === "x" || tween.property === "y" || tween.property === "z") && b && b.type !== "static";
        if (value === undefined) {
          // A body that just arrived stops there.
          if (settling && moved) {
            if (tween.property === "x") b.vx = 0;
            else if (tween.property === "z") b.vz = 0;
            else b.vy = 0;
          }
          tween.settle = false;
          continue;
        }
        tween.settle = tween.done;
        if (moved) {
          if (tween.property === "x") b.vx = (value - e.transform.x) / FIXED_DT;
          else if (tween.property === "z") b.vz = (value - e.transform.z) / FIXED_DT;
          else b.vy = (value - e.transform.y) / FIXED_DT;
        } else writeTweened(e, tween.property, value);
      }
    }
  }

  /** Points each patrolling body toward the end of its path it is heading for. */
  private updatePatrols(): void {
    for (const e of this.entities) {
      const patrol = e.patrol;
      const b = e.body;
      if (!patrol || !b) continue;
      const axis = patrol.axis;
      const offset = axis === "x" ? e.transform.x - patrol.originX : axis === "z" ? e.transform.z - patrol.originZ : e.transform.y - patrol.originY;
      const current = axis === "x" ? b.vx : axis === "z" ? b.vz : b.vy;
      let direction = current < 0 ? -1 : 1;
      if (offset >= patrol.distance) direction = -1;
      else if (offset <= 0) direction = 1;
      b.vx = axis === "x" ? direction * patrol.speed : 0;
      b.vy = axis === "y" ? direction * patrol.speed : 0;
      b.vz = axis === "z" ? direction * patrol.speed : 0;
    }
  }

  private updateCollectibles(): void {
    const players = this.players();
    for (const item of this.entities.filter((e) => e.collectible && e.body)) {
      const collector = players.find((p) => this.physics.overlaps(p, item));
      if (!collector) continue;
      this.remove(item);
      this.score += item.collectible!.score;
      this.emit({ type: "collect", entity: collector.id, item: item.id, score: item.collectible!.score, ...this.at(item) });
    }
  }

  private updateHazards(): void {
    for (const player of this.players()) {
      const b = player.body!;
      const fell = this.dimensions === 3 ? player.transform.y + b.height / 2 < this.fallLimit : player.transform.y - b.height / 2 > this.height + FALL_MARGIN;
      if (fell) {
        this.kill(player, "fall");
        continue;
      }
      for (const hazard of this.entities.filter((e) => e.hazard && e.body)) {
        if (!this.physics.overlaps(player, hazard)) continue;
        const jumper = player.platformer ?? player.character;
        if (hazard.hazard!.stompable && jumper && isStomp(player, hazard, this.dimensions === 3)) {
          this.remove(hazard);
          // A bounce off the enemy: up is -y in 2D, +y in 3D.
          b.vy = (this.dimensions === 3 ? 1 : -1) * jumper.jumpSpeed * STOMP_BOUNCE;
          this.score += hazard.hazard!.score;
          this.emit({ type: "stomp", entity: player.id, enemy: hazard.id, score: hazard.hazard!.score, ...this.at(hazard) });
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
      const player = this.players().find((p) => this.physics.overlaps(p, goal));
      if (!player) continue;
      this.won = true;
      if (goal.goal!.next) this.exit = goal.goal!.next;
      this.emit({ type: "win", entity: player.id, goal: goal.id, ...this.at(goal) });
      return;
    }
  }

  /** A touched checkpoint becomes the player's respawn point, standing on the checkpoint's bottom edge. */
  private updateCheckpoints(): void {
    for (const checkpoint of this.entities.filter((e) => e.checkpoint && e.body)) {
      for (const player of this.players()) {
        const key = `${player.id}>${checkpoint.id}`;
        if (this.reached.has(key) || !this.physics.overlaps(player, checkpoint)) continue;
        this.reached.add(key);
        const c = checkpoint.transform;
        if (this.dimensions === 3) {
          // Standing on the checkpoint's bottom, +y up.
          const bottom = c.y - checkpoint.body!.height / 2;
          player.spawn = { x: c.x, y: player.character ? bottom + player.body!.height / 2 : c.y, z: c.z };
        } else {
          const bottom = c.y + checkpoint.body!.height / 2;
          player.spawn = { x: c.x, y: player.platformer ? bottom - player.body!.height / 2 : c.y, z: 0 };
        }
        this.emit({ type: "checkpoint", entity: player.id, checkpoint: checkpoint.id, ...this.at(checkpoint) });
      }
    }
  }

  private gameOver(entity: string, cause: string): void {
    if (this.lost) return;
    this.lost = true;
    const e = this.get(entity);
    this.emit({ type: "gameover", entity, cause, x: e?.transform.x ?? 0, y: e?.transform.y ?? 0 });
  }

  /** Sends a player back to where it started. Collected items stay collected. */
  private kill(player: Entity, cause: string): void {
    const b = player.body!;
    this.deaths++;
    this.emit({ type: "die", entity: player.id, cause, ...this.at(player) });
    if (this.lives !== undefined) {
      this.lives--;
      // Out of lives: the player stays where it fell and the game is over.
      if (this.lives <= 0) return this.gameOver(player.id, cause);
    }
    player.transform.x = player.spawn?.x ?? player.transform.x;
    player.transform.y = player.spawn?.y ?? player.transform.y;
    player.transform.z = player.spawn?.z ?? player.transform.z;
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    b.grounded = false;
    b.standingOn = undefined;
    for (const p of [player.platformer, player.character]) {
      if (!p) continue;
      p.coyoteTimer = 0;
      p.bufferTimer = 0;
      p.jumping = false;
    }
  }
}

function createEntity(def: EntityDef): Entity {
  const c = def.components;
  const transform = resolveTransform(c.transform);
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
  if (c.character) entity.character = { ...resolveComponent<Character>("character", c.character), coyoteTimer: 0, bufferTimer: 0, jumping: false };
  if (entity.platformer || entity.topdown || entity.character) entity.spawn = { x: transform.x, y: transform.y, z: transform.z };
  if (c.collectible) entity.collectible = resolveComponent<Collectible>("collectible", c.collectible);
  if (c.patrol) entity.patrol = { ...resolveComponent<Patrol>("patrol", c.patrol), originX: transform.x, originY: transform.y, originZ: transform.z };
  if (c.hazard) entity.hazard = resolveComponent<Hazard>("hazard", c.hazard);
  if (c.goal) entity.goal = resolveComponent<Goal>("goal", c.goal);
  if (c.checkpoint) entity.checkpoint = {};
  if (c.joint) entity.joints = (Array.isArray(c.joint) ? c.joint : [c.joint]).map((j) => resolveComponent<Joint>("joint", j as Record<string, unknown>));
  if (c.emitter) entity.emitter = resolveComponent<Emitter>("emitter", c.emitter);
  if (c.camera) entity.camera = resolveComponent<Camera>("camera", c.camera);
  if (c.cameraZone) entity.cameraZone = resolveComponent<CameraZone>("cameraZone", c.cameraZone);
  if (c.mesh) entity.mesh = resolveComponent<Mesh>("mesh", c.mesh);
  if (c.light) entity.light = resolveComponent<Light>("light", c.light);
  if (c.camera3d) entity.camera3d = resolveComponent<Camera3D>("camera3d", c.camera3d);
  if (c.tween) {
    entity.tweens = (Array.isArray(c.tween) ? c.tween : [c.tween]).map((t) => {
      const spec = resolveComponent<Tween>("tween", t as Record<string, unknown>);
      return createTween(spec, readTweened(entity, spec.property));
    });
  }
  return entity;
}

/** A transform from JSON: rotation is degrees in 2D, or { x, y, z } degrees in 3D. */
function resolveTransform(raw: Record<string, unknown> | undefined): Transform {
  if (!raw) return { x: 0, y: 0, z: 0, rotation: 0, rotationX: 0, rotationY: 0 };
  const { rotation, ...rest } = raw;
  const t = resolveComponent<Omit<Transform, "rotationX" | "rotationY"> & { rotation: number }>("transform", rest);
  const r = typeof rotation === "object" && rotation !== null ? (rotation as { x?: number; y?: number; z?: number }) : undefined;
  return {
    x: t.x,
    y: t.y,
    z: t.z,
    rotation: r ? (r.z ?? 0) : typeof rotation === "number" ? rotation : 0,
    rotationX: r?.x ?? 0,
    rotationY: r?.y ?? 0,
  };
}

function readTweened(e: Entity, property: Tween["property"]): number {
  if (property !== "scale" && property !== "opacity") return e.transform[property];
  return e.sprite?.[property] ?? 1;
}

function writeTweened(e: Entity, property: Tween["property"], value: number): void {
  if (property !== "scale" && property !== "opacity") e.transform[property] = value;
  else if (e.sprite) e.sprite[property] = Math.max(0, value);
}

function isPlayer(e: Entity): boolean {
  return !!(e.platformer || e.topdown || e.character) && !!e.body;
}

/** A stomp is a falling player whose feet were above the enemy's top on the previous frame. */
function isStomp(player: Entity, enemy: Entity, yUp: boolean): boolean {
  const b = player.body!;
  if (yUp) {
    // 3D: falling (-y), with its feet at or above the enemy's top a step ago (tolerance in metres).
    if (b.vy >= 0) return false;
    const previousBottom = player.transform.y - b.vy * FIXED_DT - b.height / 2;
    const enemyTop = enemy.transform.y + enemy.body!.height / 2;
    return previousBottom >= enemyTop - STOMP_TOLERANCE_3D;
  }
  if (b.vy <= 0) return false;
  const previousBottom = player.transform.y - b.vy * FIXED_DT + b.height / 2;
  const enemyTop = enemy.transform.y - enemy.body!.height / 2;
  return previousBottom <= enemyTop + STOMP_TOLERANCE;
}

/** AABB overlap, as the arcade engine computes it. Kept here for code that imported it from the world. */
export { overlaps } from "./arcade.ts";
