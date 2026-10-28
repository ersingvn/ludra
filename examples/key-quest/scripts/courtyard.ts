import type { DrawContext, Script } from "@ludra/core";

/** A stable pseudo-random number per index, so stars and windows don't jitter. */
function hash(n: number): number {
  const x = Math.sin(n * 91.7 + 47.3) * 43758.5453;
  return x - Math.floor(x);
}

/** A castle tower: a body, a crenellated top, a pointed roof and a few lit windows. */
function tower(g: DrawContext["g"], x: number, base: number, width: number, height: number, seed: number, time: number): void {
  const top = base - height;
  g.fillStyle = "#231a3d";
  g.fillRect(x, top, width, height);
  const merlon = width / 5;
  for (let i = 0; i < 5; i += 2) g.fillRect(x + i * merlon, top - merlon * 0.8, merlon, merlon * 0.8);
  g.fillStyle = "#2f1f4a";
  g.beginPath();
  g.moveTo(x - 6, top - merlon * 0.8);
  g.lineTo(x + width / 2, top - merlon * 0.8 - width * 1.1);
  g.lineTo(x + width + 6, top - merlon * 0.8);
  g.closePath();
  g.fill();
  for (let i = 0; i < 3; i++) {
    if (hash(seed + i) < 0.35) continue;
    const flicker = 0.75 + 0.25 * Math.sin(time * (3 + hash(seed + i + 5) * 4) + i);
    g.fillStyle = `rgba(255, 190, 90, ${flicker})`;
    const wx = x + width / 2 - 5;
    const wy = top + 24 + i * 46;
    g.beginPath();
    g.moveTo(wx, wy + 16);
    g.lineTo(wx, wy + 5);
    g.arc(wx + 5, wy + 5, 5, Math.PI, 0);
    g.lineTo(wx + 10, wy + 16);
    g.closePath();
    g.fill();
  }
}

/**
 * The castle courtyard at night: a violet sky with stars and a pale moon, towers whose windows
 * flicker with candlelight behind the level, and the courtyard's brick wall with burning torches
 * right behind the play area. Each layer scrolls at its own pace.
 */
export default {
  draw({ g, view, time }) {
    g.translate(view.cameraX, view.cameraY);
    const { width: w, height: h } = view;

    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#0d0a24");
    sky.addColorStop(0.6, "#2a1f55");
    sky.addColorStop(1, "#4a2f62");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    for (let i = 0; i < 70; i++) {
      g.globalAlpha = 0.35 + 0.55 * Math.abs(Math.sin(time * (0.6 + hash(i + 3)) + i));
      g.fillStyle = "#f2e9ff";
      g.fillRect(hash(i) * w, hash(i + 20) * h * 0.55, i % 7 === 0 ? 2 : 1, i % 7 === 0 ? 2 : 1);
    }
    g.globalAlpha = 1;

    // A crescent: the moon, then the same sky painted over most of it, then its halo over both.
    const moonX = w * 0.82;
    g.fillStyle = "#efe8ff";
    g.beginPath();
    g.arc(moonX, 80, 30, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = sky;
    g.beginPath();
    g.arc(moonX + 12, 72, 26, 0, Math.PI * 2);
    g.fill();
    const halo = g.createRadialGradient(moonX, 80, 12, moonX, 80, 120);
    halo.addColorStop(0, "rgba(230, 220, 255, 0.3)");
    halo.addColorStop(1, "rgba(230, 220, 255, 0)");
    g.fillStyle = halo;
    g.fillRect(moonX - 120, -40, 240, 240);

    const shift = -view.cameraX * 0.2;
    tower(g, 90 + shift, h - 60, 70, 300, 1, time);
    tower(g, 330 + shift, h - 60, 54, 230, 9, time);
    tower(g, 560 + shift, h - 60, 80, 340, 17, time);
    tower(g, 790 + shift, h - 60, 60, 260, 25, time);

    // The courtyard wall: rows of bricks, offset every other row.
    const wallTop = h - 150;
    g.fillStyle = "#3b2c52";
    g.fillRect(0, wallTop, w, h - wallTop);
    g.strokeStyle = "rgba(20, 12, 36, 0.55)";
    g.lineWidth = 2;
    const brickW = 48;
    const brickH = 22;
    const wallShift = -view.cameraX * 0.6;
    for (let row = 0; wallTop + row * brickH < h; row++) {
      const y = wallTop + row * brickH;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
      const offset = (((wallShift + (row % 2) * brickW * 0.5) % brickW) + brickW) % brickW;
      for (let x = offset - brickW; x < w; x += brickW) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y + brickH);
        g.stroke();
      }
    }
    g.fillStyle = "#2a1f3d";
    for (let x = (((wallShift % 60) + 60) % 60) - 60; x < w; x += 60) g.fillRect(x, wallTop - 18, 34, 18);

    // Torches on the wall, with flames that sway and light the bricks around them.
    for (let i = 0; i < 4; i++) {
      const x = ((((i * 260 + 130 + wallShift) % (w + 260)) + w + 260) % (w + 260)) - 130;
      const y = wallTop + 44;
      const sway = Math.sin(time * 9 + i * 2) * 1.5;
      const flicker = 1 + Math.sin(time * 13 + i) * 0.08 + Math.sin(time * 7.3 + i * 3) * 0.06;
      g.globalCompositeOperation = "lighter";
      const light = g.createRadialGradient(x, y - 10, 2, x, y - 10, 70 * flicker);
      light.addColorStop(0, "rgba(255, 170, 80, 0.45)");
      light.addColorStop(1, "rgba(255, 120, 40, 0)");
      g.fillStyle = light;
      g.fillRect(x - 80, y - 90, 160, 160);
      g.globalCompositeOperation = "source-over";
      g.fillStyle = "#4a3324";
      g.fillRect(x - 3, y - 4, 6, 20);
      g.fillStyle = "#ffb347";
      g.beginPath();
      g.ellipse(x + sway, y - 12, 5 * flicker, 10 * flicker, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff1b8";
      g.beginPath();
      g.ellipse(x + sway * 0.6, y - 9, 2.2, 5, 0, 0, Math.PI * 2);
      g.fill();
    }
  },
} satisfies Script;
