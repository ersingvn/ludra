import type { DrawContext, Script } from "@ludra/core";

const FONT = "Orbitron, system-ui, sans-serif";

/** Text with a neon glow: a blurred colored pass, then a crisp light core. */
function neonText(g: DrawContext["g"], text: string, x: number, y: number, size: number, color: string, weight = 900): void {
  g.font = `${weight} ${size}px ${FONT}`;
  g.shadowColor = color;
  g.shadowBlur = size * 0.6;
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.shadowBlur = size * 0.15;
  g.fillStyle = "#ffffff";
  g.globalAlpha *= 0.85;
  g.fillText(text, x, y);
  g.globalAlpha /= 0.85;
}

/**
 * The level is won when no bricks are left (entities whose id starts with
 * params.prefix). Also draws the brick-break feedback and the whole interface.
 */
export default {
  start({ self, world, params }) {
    self.state.total = world.all("script").filter((e) => e.id.startsWith(params.prefix as string)).length;
  },
  update({ self, world, params }) {
    const left = world.all("script").filter((e) => e.id.startsWith(params.prefix as string)).length;
    self.state.bricksLeft = left;
    if (left === 0) world.win();
  },

  /** Shockwaves, colored shards and "+3" popups where bricks break. */
  draw({ g, time, recent, burst, local }) {
    for (const hit of recent("brick", 0.9)) {
      const { points, color } = hit.data as { points: number; color: string };
      // Burst once per break: the hook runs every rendered frame.
      if (hit.time > ((local.lastBurst as number) ?? -1)) {
        burst(hit.x, hit.y, { count: 26, color, speed: 240, life: 0.6, size: 3, gravity: 500, spread: 360 });
        local.lastBurst = hit.time;
      }
      const age = (time - hit.time) / 0.9;
      g.globalCompositeOperation = "lighter";
      g.strokeStyle = color;
      g.shadowColor = color;
      g.shadowBlur = 20;
      g.lineWidth = 4 * (1 - age);
      g.globalAlpha = 1 - age;
      g.beginPath();
      g.ellipse(hit.x, hit.y, 20 + age * 90, 10 + age * 40, 0, 0, Math.PI * 2);
      g.stroke();
      g.textAlign = "center";
      neonText(g, `+${points}`, hit.x, hit.y - 10 - age * 50, 22, color);
      g.globalAlpha = 1;
    }
  },

  drawUI({ g, self, world, view, time, recent }) {
    const total = (self.state.total as number) ?? 0;
    const left = (self.state.bricksLeft as number) ?? total;

    // A red flash from the edges when the ball is lost.
    const lost = recent("ball-lost", 0.7).at(-1);
    if (lost) {
      const strength = 1 - (time - lost.time) / 0.7;
      const edge = g.createRadialGradient(view.width / 2, view.height / 2, view.height * 0.3, view.width / 2, view.height / 2, view.width * 0.7);
      edge.addColorStop(0, "rgba(255, 0, 60, 0)");
      edge.addColorStop(1, `rgba(255, 0, 60, ${0.6 * strength})`);
      g.fillStyle = edge;
      g.fillRect(0, 0, view.width, view.height);
    }

    g.textAlign = "left";
    g.font = `700 11px ${FONT}`;
    g.fillStyle = "rgba(255, 180, 230, 0.75)";
    g.fillText("SCORE", 36, 44);
    neonText(g, String(world.score).padStart(3, "0"), 36, 74, 28, "#ff2a6d");

    // Bricks left as a segmented meter.
    g.textAlign = "right";
    g.font = `700 11px ${FONT}`;
    g.fillStyle = "rgba(180, 250, 255, 0.75)";
    g.fillText(`BRICKS ${left}/${total}`, view.width - 36, 44);
    const segments = Math.max(1, total);
    const meterWidth = 168;
    for (let i = 0; i < segments; i++) {
      const on = i < left;
      g.fillStyle = on ? "#00f0ff" : "rgba(0, 240, 255, 0.15)";
      g.shadowColor = "#00f0ff";
      g.shadowBlur = on ? 10 : 0;
      g.fillRect(view.width - 36 - meterWidth + (i * meterWidth) / segments, 54, meterWidth / segments - 2, 10);
    }
    g.shadowBlur = 0;

    if (world.deaths > 0) {
      g.font = `700 11px ${FONT}`;
      g.fillStyle = "rgba(255, 120, 140, 0.8)";
      g.fillText(`BALLS LOST ${world.deaths}`, view.width - 36, 84);
    }

    g.textAlign = "center";
    if (time < 2.5 && !world.won) {
      g.globalAlpha = Math.min(1, 2.5 - time) * (0.6 + 0.4 * Math.sin(time * 6));
      neonText(g, "◄  ►   MOVE", view.width / 2, view.height - 70, 16, "#00f0ff", 700);
      g.globalAlpha = 1;
    }
    g.font = `700 10px ${FONT}`;
    g.fillStyle = "rgba(255, 255, 255, 0.35)";
    g.fillText("M SOUND  ·  R RESTART", view.width / 2, view.height - 14);

    if (world.won) {
      const win = recent("win", 1e9).at(-1);
      const since = win ? time - win.time : 0;
      g.fillStyle = `rgba(5, 0, 20, ${Math.min(0.7, since * 1.4)})`;
      g.fillRect(0, 0, view.width, view.height);
      // A neon sign flickering on.
      const flicker = since < 0.6 && Math.sin(since * 70) > 0.2 ? 0.25 : 1;
      g.globalAlpha = Math.min(1, since * 2) * flicker;
      neonText(g, "WALL CLEARED", view.width / 2, view.height / 2 - 6, 64, "#ff2a6d");
      g.globalAlpha = Math.min(1, Math.max(0, since * 2 - 0.6));
      neonText(g, `SCORE ${world.score}   ·   ${(win?.time ?? time).toFixed(1)}s`, view.width / 2, view.height / 2 + 44, 20, "#00f0ff", 700);
      g.font = `700 12px ${FONT}`;
      g.fillStyle = "rgba(255, 255, 255, 0.6)";
      g.fillText("PRESS R TO PLAY AGAIN", view.width / 2, view.height / 2 + 84);
      g.globalAlpha = 1;
    }
  },
} satisfies Script;
