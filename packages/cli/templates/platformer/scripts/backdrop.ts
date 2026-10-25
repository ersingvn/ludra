import type { Script } from "@ludra/core";

/** A stable pseudo-random number per index, so stars and hills don't jitter. */
function hash(n: number): number {
  const x = Math.sin(n * 157.3 + 21.9) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A night sky that moves at its own pace behind the level: stars, a glowing
 * moon and two rows of hills scrolling slower than the camera (parallax).
 * params.sky and params.hills set the palette, so each level can have its own night.
 */
export default {
  draw({ g, view, time, params }) {
    const [top, bottom] = params.sky as [string, string];
    const [far, near] = params.hills as [string, string];
    // Draw in screen space: the sky stays put while the level scrolls.
    g.translate(view.cameraX, view.cameraY);
    const { width: w, height: h } = view;

    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, top);
    sky.addColorStop(1, bottom);
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    for (let i = 0; i < 90; i++) {
      // Stars drift a little with the camera, the slowest layer of all.
      const x = (((hash(i) * w * 2 - view.cameraX * 0.05) % w) + w) % w;
      g.globalAlpha = 0.3 + 0.6 * Math.abs(Math.sin(time * (0.5 + hash(i + 9)) + i));
      g.fillStyle = "#e8eeff";
      g.fillRect(x, hash(i + 40) * h * 0.6, i % 9 === 0 ? 2 : 1, i % 9 === 0 ? 2 : 1);
    }
    g.globalAlpha = 1;

    const moonX = w * 0.78 - view.cameraX * 0.03;
    const glow = g.createRadialGradient(moonX, 90, 10, moonX, 90, 140);
    glow.addColorStop(0, "rgba(255, 244, 214, 0.35)");
    glow.addColorStop(1, "rgba(255, 244, 214, 0)");
    g.fillStyle = glow;
    g.fillRect(moonX - 140, -50, 280, 280);
    g.fillStyle = "#fff4d6";
    g.shadowColor = "#fff4d6";
    g.shadowBlur = 30;
    g.beginPath();
    g.arc(moonX, 90, 34, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = "rgba(200, 190, 170, 0.35)";
    for (const [dx, dy, r] of [[-10, -8, 7], [12, 6, 5], [-2, 14, 4]] as const) {
      g.beginPath();
      g.arc(moonX + dx, 90 + dy, r, 0, Math.PI * 2);
      g.fill();
    }

    // Two rows of rolling hills; the nearer row scrolls faster.
    const hills = (color: string, speed: number, base: number, height: number, seed: number) => {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, h);
      const offset = view.cameraX * speed;
      for (let x = 0; x <= w + 20; x += 20) {
        const u = (x + offset) / 160;
        const y = base - height * (0.55 + 0.45 * Math.sin(u + seed) * Math.cos(u * 0.37 + seed * 2));
        g.lineTo(x, y);
      }
      g.lineTo(w, h);
      g.closePath();
      g.fill();
    };
    hills(far, 0.15, h * 0.72, 90, 1);
    hills(near, 0.35, h * 0.86, 70, 4);
  },
} satisfies Script;
