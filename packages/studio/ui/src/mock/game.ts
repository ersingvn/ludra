// The mock game page (mock-game.html): plays "Lantern Steps" with a bot at the keys and speaks the game
// link from docs/studio.md, so the UI can be built and screenshotted with no server. It is not the engine.

import { applyOp, type GameOp } from "./edits.ts";
import { mockScene, MOCK_PROJECT, type MockEntity } from "./scene.ts";

const W = 960;
const H = 540;
const G = 1800;
const SCENE = MOCK_PROJECT.entry;

const canvas = document.querySelector("canvas")!;
const ctx = canvas.getContext("2d")!;

let entities: MockEntity[] = [];
let frame = 0;
let paused = false;
let pendingSteps = 0;
let won = false;
let lost = false;
let score = 0;
let lives = 3;
let deaths = 0;
let reached = false;
let endTimer = 0;
let inspected: string | null = null;
let highlighted: string | null = null;
let picking = false;
let lastEntityJson = "";
let fps = 60;
let drawn = 0;
let fpsClock = performance.now();
const removed = new Set<string>();

// The viewport tools (docs/editor.md, part B): what Studio asks the game to draw, all presentation.
let preview: { id: string; x: number; y: number } | null = null;
let ghost: { prefab?: string; components?: Record<string, any>; x: number; y: number } | null = null;
let grid = 0;
let look: { x: number; y: number; zoom: number } | null = null;
let lastView = "";

/** The camera: the whole level, or Studio's own (F) when it looks at something. */
function camera(): { x: number; y: number; zoom: number } {
  return look ? { x: look.x - W / look.zoom / 2, y: look.y - H / look.zoom / 2, zoom: look.zoom } : { x: 0, y: 0, zoom: 1 };
}

/** Where the game is drawn in the page: the letterboxed area, in CSS px and canvas px. */
function stageRect(): { s: number; ox: number; oy: number } {
  const s = Math.min(canvas.width / W, canvas.height / H);
  return { s, ox: (canvas.width - W * s) / 2, oy: (canvas.height - H * s) / 2 };
}

function sendView(force = false): void {
  if (canvas.width === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const { s, ox, oy } = stageRect();
  const cam = camera();
  const r = (n: number) => Math.round(n * 100) / 100;
  const view = { cameraX: r(cam.x), cameraY: r(cam.y), zoom: cam.zoom, width: W, height: H, rect: { left: r(ox / dpr), top: r(oy / dpr), width: r((W * s) / dpr), height: r((H * s) / dpr) } };
  const key = JSON.stringify(view);
  if (!force && key === lastView) return;
  lastView = key;
  post("view", view);
}

/** The smallest entity under a world point, as the engine's pick does. */
function entityAt(x: number, y: number): MockEntity | undefined {
  return live()
    .filter((e) => e.components.body || e.components.emitter)
    .map((e) => ({ e, b: boundsOf(e) }))
    .filter(({ b }) => x >= b.l - 3 && x <= b.r + 3 && y >= b.t - 3 && y <= b.b + 3)
    .sort((a, b) => (a.b.r - a.b.l) * (a.b.b - a.b.t) - (b.b.r - b.b.l) * (b.b.b - b.b.t))[0]?.e;
}

function drawGrid(cam: { x: number; y: number; zoom: number }): void {
  let step = grid;
  while (step * cam.zoom < 6) step *= 2;
  const right = cam.x + W / cam.zoom;
  const bottom = cam.y + H / cam.zoom;
  ctx.save();
  ctx.lineWidth = 1 / cam.zoom;
  for (let x = Math.floor(cam.x / step) * step; x <= right; x += step) {
    ctx.strokeStyle = Math.round(x / step) % 5 === 0 ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.09)";
    ctx.beginPath();
    ctx.moveTo(x, cam.y);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let y = Math.floor(cam.y / step) * step; y <= bottom; y += step) {
    ctx.strokeStyle = Math.round(y / step) % 5 === 0 ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.09)";
    ctx.beginPath();
    ctx.moveTo(cam.x, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** A mock prefab's components: those of the first entity in the level made from it. */
function prefabComponents(prefab: string): Record<string, any> {
  const name = (p: string) => p.replace(/^.*\//, "").replace(/\.prefab\.json$/, "");
  const from = mockScene().find((e) => e.prefab && name(e.prefab) === name(prefab));
  return from ? JSON.parse(JSON.stringify(from.components)) : {};
}

function drawGhost(g: NonNullable<typeof ghost>, zoom: number): void {
  // A prefab looks like the first entity made from it; otherwise its own components say its size and color.
  const c: Record<string, any> = { ...(g.prefab ? prefabComponents(g.prefab) : {}), ...(g.components ?? {}) };
  const w = Number(c.sprite?.width || c.body?.width || 32);
  const h = Number(c.sprite?.height || c.body?.height || 32);
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = typeof c.sprite?.color === "string" ? c.sprite.color : "#7fdbff";
  ctx.fillRect(g.x - w / 2, g.y - h / 2, w, h);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([5 / zoom, 3 / zoom]);
  ctx.strokeStyle = "#ffd24a";
  ctx.strokeRect(g.x - w / 2, g.y - h / 2, w, h);
  ctx.restore();
}

function post(type: string, fields: Record<string, unknown> = {}): void {
  parent.postMessage({ ludra: 1, type, ...fields }, "*");
}

const byId = (id: string) => entities.find((e) => e.id === id);
const live = () => entities.filter((e) => !removed.has(e.id));

function start(): void {
  entities = mockScene();
  removed.clear();
  frame = 0;
  won = lost = false;
  score = 0;
  lives = 3;
  reached = false;
  endTimer = 0;
  post("ready", { scene: SCENE, dimensions: 2, width: W, height: H, physics: "arcade" });
  sendEntities();
  sendStatus();
}

function sendEntities(): void {
  post("entities", {
    list: live().map((e) => ({
      id: e.id,
      name: e.name,
      prefab: e.prefab,
      parent: e.parent,
      components: Object.keys(e.components),
      x: e.components.transform?.x ?? 0,
      y: e.components.transform?.y ?? 0,
    })),
  });
}

function sendStatus(): void {
  post("status", { frame, paused, won, lost, score, lives, deaths, fps });
  sendView();
}

function sendEntity(force = false): void {
  if (!inspected) return;
  const e = byId(inspected);
  const data = e && !removed.has(e.id) ? { id: e.id, name: e.name, prefab: e.prefab, components: e.components } : null;
  const json = JSON.stringify(data);
  if (!force && json === lastEntityJson) return;
  lastEntityJson = json;
  post("entity", { id: inspected, data });
}

function event(type: string, fields: Record<string, unknown> = {}): void {
  post("event", { event: { type, frame, ...fields } });
}

// Simulation

interface Box { l: number; r: number; t: number; b: number }
function box(e: MockEntity): Box | null {
  const t = e.components.transform;
  const b = e.components.body;
  if (!t || !b) return null;
  return { l: t.x - b.width / 2, r: t.x + b.width / 2, t: t.y - b.height / 2, b: t.y + b.height / 2 };
}
const overlap = (a: Box, b: Box) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

function solids(): Box[] {
  return live().filter((e) => e.components.body?.type === "static" && !e.components.hazard).map((e) => box(e)!);
}

function die(cause: string): void {
  deaths++;
  lives--;
  event("die", { entity: "player", cause });
  const p = byId("player")!.components;
  if (lives <= 0) {
    lost = true;
    endTimer = 90;
    return;
  }
  const [x, y] = reached ? byId("checkpoint")!.components.checkpoint.respawn : [80, 482];
  p.transform.x = x;
  p.transform.y = y - 10;
  p.body.vx = 0;
  p.body.vy = 0;
}

function step(): void {
  frame++;
  if (won || lost) {
    if (--endTimer <= 0) start();
    return;
  }
  const dt = 1 / 60;
  const player = byId("player")!;
  const p = player.components;
  const pb = box(player)!;
  const ground = solids();

  // Patrols
  for (const e of live()) {
    const pat = e.components.patrol;
    if (!pat) continue;
    const b = e.components.body;
    b.vx = Math.sign(b.vx || 1) * pat.speed;
    e.components.transform.x += b.vx * dt;
    if (e.components.transform.x > pat.to) { e.components.transform.x = pat.to; b.vx = -pat.speed; }
    if (e.components.transform.x < pat.from) { e.components.transform.x = pat.from; b.vx = pat.speed; }
  }

  // The bot: run right, jump at ledges, slimes and spikes.
  let jump = false;
  if (p.body.onGround) {
    for (const g of ground) {
      const ahead = g.l - pb.r;
      if (g.t < pb.b - 10 && g.t > pb.b - 110 && ahead > -4 && ahead < 46) jump = true;
    }
    for (const e of live()) {
      if (!e.components.hazard) continue;
      const hb = box(e)!;
      const ahead = hb.l - pb.r;
      if (Math.abs(hb.b - pb.b) < 20 && ahead > 0 && ahead < (e.components.patrol ? 70 : 34)) jump = true;
    }
    // The platform underfoot: the one whose top the feet are on.
    const cur = ground.find((g) => Math.abs(pb.b - g.t) < 2 && pb.r > g.l && pb.l < g.r);
    if (cur && cur.r - pb.r < 2 && cur.t < 500) jump = true;
    // Jumping a slime only makes sense when there is floor to land on.
    if (jump && cur && cur.t < 500 && pb.r + 150 > cur.r + 30 && cur.r - pb.r >= 2) {
      const ledgeAhead = ground.some((g) => g.t < pb.b - 10 && g.l - pb.r > -4 && g.l - pb.r < 46);
      if (!ledgeAhead) jump = false;
    }
  }
  p.body.vx = p.platformer.speed;
  if (jump) {
    p.body.vy = -p.platformer.jumpSpeed;
    p.body.onGround = false;
    event("jump", { entity: "player" });
  }
  p.body.vy = Math.min(p.body.vy + G * dt, 900);

  p.transform.x = Math.min(W - 13, p.transform.x + p.body.vx * dt);
  let b = box(player)!;
  for (const g of ground) {
    if (!overlap(b, g)) continue;
    if (p.body.vx > 0) p.transform.x -= b.r - g.l;
    else p.transform.x += g.r - b.l;
    b = box(player)!;
  }
  p.transform.y += p.body.vy * dt;
  b = box(player)!;
  p.body.onGround = false;
  for (const g of ground) {
    if (!overlap(b, g)) continue;
    if (p.body.vy > 0) {
      p.transform.y -= b.b - g.t;
      p.body.onGround = true;
    } else p.transform.y += g.b - b.t;
    p.body.vy = 0;
    b = box(player)!;
  }

  // What the player touches
  for (const e of live()) {
    if (e === player) continue;
    const eb = box(e);
    if (!eb || !overlap(b, eb)) continue;
    const c = e.components;
    if (c.collectible) {
      removed.add(e.id);
      score += c.collectible.value;
      event("collect", { entity: e.id, value: c.collectible.value });
      sendEntities();
    } else if (c.hazard) {
      if (c.hazard.stompable && p.body.vy > 0 && b.b - eb.t < 14) {
        removed.add(e.id);
        p.body.vy = -420;
        event("stomp", { entity: e.id });
        sendEntities();
      } else {
        die(e.id);
        return;
      }
    } else if (c.checkpoint && !reached) {
      reached = true;
      event("checkpoint", { entity: e.id });
    } else if (c.goal) {
      won = true;
      endTimer = 120;
      event("win", { entity: e.id });
    }
  }
  if (p.transform.y > 600) die("fell");
}

// Drawing

const stars = Array.from({ length: 70 }, (_, i) => ({ x: (i * 137.5) % W, y: ((i * 71.3) % 260) + 6, r: (i % 3) * 0.4 + 0.5 }));
const flies = Array.from({ length: 14 }, (_, i) => ({ x: (i * 211) % W, y: 120 + ((i * 97) % 260), p: i * 1.7 }));

function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(innerWidth * dpr);
  const ch = Math.round(innerHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const s = Math.min(cw / W, ch / H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0b0d14";
  ctx.fillRect(0, 0, cw, ch);
  ctx.setTransform(s, 0, 0, s, (cw - W * s) / 2, (ch - H * s) / 2);
  const t = frame / 60;

  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#111833");
  sky.addColorStop(0.55, "#3b2d5a");
  sky.addColorStop(1, "#c46e4e");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  for (const st of stars) {
    ctx.globalAlpha = 0.35 + 0.35 * Math.sin(t * 1.3 + st.x);
    ctx.fillStyle = "#fff6e0";
    ctx.fillRect(st.x, st.y, st.r, st.r);
  }
  ctx.globalAlpha = 1;
  const cam = camera();
  ctx.setTransform(s * cam.zoom, 0, 0, s * cam.zoom, (cw - W * s) / 2 - cam.x * s * cam.zoom, (ch - H * s) / 2 - cam.y * s * cam.zoom);
  // A dragged entity is drawn where it's being dragged to; the world keeps its own place.
  const moved = preview ? byId(preview.id)?.components.transform : undefined;
  const kept = moved ? { x: moved.x, y: moved.y } : undefined;
  if (moved && preview) {
    moved.x = preview.x;
    moved.y = preview.y;
  }
  hills(380, 70, "#2b2347", 0.004, 1.1);
  hills(430, 55, "#231c39", 0.007, 2.3);

  for (const e of live()) {
    const c = e.components;
    const b = box(e);
    if (c.body?.type === "static" && !c.hazard && b) platformArt(b, e.id === "ground");
  }
  for (const e of live()) {
    const c = e.components;
    const b = box(e);
    if (!b) continue;
    if (c.hazard && !c.patrol) spikes(b);
    else if (c.patrol) slime(b, t, c.body.vx);
    else if (c.collectible) coinArt(c.transform.x, c.transform.y + Math.sin(t * 4 + c.transform.x) * 3);
    else if (c.checkpoint) post2(b, reached);
    else if (c.goal) beacon(b, t);
  }
  for (const f of flies) {
    const x = f.x + Math.sin(t * 0.6 + f.p) * 24;
    const y = f.y + Math.cos(t * 0.8 + f.p) * 14;
    glow(x, y, 7, "rgba(217,249,157,0.35)");
    ctx.fillStyle = "#e9ffc0";
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }
  const player = byId("player");
  if (player) wren(box(player)!, t, player.components.body);

  if (grid > 0) drawGrid(cam);
  if (ghost) drawGhost(ghost, cam.zoom);
  if (highlighted) outline(highlighted);
  if (moved && kept) {
    moved.x = kept.x;
    moved.y = kept.y;
  }
  ctx.setTransform(s, 0, 0, s, (cw - W * s) / 2, (ch - H * s) / 2);
  if (paused) {
    ctx.fillStyle = "rgba(10,12,20,0.18)";
    ctx.fillRect(0, 0, W, H);
  }
}

function hills(base: number, amp: number, color: string, freq: number, phase: number): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 16) ctx.lineTo(x, base - Math.sin(x * freq + phase) * amp - Math.sin(x * freq * 2.7) * amp * 0.3);
  ctx.lineTo(W, H);
  ctx.fill();
}

function platformArt(b: Box, isGround: boolean): void {
  ctx.fillStyle = isGround ? "#3f3024" : "#6b4c34";
  ctx.fillRect(b.l, b.t, b.r - b.l, b.b - b.t);
  ctx.fillStyle = isGround ? "#5d7a3a" : "#a07a52";
  ctx.fillRect(b.l, b.t, b.r - b.l, 4);
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  for (let x = b.l + 20; x < b.r; x += 32) ctx.fillRect(x, b.t + 6, 1, b.b - b.t - 6);
}

function spikes(b: Box): void {
  ctx.fillStyle = "#cfd6de";
  const n = Math.floor((b.r - b.l) / 10);
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    ctx.moveTo(b.l + i * 10, b.b);
    ctx.lineTo(b.l + i * 10 + 5, b.t);
    ctx.lineTo(b.l + i * 10 + 10, b.b);
    ctx.fill();
  }
}

function slime(b: Box, t: number, vx: number): void {
  const squash = Math.sin(t * 8) * 1.5;
  ctx.fillStyle = "#6cc47d";
  ctx.beginPath();
  ctx.ellipse((b.l + b.r) / 2, b.b - 2, (b.r - b.l) / 2 + squash, b.b - b.t - squash, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = "#14301c";
  const dir = Math.sign(vx) * 3;
  ctx.fillRect((b.l + b.r) / 2 - 6 + dir, b.t + 7, 3, 4);
  ctx.fillRect((b.l + b.r) / 2 + 3 + dir, b.t + 7, 3, 4);
}

function coinArt(x: number, y: number): void {
  glow(x, y, 16, "rgba(255,209,102,0.35)");
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff1c1";
  ctx.fillRect(x - 2, y - 4, 2, 7);
}

function post2(b: Box, lit: boolean): void {
  ctx.fillStyle = "#8b96a3";
  ctx.fillRect(b.l + 5, b.t, 3, b.b - b.t);
  ctx.fillStyle = lit ? "#f2a93b" : "#55606d";
  ctx.beginPath();
  ctx.moveTo(b.l + 8, b.t + 2);
  ctx.lineTo(b.l + 22, b.t + 8);
  ctx.lineTo(b.l + 8, b.t + 14);
  ctx.fill();
}

function beacon(b: Box, t: number): void {
  const cx = (b.l + b.r) / 2;
  glow(cx, b.t + 12, 90 + Math.sin(t * 3) * 6, "rgba(255,178,77,0.28)");
  ctx.fillStyle = "#3a2f28";
  ctx.fillRect(cx - 3, b.t + 18, 6, b.b - b.t - 18);
  ctx.fillStyle = "#5a4a3c";
  ctx.fillRect(cx - 9, b.t + 12, 18, 8);
  ctx.fillStyle = "#ffcf7a";
  ctx.beginPath();
  ctx.ellipse(cx, b.t + 6 + Math.sin(t * 9) * 0.8, 6, 9, 0, 0, Math.PI * 2);
  ctx.fill();
}

function wren(b: Box, t: number, body: { vx: number; onGround: boolean }): void {
  const bob = body.onGround ? Math.abs(Math.sin(t * 14)) * 1.5 : 0;
  glow(b.r + 2, b.t + 18, 34, "rgba(255,178,77,0.25)");
  ctx.fillStyle = "#e8eef2";
  roundRect(b.l, b.t - bob, b.r - b.l, b.b - b.t, 7);
  ctx.fillStyle = "#2d3a4a";
  roundRect(b.l + 3, b.t + 5 - bob, b.r - b.l - 6, 11, 4);
  ctx.fillStyle = "#e8eef2";
  ctx.fillRect(b.l + 10, b.t + 8 - bob, 3, 4);
  ctx.fillRect(b.l + 17, b.t + 8 - bob, 3, 4);
  ctx.fillStyle = "#f2a93b";
  ctx.fillRect(b.r - 1, b.t + 15 - bob, 5, 6);
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function glow(x: number, y: number, r: number, color: string): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function boundsOf(e: MockEntity): Box {
  const b = box(e);
  if (b) return b;
  const kids = live().filter((k) => k.parent === e.id).map(boundsOf);
  if (kids.length > 0) return { l: Math.min(...kids.map((k) => k.l)), r: Math.max(...kids.map((k) => k.r)), t: Math.min(...kids.map((k) => k.t)), b: Math.max(...kids.map((k) => k.b)) };
  const t = e.components.transform ?? { x: 0, y: 0 };
  const area = e.components.emitter?.area as [number, number] | undefined;
  if (area) return { l: t.x - area[0] / 2, r: t.x + area[0] / 2, t: t.y - area[1] / 2, b: t.y + area[1] / 2 };
  return { l: t.x - 10, r: t.x + 10, t: t.y - 10, b: t.y + 10 };
}

function outline(id: string): void {
  const e = byId(id);
  if (!e || removed.has(id)) return;
  const b = boundsOf(e);
  const pad = 4;
  ctx.save();
  ctx.strokeStyle = "#f2a93b";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.lineDashOffset = -frame / 3;
  ctx.strokeRect(b.l - pad, b.t - pad, b.r - b.l + pad * 2, b.b - b.t + pad * 2);
  ctx.setLineDash([]);
  ctx.font = "600 11px system-ui, sans-serif";
  const label = e.name ?? e.id;
  const w = ctx.measureText(label).width + 10;
  const y = Math.max(0, b.t - pad - 17);
  ctx.fillStyle = "#f2a93b";
  ctx.fillRect(b.l - pad, y, w, 15);
  ctx.fillStyle = "#1a1408";
  ctx.fillText(label, b.l - pad + 5, y + 11);
  ctx.restore();
}

// Picking

canvas.addEventListener("click", (ev) => {
  if (!picking) return;
  const dpr = window.devicePixelRatio || 1;
  const { s, ox, oy } = stageRect();
  const cam = camera();
  const x = cam.x + (ev.clientX * dpr - ox) / s / cam.zoom;
  const y = cam.y + (ev.clientY * dpr - oy) / s / cam.zoom;
  picking = false;
  canvas.style.cursor = "";
  post("picked", { id: entityAt(x, y)?.id ?? null });
});

// Studio → Game, plus the mock's own "mock-apply" (what a hot reload would do).

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (!m || m.ludra !== 1) return;
  switch (m.type) {
    case "pause": paused = true; sendStatus(); break;
    case "resume": paused = false; sendStatus(); break;
    case "step": pendingSteps += m.frames ?? 1; break;
    case "restart": start(); break;
    case "goto":
      if (m.scene !== SCENE) post("error", { message: `${m.scene} isn't in the mock. Only ${SCENE} plays here.` });
      start();
      break;
    case "inspect": inspected = m.id; lastEntityJson = ""; sendEntity(true); break;
    case "highlight": highlighted = m.id; break;
    case "pick": picking = m.on; canvas.style.cursor = m.on ? "crosshair" : ""; break;
    case "mute": break;
    case "focus": canvas.focus(); break;
    case "mock-apply": apply(m.ops ?? [], m.files ?? []); break;
    case "pickAt": post("picked", { id: entityAt(Number(m.x), Number(m.y))?.id ?? null, ...(m.tag !== undefined ? { tag: m.tag } : {}) }); break;
    case "preview": preview = typeof m.id === "string" && Number.isFinite(m.x) && Number.isFinite(m.y) ? { id: m.id, x: m.x, y: m.y } : null; break;
    case "ghost": ghost = (typeof m.prefab === "string" || (m.components && typeof m.components === "object")) && Number.isFinite(m.x) && Number.isFinite(m.y) ? { prefab: m.prefab, components: m.components, x: m.x, y: m.y } : null; break;
    case "grid": grid = Math.max(0, Number(m.size) || 0); break;
    case "look": look = Number.isFinite(m.x) && Number.isFinite(m.y) && m.zoom > 0 ? { x: m.x, y: m.y, zoom: m.zoom } : null; sendView(true); break;
  }
});

type Op =
  | GameOp
  | { op: "reject"; diagnostics: unknown[] }
  | { op: "restart"; reason: string }
  | { op: "keep" };

function apply(ops: Op[], files: string[]): void {
  for (const op of ops) {
    if (op.op === "reject") {
      post("error", { message: `${files[0]} doesn't pass check`, diagnostics: op.diagnostics });
      post("hot", { result: "rejected", frame, files, reason: "it doesn't pass check" });
      return;
    }
    if (op.op === "restart") {
      start();
      post("hot", { result: "restarted", frame: 0, files, reason: op.reason });
      return;
    }
    if (op.op === "keep") continue;
    // Studio's edits and the agent's: the same changes the scene file got (mock/edits.ts).
    if (op.op === "rename" && inspected === op.id) inspected = op.to;
    // A placed prefab names only its prefab and transform: the game fills in the rest, as the engine does.
    if (op.op === "add" && op.entity.prefab) op.entity.components = { ...prefabComponents(op.entity.prefab), ...op.entity.components };
    applyOp(entities, op);
    if (op.op !== "set" || op.path[0] === "components") sendEntities();
  }
  post("hot", { result: "kept", frame, files });
  sendStatus();
  sendEntity(true);
}

// Loop

let acc = 0;
let last = performance.now();
function loop(now: number): void {
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;
  if (!paused) {
    while (acc >= 1 / 60) {
      acc -= 1 / 60;
      step();
      if (frame % 6 === 0) {
        sendStatus();
        sendEntity();
      }
    }
  } else {
    acc = 0;
    if (pendingSteps > 0) {
      while (pendingSteps > 0) {
        pendingSteps--;
        step();
      }
      sendStatus();
      sendEntity();
    }
  }
  draw();
  // The canvas can move or resize without a status (the window, the panels): keep Studio's map current.
  sendView();
  drawn++;
  if (now - fpsClock >= 1000) {
    fps = Math.round((drawn * 1000) / (now - fpsClock));
    drawn = 0;
    fpsClock = now;
  }
  requestAnimationFrame(loop);
}

start();
requestAnimationFrame(loop);
