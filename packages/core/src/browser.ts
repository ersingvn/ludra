import { SoundPlayer } from "./audio.ts";
import { parseFrames, type Sprite } from "./components.ts";
import { collectAssetPaths } from "./effects.ts";
import { InputScript } from "./input.ts";
import { ParticleSystem } from "./particles.ts";
import { PostFx } from "./postfx.ts";
import type { DrawContext, DrawEvent, Script } from "./script.ts";
import { FIXED_DT } from "./time.ts";
import type { Action, PostFxDef, SceneDef } from "./types.ts";
import { World, type Entity, type GameEvent } from "./world.ts";

const KEYMAP: Record<string, Action> = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  Space: "jump",
  KeyZ: "jump",
  KeyX: "action",
  Enter: "action",
};

/** Longest frame gap we catch up on, so a backgrounded tab doesn't fast-forward. */
const MAX_FRAME_TIME = 0.25;
/** Screen shake decays by this factor every step. */
const SHAKE_DECAY = 0.88;

export interface GameOptions {
  /** URL prefix for image and audio paths in the scene. Defaults to "". */
  assetBase?: string;
  /** URL prefix the scene's script paths are imported from. Defaults to `assetBase`. */
  scriptBase?: string;
  /** Scripts to load. Defaults to those the scene references; include any that `world.spawn` uses. */
  scriptPaths?: readonly string[];
  /**
   * Loads another scene by path, for goals with `next` and `world.goto`. Without it the
   * game stays on its first scene. Throw with a readable message if the scene is invalid.
   */
  loadScene?: (path: string) => Promise<SceneDef>;
  /**
   * Loads a physics engine a scene asks for (`world.physics`) before its world is created,
   * e.g. `async (name) => (await import("@ludra/physics")).loadRapierPhysics()` for "rapier".
   */
  loadPhysics?: (name: string) => Promise<void>;
  /** Start with the debug view on: colliders, sensors, joints and ids drawn over the game. */
  debug?: boolean;
}

/** Imports the game's script modules, keyed by their path in the scene. */
async function loadScripts(scene: SceneDef, options: GameOptions): Promise<Map<string, Script>> {
  const base = options.scriptBase ?? options.assetBase ?? "";
  const paths = options.scriptPaths ?? collectAssetPaths(scene).filter((ref) => ref.kind === "script").map((ref) => ref.path);
  const scripts = new Map<string, Script>();
  await Promise.all(
    [...new Set(paths)].map(async (path) => {
      const module = (await import(base + path)) as { default?: Script };
      if (!module.default) throw new Error(`Script ${path} has no default export.`);
      scripts.set(path, module.default);
    }),
  );
  return scripts;
}

/** Fonts load from Google Fonts or project files; a slow or offline font never blocks the game for long. */
async function loadFonts(scene: SceneDef, assetBase: string): Promise<void> {
  const fonts = Object.entries(scene.fonts ?? {});
  if (fonts.length === 0) return;
  const load = async ([family, src]: [string, string]) => {
    if (src === "google") {
      const name = encodeURIComponent(family).replace(/%20/g, "+");
      // Not every family has every weight, and Google rejects the request if one is missing.
      for (const weights of [":wght@400;500;600;700;800;900", ":wght@400;700", ""]) {
        const response = await fetch(`https://fonts.googleapis.com/css2?family=${name}${weights}&display=block`);
        if (!response.ok) continue;
        const style = document.createElement("style");
        style.textContent = await response.text();
        document.head.append(style);
        break;
      }
      await Promise.all(["400", "700", "900"].map((weight) => document.fonts.load(`${weight} 16px "${family}"`)));
    } else {
      const face = new FontFace(family, `url("${assetBase}${src}")`);
      // FontFaceSet.add is missing from some TypeScript DOM typings.
      (document.fonts as unknown as Set<FontFace>).add(await face.load());
    }
  };
  const all = Promise.all(
    fonts.map((font) => load(font).catch((err) => console.warn(`[ludra] could not load font "${font[0]}": ${err}`))),
  );
  await Promise.race([all, new Promise((resolve) => setTimeout(resolve, 4000))]);
}

/** A scene's postfx shader source, or why it couldn't be fetched. */
async function loadShader(scene: SceneDef, assetBase: string): Promise<string | Error | undefined> {
  const path = scene.postfx?.shader;
  if (!path) return undefined;
  const response = await fetch(assetBase + path).catch((err: unknown) => err as Error);
  if (response instanceof Error) return response;
  return response.ok ? response.text() : new Error(`could not load ${path} (${response.status})`);
}

/**
 * The canvas players see. The game always draws into the 2D canvas; when a scene
 * has `postfx`, a WebGL canvas running its shader takes the 2D canvas's place in
 * the page, and goes away again for a scene without one.
 */
class Screen {
  readonly ctx: CanvasRenderingContext2D;
  output: HTMLCanvasElement;
  private readonly canvas: HTMLCanvasElement;
  private fx: PostFx | undefined;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context is not available.");
    this.ctx = ctx;
    this.canvas = canvas;
    this.output = canvas;
  }

  /** Switches to a scene's shader, or to none. Returns why the shader can't run, if it can't. */
  use(postfx: PostFxDef | undefined, shader: string | Error | undefined): string | undefined {
    let fx: PostFx | undefined;
    let error: string | undefined;
    if (postfx && shader !== undefined) {
      try {
        if (shader instanceof Error) throw shader;
        fx = new PostFx(this.canvas.width, this.canvas.height, shader, postfx);
      } catch (err) {
        error = `postfx: ${message(err)}`;
        console.error("[ludra]", err);
      }
    }
    const target = fx?.canvas ?? this.canvas;
    if (target !== this.output) {
      target.id = this.canvas.id;
      target.className = this.canvas.className;
      target.style.cssText = this.canvas.style.cssText;
      this.output.replaceWith(target);
      this.output = target;
    }
    this.fx = fx;
    return error;
  }

  /** Shows the frame the game just drew, through the shader if there is one. */
  present(time: number): void {
    this.fx?.render(this.canvas, time);
  }
}

/** Loads the physics engine a scene names, if it isn't arcade. */
async function usePhysics(scene: SceneDef, options: GameOptions): Promise<void> {
  const name = scene.world?.physics;
  if (name && name !== "arcade") await options.loadPhysics?.(name);
}

/** What a scene needs before it can be drawn. */
async function loadScene(scene: SceneDef, options: GameOptions, scripts: Map<string, Script>) {
  const assetBase = options.assetBase ?? "";
  const [images, more, shader] = await Promise.all([
    loadImages(scene, assetBase),
    loadScripts(scene, options),
    loadShader(scene, assetBase),
    loadFonts(scene, assetBase),
  ]);
  for (const [path, script] of more) scripts.set(path, script);
  return { images, shader };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Seconds the win screen shows before the next scene, and the fade into a world.goto scene. */
const WIN_PAUSE = 1.6;
const GOTO_FADE = 0.35;

/**
 * Runs a scene in a canvas with keyboard controls, images, particles and
 * sound. The simulation uses the same fixed step as headless runs, so what
 * tests verify is what players get; everything added here is presentation.
 * With `options.loadScene`, won goals with `next` and `world.goto` move on
 * to other scenes, keeping score, deaths and lives.
 * Resolves (after images load) to a function that stops the game.
 */
export async function startGame(canvas: HTMLCanvasElement, firstScene: SceneDef, options: GameOptions = {}): Promise<() => void> {
  const screen = new Screen(canvas);
  const ctx = screen.ctx;
  const sounds = new SoundPlayer(options.assetBase ?? "");
  const scripts = new Map<string, Script>();

  type Carry = { score: number; deaths: number; lives: number | undefined };
  let scene = firstScene;
  let startCarry: Carry | undefined;
  let view: View;
  let world: World;
  let crash: string | undefined;
  let sceneError: string | undefined;
  /** Real time when the world asked to move on, while waiting to load the next scene. */
  let exitSince: number | undefined;
  let loading = false;
  let debug = options.debug ?? false;

  const enter = async (next: SceneDef, carry: Carry | undefined) => {
    const { images, shader } = await loadScene(next, options, scripts);
    await usePhysics(next, options);
    scene = next;
    startCarry = carry;
    view = new View(next, images);
    view.debug = debug;
    sceneError = screen.use(next.postfx, shader);
    crash = sceneError;
    exitSince = undefined;
    try {
      world = new World(next, { scripts, carry });
    } catch (err) {
      crash = message(err);
      world = new World({ ...next, entities: [] });
    }
  };
  await enter(firstScene, undefined);

  // Game over starts the whole game again; otherwise R restarts the current scene as it began.
  const restart = () => {
    if (loading) return;
    if (world.lost && scene !== firstScene) {
      loading = true;
      void enter(firstScene, undefined).finally(() => (loading = false));
      return;
    }
    world = new World(scene, { scripts, carry: startCarry });
    view.reset();
    crash = sceneError;
    exitSince = undefined;
  };

  const moveOn = (path: string) => {
    if (!options.loadScene) return;
    loading = true;
    const carry = { score: world.score, deaths: world.deaths, lives: world.lives };
    options
      .loadScene(path)
      .then((next) => enter(next, carry))
      .catch((err: unknown) => {
        crash = `Could not load the next scene "${path}": ${message(err)}`;
      })
      .finally(() => (loading = false));
  };

  const held = new Set<Action>();
  // Keys pressed since the last step. A tap shorter than one frame still reaches the simulation.
  const tapped = new Set<Action>();
  const onKeyDown = (event: KeyboardEvent) => {
    sounds.unlock();
    if (event.code === "KeyR") return restart();
    if (event.code === "Backquote" && !event.repeat) {
      debug = !debug;
      view.debug = debug;
      return;
    }
    if (event.code === "KeyM" && !event.repeat) {
      sounds.muted = !sounds.muted;
      return;
    }
    const action = KEYMAP[event.code];
    if (!action) return;
    held.add(action);
    if (!event.repeat) tapped.add(action);
    event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const action = KEYMAP[event.code];
    if (action) held.delete(action);
  };
  const onBlur = () => held.clear();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  let last = performance.now();
  let accumulator = 0;
  let raf = 0;
  const frame = (now: number) => {
    accumulator += Math.min(MAX_FRAME_TIME, (now - last) / 1000);
    last = now;
    while (accumulator >= FIXED_DT && !crash && !loading) {
      try {
        world.step(tapped.size > 0 ? new Set([...held, ...tapped]) : held);
      } catch (err) {
        // A script threw: freeze the game and show why, instead of failing silently.
        crash = message(err);
        console.error("[ludra]", err);
      }
      tapped.clear();
      view.step(world, (sound) => sounds.play(sound));
      accumulator -= FIXED_DT;
    }

    // Moving on: let the win screen show, or fade out for a world.goto, then load.
    let fade = 0;
    if (world.exit !== undefined && options.loadScene && !crash) {
      exitSince ??= now;
      const pause = world.won ? WIN_PAUSE : GOTO_FADE;
      const elapsed = (now - exitSince) / 1000;
      fade = Math.min(1, Math.max(0, (elapsed - (pause - GOTO_FADE)) / GOTO_FADE));
      if (elapsed >= pause && !loading) moveOn(world.exit);
    }

    try {
      view.draw(ctx, world, sounds.muted, options.loadScene !== undefined);
    } catch (err) {
      // A draw hook threw. Same treatment as a simulation error.
      if (!crash) console.error("[ludra]", err);
      crash ??= message(err);
    }
    if (fade > 0 || loading) {
      ctx.fillStyle = `rgba(0, 0, 0, ${loading ? 1 : fade})`;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    if (crash) drawCrash(ctx, crash);
    screen.present(world.time);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}

export interface CaptureOptions extends GameOptions {
  /** Input script, e.g. `"right:1s, jump:0.4s"`. See `InputScript`. */
  inputs?: string;
  /** Simulation frames to capture (60 per second). Frame 0 is the starting state. */
  frames: readonly number[];
}

export interface CapturedFrame {
  frame: number;
  time: number;
  /** PNG as a data URL. */
  png: string;
}

/**
 * Plays a scene without a clock or keyboard and returns the requested frames
 * as PNGs. Same renderer, effects and particles as `startGame`, stepped
 * deterministically, so a frame always looks the same. Used by
 * `ludra play --screenshot`.
 */
export async function captureFrames(canvas: HTMLCanvasElement, scene: SceneDef, options: CaptureOptions): Promise<CapturedFrame[]> {
  const screen = new Screen(canvas);
  const scripts = new Map<string, Script>();
  const { images, shader } = await loadScene(scene, options, scripts);
  await usePhysics(scene, options);
  const error = screen.use(scene.postfx, shader);
  if (error) throw new Error(error);
  const view = new View(scene, images);
  view.debug = options.debug ?? false;
  const world = new World(scene, { scripts });
  const script = InputScript.parse(options.inputs ?? "");
  const wanted = new Set(options.frames);
  const last = Math.max(0, ...options.frames);
  const captured: CapturedFrame[] = [];

  for (let frame = 0; ; frame++) {
    if (wanted.has(frame)) {
      view.draw(screen.ctx, world, false, false);
      screen.present(world.time);
      captured.push({ frame, time: frame * FIXED_DT, png: screen.output.toDataURL("image/png") });
    }
    if (frame >= last) break;
    world.step(script.at(frame));
    view.step(world, () => {});
  }
  return captured;
}

function drawCrash(ctx: CanvasRenderingContext2D, message: string): void {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = "rgba(20, 0, 8, 0.85)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ff9b9b";
  ctx.textAlign = "left";
  ctx.font = "700 22px system-ui, sans-serif";
  ctx.fillText("Script error", 32, 56);
  ctx.font = "15px ui-monospace, monospace";
  // Wrap the message to the canvas width.
  let line = "";
  let y = 92;
  for (const word of message.split(" ")) {
    if (ctx.measureText(line + word).width > width - 64) {
      ctx.fillText(line, 32, y);
      line = "";
      y += 22;
    }
    line += `${word} `;
  }
  ctx.fillText(line, 32, y);
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.fillText("Fix the script; the page reloads on save. R restarts.", 32, y + 40);
}

async function loadImages(scene: SceneDef, assetBase: string): Promise<Map<string, HTMLImageElement>> {
  const images = new Map<string, HTMLImageElement>();
  const paths = new Set(collectAssetPaths(scene).filter((ref) => ref.kind === "image").map((ref) => ref.path));
  await Promise.all(
    [...paths].map(
      (path) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = () => {
            images.set(path, image);
            resolve();
          };
          image.onerror = () => {
            console.warn(`[ludra] could not load image "${path}", drawing a colored shape instead.`);
            resolve();
          };
          image.src = assetBase + path;
        }),
    ),
  );
  return images;
}

/** Presentation state that lives next to the world: particles, shake, facing and effects. */
class View {
  private readonly particles = new ParticleSystem();
  private readonly facing = new Map<string, number>();
  private readonly emitTimers = new Map<string, number>();
  private readonly frameCache = new Map<string, number[]>();
  /** ctx.local for each entity's draw hooks. */
  private readonly local = new Map<string, Record<string, unknown>>();
  /** Frames each platformer has been off the ground, so a one-frame bump doesn't flash the fall pose. */
  private readonly airborne = new Map<string, number>();
  /** Where joints to a point in the world were first seen, to draw them in the debug view. */
  private readonly jointOrigins = new Map<string, { x: number; y: number }>();
  /** Draw colliders, sensors, joints and ids over the game. */
  debug = false;
  private shake = 0;
  private handledEvents = 0;
  private readonly scene: SceneDef;
  private readonly images: Map<string, HTMLImageElement>;

  /** Whether the scene can award points at all, so the default HUD can leave the score out. */
  private readonly scoring: boolean;

  constructor(scene: SceneDef, images: Map<string, HTMLImageElement>) {
    this.scene = scene;
    this.images = images;
    this.scoring = scene.entities.some(
      (e) => e.components.collectible || (e.components.hazard && Number(e.components.hazard.score) > 0) || Number(e.components.goal?.requireScore) > 0,
    );
  }

  reset(): void {
    this.particles.clear();
    this.facing.clear();
    this.emitTimers.clear();
    this.local.clear();
    this.airborne.clear();
    this.jointOrigins.clear();
    this.shake = 0;
    this.handledEvents = 0;
  }

  /** Runs once per simulation step: turns new events into effects and advances particles. */
  step(world: World, playSound: (sound: string) => void): void {
    for (const event of world.events.slice(this.handledEvents)) {
      const effect = this.scene.effects?.[event.type === "custom" ? event.name : event.type];
      if (!effect) continue;
      if (effect.particles) this.particles.burst(event.x, event.y, effect.particles);
      if (effect.sound) playSound(effect.sound);
      if (effect.shake) this.shake = Math.max(this.shake, effect.shake);
    }
    this.handledEvents = world.events.length;

    for (const e of world.entities) {
      if (e.body && Math.abs(e.body.vx) > 1) this.facing.set(e.id, Math.sign(e.body.vx));
      if (e.platformer && e.body) this.airborne.set(e.id, e.body.grounded ? 0 : (this.airborne.get(e.id) ?? 0) + 1);
      const emitter = e.emitter;
      if (!emitter || world.won) continue;
      // Accumulate fractional particles so low rates still emit steadily.
      const due = (this.emitTimers.get(e.id) ?? 0) + emitter.rate * FIXED_DT;
      const count = Math.floor(due);
      this.emitTimers.set(e.id, due - count);
      if (count > 0) this.particles.burst(e.transform.x, e.transform.y, { ...emitter }, count);
    }

    this.particles.update(FIXED_DT);
    this.shake = this.shake < 0.5 ? 0 : this.shake * SHAKE_DECAY;
  }

  /** `continues`: the host loads next scenes, so a won scene with `next` says so instead of offering a replay. */
  draw(ctx: CanvasRenderingContext2D, world: World, muted: boolean, continues: boolean): void {
    const { width: viewWidth, height: viewHeight } = ctx.canvas;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = world.background;
    ctx.fillRect(0, 0, viewWidth, viewHeight);

    const target = world.entities.find((e) => e.camera) ?? world.entities.find((e) => e.platformer || e.topdown);
    const zoom = target?.camera?.zoom ?? 1;
    const visibleWidth = viewWidth / zoom;
    const visibleHeight = viewHeight / zoom;
    let cameraX = target ? clamp(target.transform.x - visibleWidth / 2, 0, Math.max(0, world.width - visibleWidth)) : 0;
    let cameraY = target ? clamp(target.transform.y - visibleHeight / 2, 0, Math.max(0, world.height - visibleHeight)) : 0;
    if (this.shake > 0) {
      cameraX += (this.particles.random() - 0.5) * 2 * this.shake;
      cameraY += (this.particles.random() - 0.5) * 2 * this.shake;
    }

    const viewInfo = { width: viewWidth, height: viewHeight, cameraX, cameraY, zoom };
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-cameraX, -cameraY);
    const layer = (e: Entity) => e.sprite?.layer ?? 0;
    const visible = world.entities.filter((e) => e.sprite || e.script?.module.draw).sort((a, b) => layer(a) - layer(b));
    for (const e of visible) {
      if (e.sprite) this.drawSprite(ctx, e, world.time);
      if (e.script?.module.draw) this.drawHook(ctx, world, e, "draw", viewInfo);
    }
    this.particles.draw(ctx);
    if (this.debug) this.drawDebug(ctx, world, zoom);
    ctx.restore();

    if (world.hasHook("drawUI")) {
      // The game draws its own interface.
      for (const e of [...world.entities]) if (e.script?.module.drawUI) this.drawHook(ctx, world, e, "drawUI", viewInfo);
      return;
    }

    // Only what this scene uses: no "Score 0" in a game without points.
    const parts: string[] = [];
    if (world.lives !== undefined) parts.push(`${"♥".repeat(Math.max(0, Math.min(world.lives, 10)))}${world.lives > 10 ? ` ${world.lives}` : ""}`);
    if (this.scoring || world.score !== 0) parts.push(`Score ${world.score}`);
    if (world.lives === undefined) parts.push(`Deaths ${world.deaths}`);
    ctx.textAlign = "left";
    ctx.font = "600 18px system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(parts.join("   "), 16, 30);
    ctx.textAlign = "right";
    ctx.font = "500 13px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.fillText(`M: sound ${muted ? "off" : "on"} · R: restart`, viewWidth - 16, 28);

    if (world.won || world.lost) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(0, 0, viewWidth, viewHeight);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.font = "700 44px system-ui, sans-serif";
      ctx.fillText(world.won ? "Level complete!" : "Game over", viewWidth / 2, viewHeight / 2 - 10);
      ctx.font = "500 18px system-ui, sans-serif";
      const endTime = world.events.find((e) => e.type === "win" || e.type === "gameover")?.time ?? world.time;
      const next = world.won && world.exit !== undefined && continues ? "Get ready…" : `Press R to ${world.won ? "play again" : "try again"}`;
      const score = this.scoring || world.score !== 0 ? `Score ${world.score} · ` : "";
      ctx.fillText(`${score}${endTime.toFixed(1)}s · ${next}`, viewWidth / 2, viewHeight / 2 + 30);
    }
  }

  private drawHook(ctx: CanvasRenderingContext2D, world: World, e: Entity, hook: "draw" | "drawUI", view: DrawContext["view"]): void {
    let local = this.local.get(e.id);
    if (!local) this.local.set(e.id, (local = {}));
    ctx.save();
    try {
      world.callDrawHook(e, hook, {
        g: ctx,
        time: world.time,
        local,
        view,
        recent: (name, seconds = 0.5) => recentEvents(world, name, seconds),
        image: (path) => this.images.get(path),
        burst: (x, y, particles = {}) => this.particles.burst(x, y, particles),
        shake: (amount) => {
          this.shake = Math.max(this.shake, amount);
        },
        random: () => this.particles.random(),
      });
    } finally {
      // Whatever the hook changed (transform, alpha, blend mode, filter) ends with it.
      ctx.restore();
    }
  }

  private drawSprite(ctx: CanvasRenderingContext2D, e: Entity, time: number): void {
    const sprite = e.sprite!;
    const width = sprite.width || e.body?.width || 16;
    const height = sprite.height || e.body?.height || 16;
    const image = sprite.image ? this.images.get(sprite.image) : undefined;
    const rotation = e.transform.rotation;

    if (!image) {
      ctx.fillStyle = sprite.color;
      // A plain shape follows the body's shape, so a round rapier body looks round.
      const round = sprite.shape === "circle" || e.body?.shape === "circle";
      ctx.save();
      ctx.translate(e.transform.x, e.transform.y);
      if (rotation) ctx.rotate(rotation * DEGREES);
      ctx.beginPath();
      if (round) ctx.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
      else if (e.body?.shape === "capsule") ctx.roundRect(-width / 2, -height / 2, width, height, Math.min(width, height) / 2);
      else ctx.rect(-width / 2, -height / 2, width, height);
      ctx.fill();
      ctx.restore();
      return;
    }

    if (sprite.tile) {
      const pattern = ctx.createPattern(image, "repeat");
      if (!pattern) return;
      ctx.save();
      ctx.translate(e.transform.x, e.transform.y);
      if (rotation) ctx.rotate(rotation * DEGREES);
      // Tiles start at the sprite's top-left corner, whatever its rotation.
      ctx.translate(-width / 2, -height / 2);
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
      return;
    }

    const frameWidth = sprite.frameWidth || image.naturalWidth;
    const frameHeight = sprite.frameHeight || image.naturalHeight;
    const frames = this.framesFor(sprite, animationState(e, this.airborne.get(e.id) ?? 0));
    const frame = frames.length === 0 ? 0 : frames[Math.floor(time * sprite.fps) % frames.length]!;
    const columns = Math.max(1, Math.floor(image.naturalWidth / frameWidth));
    const sx = (frame % columns) * frameWidth;
    const sy = Math.floor(frame / columns) * frameHeight;
    const mirrored = sprite.flip && (this.facing.get(e.id) ?? 1) < 0;

    ctx.save();
    ctx.translate(e.transform.x, e.transform.y);
    if (rotation) ctx.rotate(rotation * DEGREES);
    if (mirrored) ctx.scale(-1, 1);
    ctx.drawImage(image, sx, sy, frameWidth, frameHeight, -width / 2, -height / 2, width, height);
    ctx.restore();
  }

  /**
   * The debug view: every collider in its true shape and rotation (static blue, dynamic
   * yellow, kinematic orange, players red; sensors dashed green), velocities, joints,
   * grounded players and ids, so an agent can check that the art matches the physics.
   */
  private drawDebug(ctx: CanvasRenderingContext2D, world: World, zoom: number): void {
    const line = 1.5 / zoom;
    ctx.save();
    ctx.lineWidth = line;
    ctx.font = `${11 / zoom}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    for (const e of world.entities) {
      const b = e.body;
      if (!b) continue;
      const player = !!(e.platformer || e.topdown);
      const color = b.sensor ? "#2ecc40" : player ? "#ff4136" : b.type === "static" ? "#7fdbff" : b.type === "kinematic" ? "#ff851b" : "#ffdc00";
      ctx.save();
      ctx.translate(e.transform.x, e.transform.y);
      ctx.rotate(e.transform.rotation * DEGREES);
      ctx.beginPath();
      if (b.shape === "circle") ctx.arc(0, 0, b.width / 2, 0, Math.PI * 2);
      else if (b.shape === "capsule") ctx.roundRect(-b.width / 2, -b.height / 2, b.width, b.height, Math.min(b.width, b.height) / 2);
      else ctx.rect(-b.width / 2, -b.height / 2, b.width, b.height);
      ctx.setLineDash(b.sensor ? [4 / zoom, 3 / zoom] : []);
      ctx.strokeStyle = color;
      ctx.fillStyle = `${color}22`;
      ctx.fill();
      ctx.stroke();
      // Which way is "up" for the body, so rotation is visible even on circles.
      if (b.type === "dynamic") {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -Math.min(b.width, b.height) / 2);
        ctx.stroke();
      }
      ctx.restore();
      ctx.setLineDash([]);
      if (b.type !== "static" && Math.hypot(b.vx, b.vy) > 1) {
        // Velocity, a tenth of a second ahead.
        ctx.strokeStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(e.transform.x, e.transform.y);
        ctx.lineTo(e.transform.x + b.vx * 0.1, e.transform.y + b.vy * 0.1);
        ctx.stroke();
      }
      if (player && b.grounded) {
        ctx.fillStyle = "#ff4136";
        ctx.beginPath();
        ctx.arc(e.transform.x, e.transform.y + b.height / 2, 3 / zoom, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillText(e.id, e.transform.x, e.transform.y - b.height / 2 - 4 / zoom);
    }
    // Joints: a magenta line from each body's center to where the joint holds it.
    ctx.strokeStyle = "#f012be";
    ctx.fillStyle = "#f012be";
    for (const e of world.entities) {
      const joint = e.joint;
      if (!joint) continue;
      const here = rotated(e, joint.anchor);
      const other = joint.to ? world.get(joint.to) : undefined;
      const sameSpot = joint.type === "revolute" || joint.type === "prismatic" || joint.type === "fixed";
      let origin = this.jointOrigins.get(e.id);
      if (!origin) this.jointOrigins.set(e.id, (origin = { x: e.transform.x, y: e.transform.y }));
      const there = sameSpot ? here : other ? rotated(other, joint.toAnchor) : { x: origin.x + joint.toAnchor.x, y: origin.y + joint.toAnchor.y };
      ctx.beginPath();
      ctx.moveTo(e.transform.x, e.transform.y);
      ctx.lineTo(here.x, here.y);
      if (other) {
        ctx.moveTo(other.transform.x, other.transform.y);
        ctx.lineTo(there.x, there.y);
      }
      ctx.moveTo(here.x, here.y);
      ctx.lineTo(there.x, there.y);
      ctx.stroke();
      for (const p of [here, there]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 / zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Picks the frame list for a state, falling back fall → jump → idle and run → idle. */
  private framesFor(sprite: Sprite, state: AnimationState): number[] {
    const chain: Record<AnimationState, (keyof Sprite)[]> = {
      idle: ["idle"],
      run: ["run", "idle"],
      jump: ["jump", "idle"],
      fall: ["fall", "jump", "idle"],
    };
    for (const key of chain[state]) {
      const text = sprite[key] as string;
      if (text.trim() === "") continue;
      let frames = this.frameCache.get(text);
      if (!frames) {
        frames = parseFrames(text);
        this.frameCache.set(text, frames);
      }
      return frames;
    }
    return [0];
  }
}

type AnimationState = "idle" | "run" | "jump" | "fall";

function recentEvents(world: World, name: string | undefined, seconds: number): DrawEvent[] {
  const since = world.time - seconds;
  const result: DrawEvent[] = [];
  // Events are in time order, so walk back until they get too old.
  for (let i = world.events.length - 1; i >= 0; i--) {
    const event = world.events[i]!;
    if (event.time < since) break;
    const eventName = event.type === "custom" ? event.name : event.type;
    if (name !== undefined && eventName !== name) continue;
    // Custom events carry what the script passed; built-in ones their own details (item, enemy, checkpoint...).
    const { type: _type, frame: _frame, time, x, y, entity, ...details } = event as GameEvent & { data?: unknown };
    const data = event.type === "custom" ? event.data : details;
    result.push({ name: eventName, time, x, y, entity, data });
  }
  return result.reverse();
}

/** Frames off the ground before a platformer counts as falling (jumps show at once). */
const FALL_GRACE = 3;

function animationState(e: Entity, airborne: number): AnimationState {
  const b = e.body;
  if (!b) return "idle";
  if (e.platformer && !b.grounded && (b.vy < 0 || airborne >= FALL_GRACE)) return b.vy < 0 ? "jump" : "fall";
  return Math.abs(b.vx) > 1 || (!e.platformer && Math.abs(b.vy) > 1) ? "run" : "idle";
}

const DEGREES = Math.PI / 180;

/** An offset from an entity's center, turned with the entity, as a world point. */
function rotated(e: Entity, offset: { x: number; y: number }): { x: number; y: number } {
  const angle = e.transform.rotation * DEGREES;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: e.transform.x + offset.x * cos - offset.y * sin, y: e.transform.y + offset.x * sin + offset.y * cos };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
