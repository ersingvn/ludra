import { SoundPlayer } from "./audio.ts";
import { CameraRig } from "./camera.ts";
import { actionsUsed, Gamepads, TouchControls } from "./controls.ts";
import { entityBox, inputKey, REPLAY_LIMIT, replayScene, type GameControl } from "./studio-link.ts";
import { physicsEngineName } from "./engines.ts";
import { parseFrames, type Sprite } from "./components.ts";
import { collectAssetPaths } from "./effects.ts";
import { InputScript } from "./input.ts";
import { LABEL_HEIGHT, layoutLabels, type Label } from "./labels.ts";
import { ParticleSystem } from "./particles.ts";
import { pixelText } from "./pixelfont.ts";
import { MARK_LABELS, Recorder, type MarkKind } from "./recording.ts";
import { NoWebGL, PostFx } from "./postfx.ts";
import type { DrawContext, DrawEvent, Script } from "./script.ts";
import { FIXED_DT } from "./time.ts";
import type { Body } from "./components.ts";
import type { Action, PostFxDef, SceneDef } from "./types.ts";
import { World, type Entity, type GameEvent } from "./world.ts";

export { Recorder };
export { connectStudio, type GameControl, type StudioLink } from "./studio-link.ts";

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

/** Keys a player marks a moment with, when the session is being recorded. N asks for their own words. */
const MARK_KEYS: Record<string, MarkKind> = {
  Digit1: "hard",
  Numpad1: "hard",
  Digit2: "boring",
  Numpad2: "boring",
  Digit3: "confusing",
  Numpad3: "confusing",
  Digit4: "great",
  Numpad4: "great",
};
/** Milliseconds a mark's confirmation stays on screen. */
const TOAST_MS = 1200;

/** Longest frame gap we catch up on, so a backgrounded tab doesn't fast-forward. */
const MAX_FRAME_TIME = 0.25;
/** Screen shake decays by this factor every step. */
const SHAKE_DECAY = 0.88;

/**
 * Draws a 3D scene. @ludra/three provides one (createRenderer3D); core only calls it, so
 * 2D games never load Three.js. The frame is drawn into `canvas` and copied into the game's
 * 2D canvas, where the HUD, drawUI hooks and the postfx shader go on top.
 */
export interface Renderer3D {
  readonly canvas: HTMLCanvasElement;
  /** Draw colliders, joints and lights over the frame. */
  debug: boolean;
  /** Once per simulation step: the camera's smoothing and anything else that moves with the game. */
  step(world: World): void;
  /** Draws the world as it is now. */
  render(world: World): void;
  /** The scene restarted: snap the camera back, forget per-entity state. */
  reset(world: World): void;
  dispose(): void;
  /** Waits for anything still loading (render hooks' addons), so a screenshot shows the finished frame. */
  settle?(): Promise<void>;
  /** Looks from somewhere other than the scene's camera3d. Leaves the game alone. */
  view?: CameraView;
  /** Ids of entities to leave out of the drawing. */
  hidden?: ReadonlySet<string>;
  /** Names to write over the frame at these canvas pixels: the map view labels its entities. */
  labels?(world: World): Label[];
}

/**
 * A debugging view of a 3D scene: `map` looks straight down on the whole level, `free`
 * looks from a point at another point or at an entity (by id), followed as it moves.
 */
export type CameraView = { mode: "map" } | { mode: "free"; from: { x: number; y: number; z: number }; at: { x: number; y: number; z: number } | string };

/** Where a project path (an image, sound, model...) is loaded from. */
export type AssetUrl = (path: string) => string;

export type Renderer3DFactory = (scene: SceneDef, options: { width: number; height: number; assetBase: string; assetUrl?: AssetUrl }) => Promise<Renderer3D>;

export interface GameOptions {
  /** URL prefix for image and audio paths in the scene. Defaults to "". */
  assetBase?: string;
  /** Where each asset path loads from, instead of `assetBase` + path: a single-file build points them at its own data. */
  assetUrl?: AssetUrl;
  /** URL prefix the scene's script paths are imported from. Defaults to `assetBase`. */
  scriptBase?: string;
  /** Imports a script module instead of `import(scriptBase + path)`: a bundle has its scripts already. */
  loadScript?: (path: string) => Promise<{ default?: Script }>;
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
  /** Whether backquote turns the debug view on and off. Defaults to true; a shipped build turns it off. */
  debugKey?: boolean;
  /** Start with the debug view on: colliders, sensors, joints and ids drawn over the game. */
  debug?: boolean;
  /**
   * Loads the 3D renderer for scenes with "dimensions": 3, e.g.
   * `async () => (await import("@ludra/three")).createRenderer3D`.
   */
  loadRenderer3D?: () => Promise<Renderer3DFactory>;
  /**
   * The actions the game uses, which on-screen touch controls show. Defaults to what each scene's
   * player components need; the CLI adds what scripts read.
   */
  actions?: readonly Action[];
  /** On-screen buttons once someone touches the page. Defaults to true. Gamepads always work. */
  touch?: boolean;
  /** The entry scene's path, as Studio names scenes. */
  entryPath?: string;
  /** Receives the controls Ludra Studio drives the game with: pause, step, inspect, hot reload. */
  onControl?: (control: GameControl) => void;
  /** Writes down the session, and turns on the keys that mark moments. `ludra dev` passes one. */
  recorder?: Recorder;
}

/** How the game finds its assets: `assetUrl`, or `assetBase` + path. */
function assetUrlOf(options: GameOptions): AssetUrl {
  const base = options.assetBase ?? "";
  return options.assetUrl ?? ((path) => base + path);
}

/** A 3D scene's renderer, or undefined for 2D. */
async function useRenderer3D(scene: SceneDef, options: GameOptions, width: number, height: number): Promise<Renderer3D | undefined> {
  if (scene.world?.dimensions !== 3) return undefined;
  if (!options.loadRenderer3D) throw new Error('This scene is 3D ("dimensions": 3), which @ludra/three draws. Pass loadRenderer3D to startGame (the ludra CLI does this for you).');
  const create = await options.loadRenderer3D();
  return create(scene, { width, height, assetBase: options.assetBase ?? "", assetUrl: assetUrlOf(options) });
}

/** Imports the game's script modules, keyed by their path in the scene. */
async function loadScripts(scene: SceneDef, options: GameOptions): Promise<Map<string, Script>> {
  const base = options.scriptBase ?? options.assetBase ?? "";
  const paths = options.scriptPaths ?? collectAssetPaths(scene).filter((ref) => ref.kind === "script").map((ref) => ref.path);
  const scripts = new Map<string, Script>();
  await Promise.all(
    [...new Set(paths)].map(async (path) => {
      const module = options.loadScript ? await options.loadScript(path) : ((await import(base + path)) as { default?: Script });
      if (!module.default) throw new Error(`Script ${path} has no default export.`);
      scripts.set(path, module.default);
    }),
  );
  return scripts;
}

/** Fonts load from Google Fonts or project files; a slow or offline font never blocks the game for long. */
async function loadFonts(scene: SceneDef, assetUrl: AssetUrl): Promise<void> {
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
      const face = new FontFace(family, `url("${assetUrl(src)}")`);
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
async function loadShader(scene: SceneDef, assetUrl: AssetUrl): Promise<string | Error | undefined> {
  const path = scene.postfx?.shader;
  if (!path) return undefined;
  const response = await fetch(assetUrl(path)).catch((err: unknown) => err as Error);
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
        if (err instanceof NoWebGL) {
          // The player can't fix this and the game works without it: play on, unfinished by a shader.
          console.warn("[ludra]", err.message);
        } else {
          error = `postfx: ${message(err)}`;
          console.error("[ludra]", err);
        }
      }
    }
    this.show(fx);
    return error;
  }

  /** Shows the frame the game just drew, through the shader if there is one. */
  present(time: number): void {
    if (this.fx?.lost) {
      // The GPU took WebGL away mid-game: play on without the shader, as with no WebGL at all.
      console.warn("[ludra] postfx: the GPU lost WebGL, so the game plays on without its shader.");
      this.show(undefined);
    }
    this.fx?.render(this.canvas, time);
  }

  /** Puts the shader's canvas, or the game's own, in the page. */
  private show(fx: PostFx | undefined): void {
    const target = fx?.canvas ?? this.canvas;
    if (target !== this.output) {
      target.id = this.canvas.id;
      target.className = this.canvas.className;
      target.style.cssText = this.canvas.style.cssText;
      this.output.replaceWith(target);
      this.output = target;
    }
    this.fx = fx;
  }
}

/** Loads the physics engine a scene names, if it isn't arcade. */
async function usePhysics(scene: SceneDef, options: GameOptions): Promise<void> {
  const name = physicsEngineName(scene);
  if (name !== "arcade") await options.loadPhysics?.(name);
}

/** What a scene needs before it can be drawn. */
async function loadScene(scene: SceneDef, options: GameOptions, scripts: Map<string, Script>) {
  const assetUrl = assetUrlOf(options);
  const [images, more, shader] = await Promise.all([
    loadImages(scene, assetUrl),
    loadScripts(scene, options),
    loadShader(scene, assetUrl),
    loadFonts(scene, assetUrl),
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
  const sounds = new SoundPlayer(assetUrlOf(options));
  const scripts = new Map<string, Script>();

  type Carry = { score: number; deaths: number; lives: number | undefined };
  let scene = firstScene;
  /** The scene's path; undefined for the entry scene. */
  let scenePath: string | undefined;
  let startCarry: Carry | undefined;
  let view: View;
  let world: World;
  let crash: string | undefined;
  let sceneError: string | undefined;
  /** Real time when the world asked to move on, while waiting to load the next scene. */
  let exitSince: number | undefined;
  let loading = false;
  let debug = options.debug ?? false;
  /** World events the sound hooks have already been given, and their per-entity memory. */
  let soundEvents = 0;
  const soundLocals = new Map<string, Record<string, unknown>>();
  let touch: TouchControls | undefined;
  let touched = false;
  /** The scene a game over goes back to: the first one, or its hot-reloaded version. */
  let entryScene = firstScene;
  /** Every frame's input since the scene started, for a hot reload to replay. One past the limit means too far. */
  let frameInputs: string[] = [];
  let paused = false;
  let pendingSteps = 0;
  let fps = 60;
  const listeners: { scene?: () => void; crash?: (message: string) => void }[] = [];
  const sceneStarted = () => {
    frameInputs = [];
    for (const l of listeners) l.scene?.();
  };
  const crashed = (text: string) => {
    for (const l of listeners) l.crash?.(text);
  };

  const enter = async (next: SceneDef, carry: Carry | undefined, path?: string) => {
    const { images, shader } = await loadScene(next, options, scripts);
    await usePhysics(next, options);
    scene = next;
    scenePath = path;
    startCarry = carry;
    view?.renderer?.dispose();
    view = new View(next, images, await useRenderer3D(next, options, canvas.width, canvas.height));
    view.touch = touched;
    if (!options.actions) touch?.setActions(actionsUsed([next]));
    view.debug = debug;
    sounds.setScene(next.sounds, next.music);
    soundEvents = 0;
    soundLocals.clear();
    sceneError = screen.use(next.postfx, shader);
    crash = sceneError;
    exitSince = undefined;
    try {
      world = new World(next, { scripts, carry });
      options.recorder?.begin(world, path, carry);
    } catch (err) {
      crash = message(err);
      world = new World({ ...next, entities: [] });
    }
    sceneStarted();
  };
  await enter(firstScene, undefined);

  // Game over starts the whole game again; otherwise R restarts the current scene as it began.
  const restart = () => {
    if (loading) return;
    if (world.lost && scenePath !== undefined) {
      loading = true;
      void enter(entryScene, undefined).finally(() => (loading = false));
      return;
    }
    world = new World(scene, { scripts, carry: startCarry });
    options.recorder?.begin(world, scenePath, startCarry);
    view.reset(world);
    sounds.setScene(scene.sounds, scene.music);
    soundEvents = 0;
    soundLocals.clear();
    crash = sceneError;
    exitSince = undefined;
    sceneStarted();
  };

  const moveOn = (path: string) => {
    if (!options.loadScene) return;
    loading = true;
    const carry = { score: world.score, deaths: world.deaths, lives: world.lives };
    options
      .loadScene(path)
      .then((next) => enter(next, carry, path))
      .catch((err: unknown) => {
        crash = `Could not load the next scene "${path}": ${message(err)}`;
      })
      .finally(() => (loading = false));
  };

  const held = new Set<Action>();
  // Keys pressed since the last step. A tap shorter than one frame still reaches the simulation.
  const tapped = new Set<Action>();
  let toast: { text: string; until: number } | undefined;
  const mark = (kind: MarkKind, text?: string) => {
    options.recorder?.mark(world, kind, text);
    toast = { text: `marked: ${text ?? MARK_LABELS[kind]}`, until: performance.now() + TOAST_MS };
  };
  const onKeyDown = (event: KeyboardEvent) => {
    sounds.unlock();
    if (options.recorder && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const kind = MARK_KEYS[event.code];
      if (kind) return mark(kind);
      if (event.code === "KeyN") {
        // A dialog stops the page, so the game waits while they write. It also hides keyups.
        const text = window.prompt("What do you want to say about this moment?")?.trim();
        held.clear();
        tapped.clear();
        if (text) mark("note", text);
        return;
      }
    }
    if (event.code === "KeyR") return restart();
    if (event.code === "Backquote" && !event.repeat && options.debugKey !== false) {
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

  // Gamepads and touch buttons press the same actions as keys. A press since the last frame is a
  // tap too, so it reaches the simulation even if it's let go before the next step.
  const gamepads = new Gamepads();
  if (options.touch !== false && typeof document !== "undefined") {
    touch = new TouchControls(options.actions ?? actionsUsed([scene]), {
      restart,
      mute: () => (sounds.muted = !sounds.muted),
      touched: () => {
        sounds.unlock();
        touched = view.touch = true;
      },
    });
    document.body.append(touch.root);
  }
  let pressedBefore: ReadonlySet<Action> = new Set();

  const stepOnce = (input: ReadonlySet<Action>) => {
    try {
      world.step(input);
      options.recorder?.step(world, input);
      if (frameInputs.length <= REPLAY_LIMIT) frameInputs.push(inputKey(input));
    } catch (err) {
      // A script threw: freeze the game and show why, instead of failing silently.
      crash = message(err);
      console.error("[ludra]", err);
      options.recorder?.crash(world, input, crash);
      crashed(crash);
    }
    tapped.clear();
    view.step(world, (sound) => sounds.play(sound));
  };

  let last = performance.now();
  let accumulator = 0;
  let raf = 0;
  const frame = (now: number) => {
    if (now > last) fps = fps * 0.9 + (1000 / (now - last)) * 0.1;
    // Paused (by Studio), the clock stands still and only asked-for steps run.
    if (!paused) accumulator += Math.min(MAX_FRAME_TIME, (now - last) / 1000);
    last = now;
    const pad = gamepads.poll();
    if (pad.restart) restart();
    if (pad.mute) sounds.muted = !sounds.muted;
    const pressed = touch && touch.held.size > 0 ? new Set([...pad.actions, ...touch.held]) : pad.actions;
    for (const action of pressed) if (!pressedBefore.has(action)) tapped.add(action);
    pressedBefore = pressed;
    const input = () => (tapped.size > 0 || pressed.size > 0 ? new Set([...held, ...pressed, ...tapped]) : held);
    if (paused) {
      for (; pendingSteps > 0 && !crash && !loading; pendingSteps--) stepOnce(input());
      pendingSteps = 0;
    }
    while (accumulator >= FIXED_DT && !crash && !loading) {
      stepOnce(input());
      accumulator -= FIXED_DT;
    }

    // Sound hooks: the real Web Audio API, once the player has pressed a key.
    const audio = sounds.audio;
    const out = sounds.out;
    if (audio && out && !crash && world.hasHook("sound")) {
      const events = world.events.slice(soundEvents).map(hookEvent);
      soundEvents = world.events.length;
      try {
        for (const e of [...world.entities]) {
          if (!e.script?.module.sound) continue;
          let local = soundLocals.get(e.id);
          if (!local) soundLocals.set(e.id, (local = {}));
          world.callSoundHook(e, {
            audio,
            out,
            time: world.time,
            events,
            play: (name, playOptions) => sounds.play(name, playOptions),
            local,
            random: Math.random,
          });
        }
      } catch (err) {
        console.error("[ludra]", err);
        crash = message(err);
      }
    }
    sounds.tick();

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
      if (!crash) {
        console.error("[ludra]", err);
        crashed(message(err));
      }
      crash ??= message(err);
    }
    if (fade > 0 || loading) {
      ctx.fillStyle = `rgba(0, 0, 0, ${loading ? 1 : fade})`;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    if (crash) drawCrash(ctx, crash);
    if (toast && now < toast.until) drawToast(ctx, toast.text);
    screen.present(world.time);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  if (options.onControl) {
    const control: GameControl = {
      get world() {
        return world;
      },
      get scene() {
        return scene;
      },
      get scenePath() {
        return scenePath ?? options.entryPath ?? "";
      },
      get paused() {
        return paused;
      },
      get fps() {
        return fps;
      },
      get canvas() {
        return screen.output;
      },
      pause: () => {
        paused = true;
        accumulator = 0;
      },
      resume: () => {
        paused = false;
        last = performance.now();
      },
      step: (frames) => {
        if (paused) pendingSteps += frames;
      },
      restart,
      goto: async (path) => {
        if (!options.loadScene) throw new Error("This page can't load other scenes.");
        loading = true;
        try {
          await enter(await options.loadScene(path), undefined, path);
        } finally {
          loading = false;
        }
      },
      mute: (on) => {
        sounds.muted = on;
      },
      focus: () => {
        if (screen.output.tabIndex < 0) screen.output.tabIndex = 0;
        window.focus();
        screen.output.focus();
      },
      highlight: (id) => {
        view.highlight = id ?? undefined;
      },
      pointToWorld: (clientX, clientY) => {
        const seen = view.lastView;
        if (!seen) return undefined;
        const r = screen.output.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return undefined;
        const px = ((clientX - r.left) / r.width) * screen.output.width;
        const py = ((clientY - r.top) / r.height) * screen.output.height;
        return { x: seen.cameraX + px / seen.zoom, y: seen.cameraY + py / seen.zoom };
      },
      hot: async (next) => {
        // Everything that waits first, while the old version plays on; then the swap, in one go.
        const { images, shader } = await loadScene(next, options, scripts);
        await usePhysics(next, options);
        const renderer = await useRenderer3D(next, options, canvas.width, canvas.height);
        const replayed = replayScene(next, frameInputs, { scripts, ...(startCarry ? { carry: startCarry } : {}) });
        const soundChanged = JSON.stringify([scene.sounds, scene.music]) !== JSON.stringify([next.sounds, next.music]);
        if (scenePath === undefined) entryScene = next;
        scene = next;
        world = replayed.world;
        const highlighted = view.highlight;
        view.renderer?.dispose();
        view = new View(next, images, renderer);
        view.touch = touched;
        view.debug = debug;
        view.highlight = highlighted;
        if (!options.actions) touch?.setActions(actionsUsed([next]));
        if (soundChanged || replayed.result !== "kept") sounds.setScene(next.sounds, next.music);
        soundEvents = replayed.result === "kept" ? world.events.length : 0;
        if (replayed.result !== "kept") soundLocals.clear();
        sceneError = screen.use(next.postfx, shader);
        crash = sceneError;
        exitSince = undefined;
        if (replayed.result === "kept") return { result: "kept", frame: world.frame };
        sceneStarted();
        return { result: "restarted", frame: world.frame, reason: replayed.reason };
      },
      on: (listener) => {
        listeners.push(listener);
      },
    };
    options.onControl(control);
  }

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    touch?.dispose();
  };
}

export interface CaptureOptions extends GameOptions {
  /** Input script, e.g. `"right:1s, jump:0.4s"`. See `InputScript`. */
  inputs?: string;
  /** Simulation frames to capture (60 per second). Frame 0 is the starting state. */
  frames: readonly number[];
  /** A debugging view instead of the scene's camera (3D scenes only). */
  camera?: CameraView;
  /** Also draws each frame once per group with those entities left out, to see what they add. */
  hide?: readonly (readonly string[])[];
  /** What the run starts with from the scene before, as a recorded take did. */
  carry?: { score?: number; deaths?: number; lives?: number };
}

export interface CapturedFrame {
  frame: number;
  time: number;
  /** PNG as a data URL. */
  png: string;
  /**
   * The same moment for each group in CaptureOptions.hide, in order, and a drawing of the whole
   * frame right after it. Render hooks can move things on with every drawing, so only drawings
   * next to each other can be compared.
   */
  without?: { png: string; after: string }[];
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
  const view = new View(scene, images, await useRenderer3D(scene, options, canvas.width, canvas.height));
  view.debug = options.debug ?? false;
  view.steady = options.hide !== undefined;
  if (options.camera) {
    if (!view.renderer) throw new Error("A camera view only works on 3D scenes; 2D scenes always show the whole frame their camera sees.");
    view.renderer.view = options.camera;
  }
  const world = new World(scene, { scripts, carry: options.carry });
  const script = InputScript.parse(options.inputs ?? "");
  const wanted = new Set(options.frames);
  const last = Math.max(0, ...options.frames);
  const captured: CapturedFrame[] = [];

  for (let frame = 0; ; frame++) {
    if (wanted.has(frame)) {
      if (view.renderer?.settle) {
        // Let render hooks start their loads, wait for them, then draw the real frame.
        view.renderer.render(world);
        await view.renderer.settle();
      }
      view.draw(screen.ctx, world, false, false);
      // A map shows where things are, so it skips the scene's shader along with its lighting.
      if (options.camera?.mode !== "map") screen.present(world.time);
      const png = (options.camera?.mode === "map" ? canvas : screen.output).toDataURL("image/png");
      const drawing = (hidden: readonly string[]) => {
        view.hidden = new Set(hidden);
        view.draw(screen.ctx, world, false, false);
        screen.present(world.time);
        return screen.output.toDataURL("image/png");
      };
      const without = options.hide?.map((ids) => ({ png: drawing(ids), after: drawing([]) }));
      captured.push({ frame, time: frame * FIXED_DT, png, without });
    }
    if (frame >= last) break;
    world.step(script.at(frame));
    view.step(world, () => {});
  }
  return captured;
}

/** Tells the player their mark was kept, without getting in the way of the game. */
function drawToast(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.save();
  ctx.font = "600 15px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = ctx.measureText(text).width + 28;
  const x = ctx.canvas.width / 2;
  ctx.fillStyle = "rgba(10, 12, 18, 0.8)";
  ctx.fillRect(x - width / 2, 14, width, 30);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, 29);
  ctx.restore();
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

async function loadImages(scene: SceneDef, assetUrl: AssetUrl): Promise<Map<string, HTMLImageElement>> {
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
          image.src = assetUrl(path);
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
  /** Blocks with tile variants, painted once. */
  private readonly tiled = new Map<string, HTMLCanvasElement>();
  /** Frames each platformer has been off the ground, so a one-frame bump doesn't flash the fall pose. */
  private readonly airborne = new Map<string, number>();
  /** Where joints to a point in the world were first seen, to draw them in the debug view. */
  private readonly jointOrigins = new Map<string, { x: number; y: number }>();
  /** Draw colliders, sensors, joints and ids over the game. */
  debug = false;
  /** On-screen touch buttons are showing. */
  touch = false;
  /** Studio's selection, outlined in the game (2D). Never set in a build. */
  highlight: string | undefined;
  /** The camera of the last 2D frame drawn, to turn a click into a world point. */
  lastView: DrawContext["view"] | undefined;

  private drawHighlight(ctx: CanvasRenderingContext2D, world: World, zoom: number): void {
    const e = world.entities.find((x) => x.id === this.highlight);
    if (!e) return;
    const b = entityBox(e);
    const pad = 3 / zoom;
    ctx.save();
    ctx.lineWidth = 2 / zoom;
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.lineDashOffset = 5 / zoom;
    ctx.strokeStyle = "#ffd24a";
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.restore();
  }
  /** Entities left out of the drawing. The game still runs them. */
  hidden: ReadonlySet<string> = new Set();
  /** Draw without shake, so two drawings of one moment differ only in what was hidden. */
  steady = false;
  private shake = 0;
  private handledEvents = 0;
  /** Follows the player and blends between camera zones, one simulation step at a time. */
  private readonly camera = new CameraRig();
  /** The canvas size, known once the first frame is drawn. */
  private size: { width: number; height: number } | undefined;
  private readonly scene: SceneDef;
  private readonly images: Map<string, HTMLImageElement>;

  /** Whether the scene can award points at all, so the default HUD can leave the score out. */
  private readonly scoring: boolean;

  /** 3D scenes: draws the world; the View adds the HUD on top. */
  readonly renderer: Renderer3D | undefined;

  constructor(scene: SceneDef, images: Map<string, HTMLImageElement>, renderer?: Renderer3D) {
    this.scene = scene;
    this.images = images;
    this.renderer = renderer;
    this.scoring = scene.entities.some(
      (e) => e.components.collectible || (e.components.hazard && Number(e.components.hazard.score) > 0) || Number(e.components.goal?.requireScore) > 0,
    );
  }

  reset(world?: World): void {
    if (world) this.renderer?.reset(world);
    this.camera.reset();
    this.particles.clear();
    this.facing.clear();
    this.emitTimers.clear();
    this.local.clear();
    this.airborne.clear();
    this.jointOrigins.clear();
    this.shake = 0;
    this.handledEvents = 0;
  }

  /** Runs once per simulation step: turns new events into effects, moves the camera and advances particles. */
  step(world: World, playSound: (sound: string) => void): void {
    this.renderer?.step(world);
    if (this.size && !this.renderer) this.camera.update(world.entities, world, this.size, FIXED_DT);
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
    const viewInfo = this.renderer ? this.drawWorld3D(ctx, world) : this.drawWorld(ctx, world);
    // The HUD belongs to the game's camera: over a debugging view it only hides what's being looked at.
    if (!this.renderer?.view) this.drawInterface(ctx, world, muted, continues, viewInfo);
  }

  /** A 3D frame from the renderer, copied in so the interface and postfx go on top. */
  private drawWorld3D(ctx: CanvasRenderingContext2D, world: World): DrawContext["view"] {
    const renderer = this.renderer!;
    const { width, height } = ctx.canvas;
    renderer.debug = this.debug;
    renderer.hidden = this.hidden;
    renderer.render(world);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(renderer.canvas, 0, 0, width, height);
    this.drawLabels(ctx, renderer.labels?.(world) ?? []);
    return { width, height, cameraX: 0, cameraY: 0, zoom: 1, touch: this.touch };
  }

  /** Each name beside its point, with a line back to it when the label had to move away. */
  private drawLabels(ctx: CanvasRenderingContext2D, labels: readonly Label[]): void {
    if (labels.length === 0) return;
    ctx.save();
    ctx.font = "600 12px ui-monospace, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const placed = layoutLabels(labels, (text) => ctx.measureText(text).width, ctx.canvas.width, ctx.canvas.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    for (const label of placed) {
      const x = Math.max(label.textX, Math.min(label.x, label.textX + label.width));
      const y = Math.max(label.textY, Math.min(label.y, label.textY + LABEL_HEIGHT));
      if (Math.hypot(x - label.x, y - label.y) < 12) continue;
      ctx.beginPath();
      ctx.moveTo(label.x, label.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.fillStyle = "#ffffff";
    for (const label of placed) {
      ctx.strokeText(label.text, label.textX, label.textY);
      ctx.fillText(label.text, label.textX, label.textY);
      ctx.fillRect(label.x - 1.5, label.y - 1.5, 3, 3);
    }
    ctx.restore();
  }

  /** The 2D world: backdrop color, sprites and draw hooks under the camera, particles, debug. */
  private drawWorld(ctx: CanvasRenderingContext2D, world: World): DrawContext["view"] {
    const { width: viewWidth, height: viewHeight } = ctx.canvas;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = world.background;
    ctx.fillRect(0, 0, viewWidth, viewHeight);

    // The camera moves with the simulation step (see step); the first frame places it at once.
    this.size = { width: viewWidth, height: viewHeight };
    const camera = this.camera.view ?? this.camera.update(world.entities, world, this.size, 0);
    const zoom = camera.zoom;
    let cameraX = camera.x;
    let cameraY = camera.y;
    if (this.shake > 0 && !this.steady) {
      cameraX += (this.particles.random() - 0.5) * 2 * this.shake;
      cameraY += (this.particles.random() - 0.5) * 2 * this.shake;
    }

    const viewInfo = { width: viewWidth, height: viewHeight, cameraX, cameraY, zoom, touch: this.touch };
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-cameraX, -cameraY);
    const layer = (e: Entity) => e.sprite?.layer ?? 0;
    const visible = world.entities.filter((e) => (e.sprite || e.script?.module.draw) && !this.hidden.has(e.id)).sort((a, b) => layer(a) - layer(b));
    for (const e of visible) {
      if (e.sprite && e.sprite.opacity > 0) {
        ctx.save();
        ctx.globalAlpha *= Math.min(1, e.sprite.opacity);
        if (e.sprite.scale !== 1) {
          // Scale around the entity's center (a pop, a pulse), never its body.
          ctx.translate(e.transform.x, e.transform.y);
          ctx.scale(e.sprite.scale, e.sprite.scale);
          ctx.translate(-e.transform.x, -e.transform.y);
        }
        this.drawSprite(ctx, e, world.time);
        ctx.restore();
      }
      if (e.script?.module.draw) this.drawHook(ctx, world, e, "draw", viewInfo);
    }
    this.particles.draw(ctx);
    if (this.debug) this.drawDebug(ctx, world, zoom);
    if (this.highlight) this.drawHighlight(ctx, world, zoom);
    ctx.restore();
    this.lastView = viewInfo;
    return viewInfo;
  }

  /** The HUD: the game's own drawUI hooks, or the default one with its end screens. */
  private drawInterface(ctx: CanvasRenderingContext2D, world: World, muted: boolean, continues: boolean, viewInfo: DrawContext["view"]): void {
    const { width: viewWidth, height: viewHeight } = ctx.canvas;
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
    // On a touch screen the buttons for these are in that corner.
    if (!this.touch) ctx.fillText(`M: sound ${muted ? "off" : "on"} · R: restart`, viewWidth - 16, 28);

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
        pixelText: (text, x, y, options) => pixelText(ctx, text, x, y, options),
      });
    } finally {
      // Whatever the hook changed (transform, alpha, blend mode, filter) ends with it.
      ctx.restore();
    }
  }

  /** The image to repeat. With `variants`, the block once painted cell by cell, so no pattern shows; the cell's place picks its variant. */
  private tiledImage(e: Entity, image: HTMLImageElement, width: number, height: number): HTMLImageElement | HTMLCanvasElement {
    const sprite = e.sprite!;
    if (sprite.variants.length === 0) return image;
    const key = `${e.id}|${width}x${height}`;
    const painted = this.tiled.get(key);
    if (painted) return painted;
    const choices = [image, ...sprite.variants.flatMap((path) => this.images.get(path) ?? [])];
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width);
    canvas.height = Math.ceil(height);
    const g = canvas.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    const left = Math.floor((e.transform.x - width / 2) / image.naturalWidth);
    const top = Math.floor((e.transform.y - height / 2) / image.naturalHeight);
    for (let row = 0; row * image.naturalHeight < height; row++) {
      for (let column = 0; column * image.naturalWidth < width; column++) {
        const pick = tileHash(left + column, top + row) % choices.length;
        g.drawImage(choices[pick]!, column * image.naturalWidth, row * image.naturalHeight);
      }
    }
    this.tiled.set(key, canvas);
    return canvas;
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
      ctx.save();
      ctx.translate(e.transform.x, e.transform.y);
      if (rotation) ctx.rotate(rotation * DEGREES);
      ctx.beginPath();
      if (sprite.shape === "circle" && e.body?.shape !== "circle") ctx.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
      else if (e.body) traceShape(ctx, e.body, width, height);
      else ctx.rect(-width / 2, -height / 2, width, height);
      if (e.body?.shape === "polyline") {
        // A line has no inside: draw it as a thick stroke.
        ctx.strokeStyle = sprite.color;
        ctx.lineWidth = 6;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
      } else ctx.fill();
      ctx.restore();
      return;
    }

    if (sprite.tile) {
      const pattern = ctx.createPattern(this.tiledImage(e, image, width, height), "repeat");
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
    // Camera zones: a violet dashed frame with the mode in a corner.
    for (const e of world.entities) {
      const z = e.cameraZone;
      if (!z) continue;
      ctx.setLineDash([10 / zoom, 6 / zoom]);
      ctx.strokeStyle = "#b10dc9";
      ctx.strokeRect(e.transform.x - z.width / 2, e.transform.y - z.height / 2, z.width, z.height);
      ctx.setLineDash([]);
      ctx.fillStyle = "#b10dc9";
      ctx.textAlign = "left";
      ctx.fillText(`${e.id} (${z.mode}${z.zoom ? ` ×${z.zoom}` : ""})`, e.transform.x - z.width / 2 + 6 / zoom, e.transform.y - z.height / 2 + 14 / zoom);
      ctx.textAlign = "center";
    }
    for (const e of world.entities) {
      const b = e.body;
      if (!b) continue;
      const player = !!(e.platformer || e.topdown);
      const color = b.sensor ? "#2ecc40" : player ? "#ff4136" : b.type === "static" ? "#7fdbff" : b.type === "kinematic" ? "#ff851b" : "#ffdc00";
      ctx.save();
      ctx.translate(e.transform.x, e.transform.y);
      ctx.rotate(e.transform.rotation * DEGREES);
      ctx.beginPath();
      traceShape(ctx, b);
      ctx.setLineDash(b.sensor ? [4 / zoom, 3 / zoom] : []);
      ctx.strokeStyle = color;
      ctx.fillStyle = `${color}22`;
      if (b.shape !== "polyline") ctx.fill();
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
      for (const joint of e.joints ?? []) {
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

/** The same number for the same cell, with no pattern a player could see between neighbors. */
function tileHash(column: number, row: number): number {
  let h = Math.imul(column, 73856093) ^ Math.imul(row, 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function recentEvents(world: World, name: string | undefined, seconds: number): DrawEvent[] {
  const since = world.time - seconds;
  const result: DrawEvent[] = [];
  // Events are in time order, so walk back until they get too old.
  for (let i = world.events.length - 1; i >= 0; i--) {
    const event = world.events[i]!;
    if (event.time < since) break;
    if (name !== undefined && (event.type === "custom" ? event.name : event.type) !== name) continue;
    result.push(hookEvent(event));
  }
  return result.reverse();
}

/** A game event as draw and sound hooks see it. */
function hookEvent(event: GameEvent): DrawEvent {
  // Custom events carry what the script passed; built-in ones their own details (item, enemy, checkpoint...).
  const { type: _type, frame: _frame, time, x, y, entity, ...details } = event as GameEvent & { data?: unknown };
  const data = event.type === "custom" ? event.data : details;
  return { name: event.type === "custom" ? event.name : event.type, time, x, y, entity, data };
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

/** Traces a body's collider shape, centered on the origin, into the current path. */
function traceShape(ctx: CanvasRenderingContext2D, body: Body, width = body.width, height = body.height): void {
  if (body.shape === "circle") ctx.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
  else if (body.shape === "capsule") ctx.roundRect(-width / 2, -height / 2, width, height, Math.min(width, height) / 2);
  else if ((body.shape === "polygon" || body.shape === "polyline") && body.points.length > 1) {
    body.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x!, y!) : ctx.lineTo(x!, y!)));
    if (body.shape === "polygon") ctx.closePath();
  } else ctx.rect(-width / 2, -height / 2, width, height);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
