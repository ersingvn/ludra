import { SoundPlayer } from "./audio.ts";
import { parseFrames, type Sprite } from "./components.ts";
import { collectAssetPaths } from "./effects.ts";
import { InputScript } from "./input.ts";
import { ParticleSystem } from "./particles.ts";
import type { Script } from "./script.ts";
import { FIXED_DT } from "./time.ts";
import type { Action, SceneDef } from "./types.ts";
import { World, type Entity } from "./world.ts";

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

/**
 * Runs a scene in a canvas with keyboard controls, images, particles and
 * sound. The simulation uses the same fixed step as headless runs, so what
 * tests verify is what players get; everything added here is presentation.
 * Resolves (after images load) to a function that stops the game.
 */
export async function startGame(canvas: HTMLCanvasElement, scene: SceneDef, options: GameOptions = {}): Promise<() => void> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is not available.");
  const assetBase = options.assetBase ?? "";
  const [images, scripts] = await Promise.all([loadImages(scene, assetBase), loadScripts(scene, options)]);
  const sounds = new SoundPlayer(assetBase);
  const view = new View(scene, images);

  let world = new World(scene, { scripts });
  let crash: string | undefined;
  const restart = () => {
    world = new World(scene, { scripts });
    view.reset();
    crash = undefined;
  };

  const held = new Set<Action>();
  // Keys pressed since the last step. A tap shorter than one frame still reaches the simulation.
  const tapped = new Set<Action>();
  const onKeyDown = (event: KeyboardEvent) => {
    sounds.unlock();
    if (event.code === "KeyR") return restart();
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
    while (accumulator >= FIXED_DT && !crash) {
      try {
        world.step(tapped.size > 0 ? new Set([...held, ...tapped]) : held);
      } catch (err) {
        // A script threw: freeze the game and show why, instead of failing silently.
        crash = err instanceof Error ? err.message : String(err);
        console.error("[ludra]", err);
      }
      tapped.clear();
      view.step(world, (sound) => sounds.play(sound));
      accumulator -= FIXED_DT;
    }
    view.draw(ctx, world, sounds.muted);
    if (crash) drawCrash(ctx, crash);
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
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is not available.");
  const [images, scripts] = await Promise.all([loadImages(scene, options.assetBase ?? ""), loadScripts(scene, options)]);
  const view = new View(scene, images);
  const world = new World(scene, { scripts });
  const script = InputScript.parse(options.inputs ?? "");
  const wanted = new Set(options.frames);
  const last = Math.max(0, ...options.frames);
  const captured: CapturedFrame[] = [];

  for (let frame = 0; ; frame++) {
    if (wanted.has(frame)) {
      view.draw(ctx, world, false);
      captured.push({ frame, time: frame * FIXED_DT, png: canvas.toDataURL("image/png") });
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
  private shake = 0;
  private handledEvents = 0;
  private readonly scene: SceneDef;
  private readonly images: Map<string, HTMLImageElement>;

  constructor(scene: SceneDef, images: Map<string, HTMLImageElement>) {
    this.scene = scene;
    this.images = images;
  }

  reset(): void {
    this.particles.clear();
    this.facing.clear();
    this.emitTimers.clear();
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

  draw(ctx: CanvasRenderingContext2D, world: World, muted: boolean): void {
    const { width: viewWidth, height: viewHeight } = ctx.canvas;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = world.background;
    ctx.fillRect(0, 0, viewWidth, viewHeight);

    const target = world.entities.find((e) => e.camera) ?? world.entities.find((e) => e.platformer);
    const zoom = target?.camera?.zoom ?? 1;
    const visibleWidth = viewWidth / zoom;
    const visibleHeight = viewHeight / zoom;
    let cameraX = target ? clamp(target.transform.x - visibleWidth / 2, 0, Math.max(0, world.width - visibleWidth)) : 0;
    let cameraY = target ? clamp(target.transform.y - visibleHeight / 2, 0, Math.max(0, world.height - visibleHeight)) : 0;
    if (this.shake > 0) {
      cameraX += (this.particles.random() - 0.5) * 2 * this.shake;
      cameraY += (this.particles.random() - 0.5) * 2 * this.shake;
    }

    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-cameraX, -cameraY);
    const visible = world.entities.filter((e) => e.sprite).sort((a, b) => a.sprite!.layer - b.sprite!.layer);
    for (const e of visible) this.drawSprite(ctx, e, world.time);
    this.particles.draw(ctx);
    ctx.restore();

    ctx.textAlign = "left";
    ctx.font = "600 18px system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`Score ${world.score}   Deaths ${world.deaths}`, 16, 30);
    ctx.textAlign = "right";
    ctx.font = "500 13px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.fillText(`M: sound ${muted ? "off" : "on"} · R: restart`, viewWidth - 16, 28);

    if (world.won) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(0, 0, viewWidth, viewHeight);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.font = "700 44px system-ui, sans-serif";
      ctx.fillText("Level complete!", viewWidth / 2, viewHeight / 2 - 10);
      ctx.font = "500 18px system-ui, sans-serif";
      const winTime = world.events.find((e) => e.type === "win")?.time ?? world.time;
      ctx.fillText(`Score ${world.score} · ${winTime.toFixed(1)}s · Press R to play again`, viewWidth / 2, viewHeight / 2 + 30);
    }
  }

  private drawSprite(ctx: CanvasRenderingContext2D, e: Entity, time: number): void {
    const sprite = e.sprite!;
    const width = sprite.width || e.body?.width || 16;
    const height = sprite.height || e.body?.height || 16;
    const left = e.transform.x - width / 2;
    const top = e.transform.y - height / 2;
    const image = sprite.image ? this.images.get(sprite.image) : undefined;

    if (!image) {
      ctx.fillStyle = sprite.color;
      if (sprite.shape === "circle") {
        ctx.beginPath();
        ctx.ellipse(e.transform.x, e.transform.y, width / 2, height / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(left, top, width, height);
      }
      return;
    }

    if (sprite.tile) {
      const pattern = ctx.createPattern(image, "repeat");
      if (!pattern) return;
      ctx.save();
      ctx.translate(left, top);
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
      return;
    }

    const frameWidth = sprite.frameWidth || image.naturalWidth;
    const frameHeight = sprite.frameHeight || image.naturalHeight;
    const frames = this.framesFor(sprite, animationState(e));
    const frame = frames.length === 0 ? 0 : frames[Math.floor(time * sprite.fps) % frames.length]!;
    const columns = Math.max(1, Math.floor(image.naturalWidth / frameWidth));
    const sx = (frame % columns) * frameWidth;
    const sy = Math.floor(frame / columns) * frameHeight;
    const mirrored = sprite.flip && (this.facing.get(e.id) ?? 1) < 0;

    ctx.save();
    ctx.translate(e.transform.x, e.transform.y);
    if (mirrored) ctx.scale(-1, 1);
    ctx.drawImage(image, sx, sy, frameWidth, frameHeight, -width / 2, -height / 2, width, height);
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

function animationState(e: Entity): AnimationState {
  const b = e.body;
  if (!b) return "idle";
  if (e.platformer && !b.grounded) return b.vy < 0 ? "jump" : "fall";
  return Math.abs(b.vx) > 1 || (!e.platformer && Math.abs(b.vy) > 1) ? "run" : "idle";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
