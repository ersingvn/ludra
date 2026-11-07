import type { SceneDef } from "./types.ts";

/**
 * What Ludra Studio draws into a 2D game while a person edits it (docs/editor.md): a grid, a drag
 * preview and a placement ghost. Presentation only: none of it reaches the world.
 */

/** Draw an entity at another place than its own, while it is dragged. */
export interface StudioPreview {
  id: string;
  x: number;
  y: number;
}

/** A translucent entity where a placement would go. */
export interface StudioGhost {
  prefab?: string;
  components?: Record<string, unknown>;
  x: number;
  y: number;
}

/** A camera Studio looks through instead of the game's (F frames the selection). */
export interface StudioLook {
  x: number;
  y: number;
  zoom: number;
}

export interface StudioOverlay {
  preview?: StudioPreview;
  ghost?: StudioGhost;
  /** World px between grid lines; 0 is no grid. */
  grid: number;
  look?: StudioLook;
}

/** The components a ghost stands for: its prefab's, with its own on top. */
export function ghostComponents(scene: SceneDef, ghost: StudioGhost): Record<string, Record<string, unknown>> {
  const prefab = ghost.prefab ? (scene.prefabs?.[ghost.prefab]?.components ?? {}) : {};
  const own = (ghost.components ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of new Set([...Object.keys(prefab), ...Object.keys(own)])) {
    const value = own[name] ?? prefab[name];
    if (value && typeof value === "object") out[name] = { ...(prefab[name] ?? {}), ...(own[name] ?? {}) };
  }
  return out;
}

/** Lines every `size` world px over the part of the world in view, with every fifth stronger. */
export function drawGrid(ctx: CanvasRenderingContext2D, size: number, view: { cameraX: number; cameraY: number; zoom: number; width: number; height: number }): void {
  if (!(size > 0)) return;
  const { cameraX, cameraY, zoom } = view;
  const right = cameraX + view.width / zoom;
  const bottom = cameraY + view.height / zoom;
  // Too dense to read: draw every second, fourth... line instead.
  let step = size;
  while (step * zoom < 6) step *= 2;
  ctx.save();
  ctx.lineWidth = 1 / zoom;
  for (const [from, to, vertical] of [
    [cameraX, right, true],
    [cameraY, bottom, false],
  ] as const) {
    for (let at = Math.floor(from / step) * step; at <= to; at += step) {
      const major = Math.round(at / step) % 5 === 0;
      ctx.strokeStyle = major ? "rgba(255, 255, 255, 0.22)" : "rgba(255, 255, 255, 0.09)";
      ctx.beginPath();
      if (vertical) {
        ctx.moveTo(at, cameraY);
        ctx.lineTo(at, bottom);
      } else {
        ctx.moveTo(cameraX, at);
        ctx.lineTo(right, at);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** A placement ghost: the entity's image or color at half strength, a dashed outline and its centre. */
export function drawGhost(ctx: CanvasRenderingContext2D, scene: SceneDef, ghost: StudioGhost, images: ReadonlyMap<string, HTMLImageElement>, zoom: number): void {
  const c = ghostComponents(scene, ghost);
  const body = c.body as { width?: number; height?: number } | undefined;
  const sprite = c.sprite as { width?: number; height?: number; color?: string; image?: string; frameWidth?: number; frameHeight?: number } | undefined;
  const w = Number(sprite?.width || body?.width || 32);
  const h = Number(sprite?.height || body?.height || 32);
  const x = ghost.x - w / 2;
  const y = ghost.y - h / 2;
  ctx.save();
  ctx.globalAlpha = 0.55;
  const image = sprite?.image ? images.get(sprite.image) : undefined;
  if (image) {
    const fw = sprite?.frameWidth || image.naturalWidth;
    const fh = sprite?.frameHeight || image.naturalHeight;
    ctx.drawImage(image, 0, 0, fw, fh, x, y, w, h);
  } else {
    ctx.fillStyle = typeof sprite?.color === "string" ? sprite.color : "#7fdbff";
    ctx.fillRect(x, y, w, h);
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([5 / zoom, 3 / zoom]);
  ctx.strokeStyle = "#ffd24a";
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  const arm = 6 / zoom;
  ctx.beginPath();
  ctx.moveTo(ghost.x - arm, ghost.y);
  ctx.lineTo(ghost.x + arm, ghost.y);
  ctx.moveTo(ghost.x, ghost.y - arm);
  ctx.lineTo(ghost.x, ghost.y + arm);
  ctx.stroke();
  ctx.restore();
}
