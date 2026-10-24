import type { Script } from "@ludra/core";

/** A stable pseudo-random number per index, so the stars don't jump between frames. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The synthwave sky behind the game: stars, a striped sun on the horizon and a
 * neon grid rolling toward the player. Presentation only.
 */
export default {
  draw({ g, world, time }) {
    const w = world.width;
    const h = world.height;
    const horizon = h * 0.64;

    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, "#05001a");
    sky.addColorStop(0.7, "#1b0045");
    sky.addColorStop(1, "#4a0063");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, horizon);

    for (let i = 0; i < 110; i++) {
      const size = i % 13 === 0 ? 2 : 1;
      g.globalAlpha = 0.25 + 0.65 * Math.abs(Math.sin(time * (0.6 + hash(i) * 1.6) + i));
      g.fillStyle = i % 5 === 0 ? "#ff9de2" : "#d6ecff";
      g.fillRect(hash(i * 2 + 1) * w, hash(i * 3 + 7) * horizon * 0.9, size, size);
    }
    g.globalAlpha = 1;

    // The sun: a warm glow, then a disc cut by bands that drift down like a VHS sunset.
    const glow = g.createRadialGradient(w / 2, horizon, 20, w / 2, horizon, 330);
    glow.addColorStop(0, "rgba(255, 60, 140, 0.55)");
    glow.addColorStop(1, "rgba(255, 60, 140, 0)");
    g.globalCompositeOperation = "lighter";
    g.fillStyle = glow;
    g.fillRect(0, 0, w, horizon);
    g.globalCompositeOperation = "source-over";

    const radius = 120;
    const sun = g.createLinearGradient(0, horizon - radius, 0, horizon);
    sun.addColorStop(0, "#ffe66d");
    sun.addColorStop(0.55, "#ff7a3d");
    sun.addColorStop(1, "#ff2a6d");
    g.save();
    g.beginPath();
    g.arc(w / 2, horizon, radius, Math.PI, 0);
    g.clip();
    g.globalAlpha = 0.85;
    g.fillStyle = sun;
    g.fillRect(w / 2 - radius, horizon - radius, radius * 2, radius);
    g.globalAlpha = 1;
    g.fillStyle = sky;
    for (let i = 0; i < 7; i++) {
      const t = (i + ((time * 0.35) % 1)) / 7;
      g.fillRect(w / 2 - radius, horizon - radius * 0.55 + t * radius * 0.55, radius * 2, 1 + t * 7);
    }
    g.restore();

    // The floor grid.
    const floor = g.createLinearGradient(0, horizon, 0, h);
    floor.addColorStop(0, "#14002e");
    floor.addColorStop(1, "#020008");
    g.fillStyle = floor;
    g.fillRect(0, horizon, w, h - horizon);

    g.strokeStyle = "#ff2a6d";
    g.shadowColor = "#ff2a6d";
    g.shadowBlur = 10;
    g.lineWidth = 1.5;
    const rows = 12;
    for (let i = 0; i < rows; i++) {
      const t = (i + ((time * 0.8) % 1)) / rows;
      const y = horizon + (h - horizon) * t * t;
      g.globalAlpha = 0.15 + t * 0.75;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    g.globalAlpha = 0.55;
    for (let j = -12; j <= 12; j++) {
      g.beginPath();
      g.moveTo(w / 2 + j * 10, horizon);
      g.lineTo(w / 2 + j * 150, h);
      g.stroke();
    }

    // The horizon line itself, bright.
    g.globalAlpha = 1;
    g.strokeStyle = "#ff8fd8";
    g.shadowBlur = 18;
    g.beginPath();
    g.moveTo(0, horizon);
    g.lineTo(w, horizon);
    g.stroke();
  },
} satisfies Script;
