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

/**
 * Runs a scene in a canvas with keyboard controls. The simulation uses the
 * same fixed step as headless runs, so what tests verify is what players get.
 * Returns a function that stops the game.
 */
export function startGame(canvas: HTMLCanvasElement, scene: SceneDef): () => void {
  const world = new World(scene);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is not available.");

  const held = new Set<Action>();
  // Keys pressed since the last step. A tap shorter than one frame still reaches the simulation.
  const tapped = new Set<Action>();
  const onKeyDown = (event: KeyboardEvent) => {
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
    while (accumulator >= FIXED_DT) {
      world.step(tapped.size > 0 ? new Set([...held, ...tapped]) : held);
      tapped.clear();
      accumulator -= FIXED_DT;
    }
    draw(ctx, world);
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

export function draw(ctx: CanvasRenderingContext2D, world: World): void {
  const { width: viewWidth, height: viewHeight } = ctx.canvas;
  ctx.fillStyle = world.background;
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  const target = world.entities.find((e) => e.camera) ?? world.entities.find((e) => e.platformer);
  const zoom = target?.camera?.zoom ?? 1;
  const visibleWidth = viewWidth / zoom;
  const visibleHeight = viewHeight / zoom;
  const cameraX = target ? clamp(target.transform.x - visibleWidth / 2, 0, Math.max(0, world.width - visibleWidth)) : 0;
  const cameraY = target ? clamp(target.transform.y - visibleHeight / 2, 0, Math.max(0, world.height - visibleHeight)) : 0;

  ctx.save();
  ctx.scale(zoom, zoom);
  ctx.translate(-cameraX, -cameraY);
  const visible = world.entities.filter((e) => e.sprite).sort((a, b) => a.sprite!.layer - b.sprite!.layer);
  for (const e of visible) drawSprite(ctx, e);
  ctx.restore();

  ctx.fillStyle = "#ffffff";
  ctx.font = "600 18px system-ui, sans-serif";
  ctx.fillText(`Score ${world.score}`, 16, 30);
}

function drawSprite(ctx: CanvasRenderingContext2D, e: Entity): void {
  const sprite = e.sprite!;
  const width = sprite.width || e.body?.width || 16;
  const height = sprite.height || e.body?.height || 16;
  ctx.fillStyle = sprite.color;
  if (sprite.shape === "circle") {
    ctx.beginPath();
    ctx.ellipse(e.transform.x, e.transform.y, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(e.transform.x - width / 2, e.transform.y - height / 2, width, height);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
