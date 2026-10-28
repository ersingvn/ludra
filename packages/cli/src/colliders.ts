import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { dmath, resolveComponent, type Diagnostic, type Mesh, type SceneDef } from "@ludra/core";
import { readModelGeometry } from "./gltf.ts";
import { isInside, type Project } from "./project.ts";

/**
 * Turns `convex` and `mesh` bodies that name a model into plain points and triangles, written into
 * the scene itself. The geometry is fitted exactly the way @ludra/three fits the drawn model, so the
 * collider sits where the model is drawn. Doing it once here, while the scene is read, means headless
 * runs and the browser get the very same numbers: physics stays deterministic.
 */
export function fillModelColliders(project: Project, scene: SceneDef): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fill = (components: Record<string, unknown> | undefined, at: string) => {
    const body = components?.body as Record<string, unknown> | undefined;
    if (!body || (body.shape !== "convex" && body.shape !== "mesh")) return;
    const own = Array.isArray(body.points) && body.points.length > 0 && (body.shape === "convex" || (Array.isArray(body.triangles) && body.triangles.length > 0));
    if (own) return;
    const rawMesh = components!.mesh as Record<string, unknown> | undefined;
    const path = (typeof body.model === "string" && body.model) || (typeof rawMesh?.model === "string" && rawMesh.model) || "";
    if (!path) return;
    const file = resolve(project.dir, path);
    if (!isInside(project.dir, file) || !existsSync(file)) return; // E_ASSET_MISSING says so
    let geometry: Geometry;
    try {
      geometry = cachedGeometry(file);
    } catch (err) {
      diagnostics.push({
        severity: "error",
        code: "E_MODEL_COLLIDER",
        path: `${at}.components.body.${body.model ? "model" : "shape"}`,
        message: `The collider of ${at} can't be built from "${path}": ${(err as Error).message}`,
        fix: 'Point "body.model" at an uncompressed .glb of the same shape (a simpler one is better for physics), or use another shape.',
      });
      return;
    }
    const mesh = resolveComponent<Mesh>("mesh", rawMesh ?? {});
    const points = fitPoints(geometry.positions, mesh, body);
    if (body.shape === "mesh") {
      body.points = points;
      const triangles: number[][] = [];
      for (let i = 0; i + 2 < geometry.indices.length; i += 3) triangles.push([geometry.indices[i]!, geometry.indices[i + 1]!, geometry.indices[i + 2]!]);
      body.triangles = triangles;
      if (triangles.length > HEAVY_TRIANGLES) {
        diagnostics.push({
          severity: "warning",
          code: "W_COLLIDER_HEAVY",
          path: `${at}.components.body`,
          message: `The collider of ${at} has ${triangles.length} triangles, which slows physics and the scene file down.`,
          fix: 'Set "body.model" to a low-poly version of the model just for collisions.',
        });
      }
    } else {
      // A hull only needs each point once.
      const seen = new Set<string>();
      body.points = points.filter((p) => {
        const key = p.join(",");
        return !seen.has(key) && (seen.add(key), true);
      });
    }
  };
  scene.entities.forEach((entity, i) => fill(entity.components as Record<string, unknown>, `entities[${i}]`));
  for (const [name, prefab] of Object.entries(scene.prefabs ?? {})) fill(prefab.components as Record<string, unknown> | undefined, `prefabs.${name}`);
  return diagnostics;
}

const HEAVY_TRIANGLES = 50_000;

interface Geometry {
  positions: Float32Array;
  indices: Uint32Array;
}

const cache = new Map<string, { stamp: string; geometry: Geometry }>();

function cachedGeometry(file: string): Geometry {
  const stat = statSync(file);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.geometry;
  const geometry = readModelGeometry(file);
  cache.set(file, { stamp, geometry });
  return geometry;
}

/** The renderer's fit (turn, then fit to the body, then scale and offset), applied to every vertex. */
function fitPoints(positions: Float32Array, mesh: Mesh, body: Record<string, unknown>): number[][] {
  const DEG = Math.PI / 180;
  const [ax, ay, az] = [(mesh.turn.x ?? 0) * DEG, (mesh.turn.y ?? 0) * DEG, (mesh.turn.z ?? 0) * DEG];
  const [sx, cx, sy, cy, sz, cz] = [dmath.sin(ax), dmath.cos(ax), dmath.sin(ay), dmath.cos(ay), dmath.sin(az), dmath.cos(az)];
  // Euler order YXZ, as three.js applies it: v' = Ry · Rx · Rz · v.
  const turned: number[][] = [];
  for (let i = 0; i < positions.length; i += 3) {
    let x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    [x, y] = [x * cz - y * sz, x * sz + y * cz];
    [y, z] = [y * cx - z * sx, y * sx + z * cx];
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    turned.push([x, y, z]);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of turned) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k]!, p[k]!)), (max[k] = Math.max(max[k]!, p[k]!));
  const empty = turned.length === 0;
  const size = empty ? [1, 1, 1] : [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!];

  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const w = mesh.width || num(body.width);
  const h = mesh.height || num(body.height);
  const d = mesh.depth || num(body.depth) || num(body.width);
  const fitted = (target: number, own: number) => (target > 0 && own > 0 ? target / own : 1);
  let scale = [1, 1, 1];
  if (mesh.fit === "height") scale = [fitted(h, size[1]!), fitted(h, size[1]!), fitted(h, size[1]!)];
  else if (mesh.fit === "box") scale = [fitted(w, size[0]!), fitted(h, size[1]!), fitted(d, size[2]!)];
  scale = scale.map((s) => s * mesh.scale);

  const anchor = mesh.fit === "none" || empty ? [0, 0, 0] : [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2];
  const shift = [num(mesh.offset.x), num(mesh.offset.y) + (mesh.fit !== "none" && h > 0 ? -h / 2 : 0), num(mesh.offset.z)];
  return turned.map((p) => p.map((v, k) => round((v - anchor[k]!) * scale[k]! + shift[k]!)));
}

/** Tenths of a millimetre: plenty for physics, and it keeps the scene JSON small. */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4 || 0;
}
