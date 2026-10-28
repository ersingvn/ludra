import type { DrawContext, Script } from "@ludra/core";

/** A stable pseudo-random number per index, so clouds and flowers don't jitter. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A soft cloud made of overlapping puffs. */
function cloud(g: DrawContext["g"], x: number, y: number, size: number): void {
  g.fillStyle = "rgba(255, 255, 255, 0.92)";
  for (const [dx, dy, r] of [[0, 0, 1], [0.9, 0.15, 0.75], [-0.85, 0.2, 0.7], [0.35, -0.45, 0.7], [-0.3, -0.35, 0.6]] as const) {
    g.beginPath();
    g.arc(x + dx * size, y + dy * size, r * size, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "rgba(170, 205, 235, 0.35)";
  g.fillRect(x - size * 1.6, y + size * 0.55, size * 3.2, size * 0.25);
}

/**
 * A sunny valley behind the level: a bright sky, a sun with slow rays, clouds drifting on the
 * wind, and three rows of round, gooey hills scrolling slower than the camera. The nearest row
 * wobbles a little, as if the valley itself were made of slime.
 */
export default {
  draw({ g, view, time }) {
    g.translate(view.cameraX, view.cameraY);
    const { width: w, height: h } = view;

    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#5fb4ee");
    sky.addColorStop(0.65, "#bfe6ff");
    sky.addColorStop(1, "#eafbe9");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // The sun, with rays that turn slowly.
    const sunX = w * 0.18 - view.cameraX * 0.02;
    const sunY = 92;
    g.save();
    g.translate(sunX, sunY);
    g.rotate(time * 0.08);
    g.fillStyle = "rgba(255, 246, 196, 0.28)";
    for (let i = 0; i < 12; i++) {
      g.rotate(Math.PI / 6);
      g.beginPath();
      g.moveTo(-9, 0);
      g.lineTo(9, 0);
      g.lineTo(0, 150);
      g.closePath();
      g.fill();
    }
    g.restore();
    const glow = g.createRadialGradient(sunX, sunY, 20, sunX, sunY, 120);
    glow.addColorStop(0, "rgba(255, 250, 220, 0.8)");
    glow.addColorStop(1, "rgba(255, 250, 220, 0)");
    g.fillStyle = glow;
    g.fillRect(sunX - 120, sunY - 120, 240, 240);
    g.fillStyle = "#fff3b0";
    g.beginPath();
    g.arc(sunX, sunY, 38, 0, Math.PI * 2);
    g.fill();

    // Clouds drift right on their own and scroll a little with the camera.
    for (let i = 0; i < 7; i++) {
      const span = w + 400;
      const x = ((((hash(i) * span + time * (8 + hash(i + 3) * 10) - view.cameraX * 0.1) % span) + span) % span) - 200;
      cloud(g, x, 50 + hash(i + 7) * 150, 18 + hash(i + 11) * 16);
    }

    // Rows of round hills; nearer rows scroll faster and are greener.
    const hills = (color: string, speed: number, base: number, height: number, width: number, seed: number, wobble: number) => {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, h);
      const offset = view.cameraX * speed;
      for (let x = 0; x <= w + 10; x += 10) {
        const u = (x + offset) / width;
        const bump = Math.abs(Math.sin(u + seed)) ** 0.7;
        const y = base - height * bump - Math.sin(time * 1.6 + u * 3) * wobble;
        g.lineTo(x, y);
      }
      g.lineTo(w, h);
      g.closePath();
      g.fill();
    };
    hills("#a9d9b5", 0.12, h * 0.7, 110, 220, 1, 0);
    hills("#5fa877", 0.25, h * 0.8, 90, 150, 3, 0);
    hills("#3e8a57", 0.4, h * 0.9, 70, 110, 5, 2.5);

    // Little flowers on the nearest hills.
    for (let i = 0; i < 26; i++) {
      const x = (((hash(i + 50) * w * 2 - view.cameraX * 0.4) % w) + w) % w;
      const y = h * 0.86 + hash(i + 80) * h * 0.1;
      g.fillStyle = i % 3 === 0 ? "#ffd6e8" : i % 3 === 1 ? "#fff7b8" : "#ffffff";
      g.beginPath();
      g.arc(x, y, 2.2, 0, Math.PI * 2);
      g.fill();
    }
  },
} satisfies Script;
