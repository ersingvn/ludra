import type { DrawContext, Script } from "@ludra/core";

/** A stable pseudo-random number per index, so dunes and dust don't jitter. */
function hash(n: number): number {
  const x = Math.sin(n * 71.3 + 19.1) * 43758.5453;
  return x - Math.floor(x);
}

/** A stepped pyramid: `tiers` blocks, each narrower than the one below. */
function pyramid(g: DrawContext["g"], x: number, base: number, width: number, tiers: number, color: string): void {
  g.fillStyle = color;
  const tier = (width * 0.55) / tiers;
  for (let i = 0; i < tiers; i++) {
    const w = width * (1 - i / tiers);
    g.fillRect(x - w / 2, base - (i + 1) * tier, w, tier + 1);
  }
}

/**
 * The desert at sunset behind the temple steps: a sky going from violet to gold, a huge low sun
 * with heat shimmer, two rows of stepped pyramids, dunes, and dust drifting on the evening wind.
 */
export default {
  draw({ g, view, time }) {
    g.translate(view.cameraX, view.cameraY);
    const { width: w, height: h } = view;

    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#2d1650");
    sky.addColorStop(0.35, "#8a2f6b");
    sky.addColorStop(0.62, "#f07b4a");
    sky.addColorStop(0.85, "#ffc477");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // The first stars, high up where it is already night.
    for (let i = 0; i < 30; i++) {
      g.globalAlpha = (0.2 + 0.5 * Math.abs(Math.sin(time * 0.7 + i))) * (1 - hash(i + 2) * 0.6);
      g.fillStyle = "#fff0e0";
      g.fillRect(hash(i) * w, hash(i + 30) * h * 0.25, 1.5, 1.5);
    }
    g.globalAlpha = 1;

    // The sun, sinking behind the pyramids, cut into bands by the heat haze.
    const sunX = w * 0.3;
    const sunY = h * 0.66;
    const glow = g.createRadialGradient(sunX, sunY, 40, sunX, sunY, 260);
    glow.addColorStop(0, "rgba(255, 220, 140, 0.55)");
    glow.addColorStop(1, "rgba(255, 160, 90, 0)");
    g.fillStyle = glow;
    g.fillRect(sunX - 260, sunY - 260, 520, 520);
    g.fillStyle = "#ffe39a";
    g.beginPath();
    g.arc(sunX, sunY, 92, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(240, 123, 74, 0.55)";
    for (let i = 0; i < 5; i++) {
      const y = sunY + 18 + i * 14;
      g.fillRect(sunX - 100 + Math.sin(time * 1.4 + i) * 3, y, 200, 3 + i);
    }

    // Far and near pyramids.
    pyramid(g, w * 0.12, h * 0.78, 300, 7, "#7a3c5e");
    pyramid(g, w * 0.55, h * 0.78, 220, 6, "#6a3355");
    pyramid(g, w * 0.86, h * 0.8, 360, 8, "#5c2c4c");

    // Dunes in front of them, rising and falling gently.
    const dunes = (color: string, base: number, height: number, width: number, seed: number) => {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, h);
      for (let x = 0; x <= w + 10; x += 10) g.lineTo(x, base - height * (0.5 + 0.5 * Math.sin(x / width + seed)));
      g.lineTo(w, h);
      g.closePath();
      g.fill();
    };
    dunes("#a8566a", h * 0.86, 30, 140, 1);
    dunes("#c66f60", h * 0.92, 24, 90, 4);

    // Dust drifting left on the wind.
    g.fillStyle = "rgba(255, 226, 170, 0.6)";
    for (let i = 0; i < 40; i++) {
      const x = ((((hash(i) * w - time * (14 + hash(i + 5) * 20)) % w) + w) % w);
      const y = h * 0.35 + hash(i + 9) * h * 0.6 + Math.sin(time * 2 + i) * 4;
      g.fillRect(x, y, 2, 2);
    }
  },
} satisfies Script;
