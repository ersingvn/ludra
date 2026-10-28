import type { DrawContext, Script } from "@ludra/core";

const SERIF = "Cinzel, Georgia, serif";
const SANS = "Nunito, system-ui, sans-serif";

type G = DrawContext["g"];

/** Text with a soft dark glow behind it, so it reads over the sky and the water alike. */
function label(g: G, text: string, x: number, y: number, size: number, color = "#f3ecff", font = SERIF, weight = 600): void {
  g.font = `${weight} ${size}px ${font}`;
  g.shadowColor = "rgba(5, 4, 20, 0.9)";
  g.shadowBlur = size * 0.45;
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.shadowBlur = 0;
}

/** A crescent moon: the shard counter's icon, gold when found, a faint outline when not. */
function crescent(g: G, x: number, y: number, r: number, found: boolean, glow: number): void {
  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.arc(x + r * 0.45, y - r * 0.2, r * 0.82, 0, Math.PI * 2, true);
  if (found) {
    const fill = g.createLinearGradient(x - r, y - r, x + r, y + r);
    fill.addColorStop(0, "#fff6d8");
    fill.addColorStop(1, "#ffc861");
    g.fillStyle = fill;
    g.shadowColor = "#ffd27a";
    g.shadowBlur = 10 + glow * 18;
    g.fill("evenodd");
  } else {
    g.fillStyle = "rgba(200, 200, 255, 0.12)";
    g.fill("evenodd");
    g.strokeStyle = "rgba(220, 220, 255, 0.35)";
    g.lineWidth = 1;
    g.stroke();
  }
  g.restore();
}

/** A small flame for each life. */
function flame(g: G, x: number, y: number, size: number, lit: boolean, time: number): void {
  const sway = lit ? Math.sin(time * 6 + x) * size * 0.08 : 0;
  g.beginPath();
  g.moveTo(x + sway, y - size);
  g.bezierCurveTo(x + size * 0.7, y - size * 0.2, x + size * 0.55, y + size * 0.55, x, y + size * 0.6);
  g.bezierCurveTo(x - size * 0.55, y + size * 0.55, x - size * 0.7, y - size * 0.2, x + sway, y - size);
  if (lit) {
    const fill = g.createLinearGradient(x, y - size, x, y + size * 0.6);
    fill.addColorStop(0, "#fff2c0");
    fill.addColorStop(0.6, "#ffa640");
    fill.addColorStop(1, "#e2502e");
    g.fillStyle = fill;
    g.shadowColor = "#ff9a40";
    g.shadowBlur = 12;
  } else {
    g.fillStyle = "rgba(200, 200, 255, 0.14)";
  }
  g.fill();
  g.shadowBlur = 0;
}

/** Fades a line in, holds it, and fades it out over [start, end] seconds. */
function fade(time: number, start: number, end: number, edge = 0.6): number {
  if (time < start || time > end) return 0;
  return Math.min(1, (time - start) / edge, (end - time) / edge);
}

/**
 * The interface: flames for lives, crescents for the shards (params.need), a title card,
 * the controls, short notes for the checkpoint and the gate opening, and the end screens.
 */
export default {
  drawUI({ g, world, view, time, recent, params }) {
    const need = Number(params.need ?? 6);
    const cx = view.width / 2;

    // A dark vignette frames the night.
    const vignette = g.createRadialGradient(cx, view.height / 2, view.height * 0.35, cx, view.height / 2, view.width * 0.75);
    vignette.addColorStop(0, "rgba(4, 3, 18, 0)");
    vignette.addColorStop(1, "rgba(4, 3, 18, 0.55)");
    g.fillStyle = vignette;
    g.fillRect(0, 0, view.width, view.height);

    // Lives: a flame gutters out when one is lost.
    const hurt = recent("die", 0.6).at(-1);
    const lives = world.lives ?? 0;
    const maxLives = Math.max(lives, Number(params.lives ?? 3));
    for (let i = 0; i < maxLives; i++) {
      const lost = hurt && i === lives;
      const shrink = lost ? 1 + 0.8 * (1 - (time - hurt.time) / 0.6) : 1;
      flame(g, 32 + i * 26, 32, 10 * shrink, i < lives, time);
    }

    // Shards: one crescent each, the newest one flaring.
    const got = recent("collect", 0.6).at(-1);
    const flare = got ? 1 - (time - got.time) / 0.6 : 0;
    for (let i = 0; i < need; i++) {
      const newest = got && i === world.score - 1;
      const r = 10 + (newest ? flare * 5 : 0);
      crescent(g, view.width - 34 - (need - 1 - i) * 30, 34, r, i < world.score, newest ? flare : 0);
    }

    // Title card and controls.
    g.textAlign = "center";
    const title = fade(time, 0.2, 3.6, 0.8);
    if (title > 0 && !world.won) {
      g.globalAlpha = title;
      label(g, String(params.title), cx, view.height * 0.36, 54, "#f5efff", SERIF, 700);
      g.fillStyle = "rgba(255, 220, 150, 0.8)";
      g.fillRect(cx - 90 * title, view.height * 0.36 + 18, 180 * title, 1.5);
      label(g, String(params.subtitle), cx, view.height * 0.36 + 48, 18, "#ffe0a8", SERIF, 500);
      g.globalAlpha = 1;
    }
    const help = fade(time, 1.2, 8, 0.8);
    if (help > 0 && !world.won) {
      g.globalAlpha = help * 0.85;
      label(g, "Arrows / WASD to walk   ·   Space to jump   ·   land on wisps to put them out", cx, view.height - 28, 14, "#e8e4ff", SANS, 600);
      g.globalAlpha = 1;
    }

    // A lantern lit: the player will come back here.
    const saved = recent("checkpoint", 2.2).at(-1);
    if (saved) {
      g.globalAlpha = fade(time - saved.time, 0, 2.2, 0.4);
      label(g, "The spirit lantern will remember you", cx, 86, 18, "#bfefff", SERIF, 600);
      g.globalAlpha = 1;
    }
    // The last shard found: the gate opens.
    if (world.score >= need && got && !world.won) {
      g.globalAlpha = Math.min(1, flare * 3);
      label(g, "The moon gate opens", cx, 86, 22, "#ffe6a8", SERIF, 700);
      g.globalAlpha = 1;
    }

    g.textAlign = "right";
    label(g, "M sound  ·  R restart", view.width - 18, view.height - 14, 11, "rgba(232, 228, 255, 0.45)", SANS, 600);

    if (world.won || world.lost) {
      const end = recent(world.won ? "win" : "gameover", 1e9).at(-1);
      const since = end ? time - end.time : 0;
      g.fillStyle = world.won ? `rgba(10, 12, 40, ${Math.min(0.5, since * 0.6)})` : `rgba(6, 4, 20, ${Math.min(0.65, since)})`;
      g.fillRect(0, 0, view.width, view.height);
      g.globalAlpha = Math.min(1, since * 1.5);
      g.textAlign = "center";
      const rise = Math.max(0, 1 - since * 2) * 18;
      const y = view.height / 2;
      if (world.won) {
        label(g, "The moon is whole again", cx, y - 8 + rise, 46, "#fffaf0", SERIF, 700);
        const falls = world.deaths === 0 ? "without a single fall" : `with ${world.deaths} fall${world.deaths === 1 ? "" : "s"}`;
        label(g, `All ${need} shards returned, ${falls}`, cx, y + 32 + rise, 19, "#ffe0a8", SERIF, 500);
        label(g, "Press R to walk the path again", cx, y + 64 + rise, 14, "rgba(245, 240, 255, 0.8)", SANS, 600);
      } else {
        label(g, "The lanterns go out", cx, y - 8 + rise, 46, "#c9b8ff", SERIF, 700);
        label(g, `${world.score} of ${need} shards returned`, cx, y + 32 + rise, 19, "#e8e4ff", SERIF, 500);
        label(g, "Press R to try again", cx, y + 64 + rise, 14, "rgba(245, 240, 255, 0.8)", SANS, 600);
      }
      g.globalAlpha = 1;
    }
  },
} satisfies Script;
