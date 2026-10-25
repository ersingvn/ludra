/**
 * The camera: which entity it follows, the zones that take it over, and the blend
 * between them. Presentation only, but it advances with the fixed simulation step,
 * so screenshots of the same moment always frame the same view.
 */

export interface CameraZone {
  width: number;
  height: number;
  mode: "room" | "fixed";
  zoom: number;
  blend: number;
  priority: number;
}

/** What the camera needs to know about an entity. */
export interface CameraSubject {
  id: string;
  transform: { x: number; y: number };
  camera?: { zoom: number };
  cameraZone?: CameraZone;
  platformer?: unknown;
  topdown?: unknown;
}

/** The visible area: top-left corner in world px, and the zoom. */
export interface CameraView {
  x: number;
  y: number;
  zoom: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Where the camera wants to be right now, and which zone (if any) decided it. */
export function cameraGoal(entities: readonly CameraSubject[], world: { width: number; height: number }, view: { width: number; height: number }): { view: CameraView; zone?: CameraSubject } {
  const target = entities.find((e) => e.camera) ?? entities.find((e) => e.platformer || e.topdown);
  let zoom = target?.camera?.zoom ?? 1;
  if (!target) return { view: { x: 0, y: 0, zoom } };
  const { x: tx, y: ty } = target.transform;

  // The zone the target stands in; overlapping ones go by priority, then the last listed.
  let zone: CameraSubject | undefined;
  for (const e of entities) {
    const z = e.cameraZone;
    if (!z || Math.abs(tx - e.transform.x) > z.width / 2 || Math.abs(ty - e.transform.y) > z.height / 2) continue;
    if (!zone || z.priority >= zone.cameraZone!.priority) zone = e;
  }
  if (zone?.cameraZone!.zoom) zoom = zone.cameraZone!.zoom;

  const visibleWidth = view.width / zoom;
  const visibleHeight = view.height / zoom;
  let centerX = tx;
  let centerY = ty;
  if (zone) {
    const z = zone.cameraZone!;
    const { x: zx, y: zy } = zone.transform;
    if (z.mode === "fixed") {
      centerX = zx;
      centerY = zy;
    } else {
      // Keep the view inside the room; a room smaller than the view is centered.
      const slackX = Math.max(0, (z.width - visibleWidth) / 2);
      const slackY = Math.max(0, (z.height - visibleHeight) / 2);
      centerX = clamp(tx, zx - slackX, zx + slackX);
      centerY = clamp(ty, zy - slackY, zy + slackY);
    }
  }
  // Never show outside the world (a world smaller than the view stays at its top-left).
  const x = clamp(centerX - visibleWidth / 2, 0, Math.max(0, world.width - visibleWidth));
  const y = clamp(centerY - visibleHeight / 2, 0, Math.max(0, world.height - visibleHeight));
  return { view: { x, y, zoom }, zone };
}

/** Follows the goal, easing over a zone's `blend` seconds whenever the zone changes. */
export class CameraRig {
  view: CameraView | undefined;
  private zoneId: string | undefined;
  private from: CameraView | undefined;
  private blend = 0;
  private blendTime = 0;

  reset(): void {
    this.view = undefined;
    this.zoneId = undefined;
    this.from = undefined;
  }

  /** Called once per simulation step. */
  update(entities: readonly CameraSubject[], world: { width: number; height: number }, view: { width: number; height: number }, dt: number): CameraView {
    const goal = cameraGoal(entities, world, view);
    const zoneId = goal.zone?.id;
    if (this.view && zoneId !== this.zoneId) {
      // Entering a zone uses its blend; leaving uses the blend of the zone left behind.
      const zone = goal.zone ?? entities.find((e) => e.id === this.zoneId);
      this.blend = zone?.cameraZone?.blend ?? 0;
      this.blendTime = 0;
      this.from = { ...this.view };
    }
    this.zoneId = zoneId;
    if (this.from && this.blendTime < this.blend) {
      this.blendTime = Math.min(this.blend, this.blendTime + dt);
      const t = this.blendTime / this.blend;
      const k = t * t * (3 - 2 * t);
      this.view = {
        x: this.from.x + (goal.view.x - this.from.x) * k,
        y: this.from.y + (goal.view.y - this.from.y) * k,
        zoom: this.from.zoom + (goal.view.zoom - this.from.zoom) * k,
      };
    } else {
      this.from = undefined;
      this.view = goal.view;
    }
    return this.view;
  }
}
