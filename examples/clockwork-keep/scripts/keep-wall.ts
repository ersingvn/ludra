import type { Script } from "@ludra/core";

/**
 * The inside of the keep, behind the level: dark masonry in screen space that drifts sideways
 * at half the camera's speed (parallax), tall arched windows onto a moonlit sky on each floor, and
 * warm torches whose light flickers.
 */
export default {
  draw({ g, view, time }) {
    g.translate(view.cameraX, view.cameraY);
    const { width: w, height: h } = view;
    const shift = view.cameraX * 0.5;
    // Windows belong to their floor, so the wall follows the camera exactly up and down.
    const lift = view.cameraY;

    const wall = g.createLinearGradient(0, 0, 0, h);
    wall.addColorStop(0, "#221d33");
    wall.addColorStop(1, "#15111f");
    g.fillStyle = wall;
    g.fillRect(0, 0, w, h);

    // Faint masonry courses.
    g.strokeStyle = "rgba(255, 255, 255, 0.035)";
    g.lineWidth = 2;
    const course = 48;
    for (let y = -((lift % course) + course) % course; y < h; y += course) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
      const offset = (Math.floor((y + lift) / course) % 2) * 48;
      for (let x = -(((shift + offset) % 96) + 96) % 96; x < w; x += 96) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y + course);
        g.stroke();
      }
    }

    // Arched windows every 480 px of the wall, with the night beyond.
    const spacing = 480;
    for (let k = Math.floor(shift / spacing) - 1; k <= Math.floor((shift + w) / spacing) + 1; k++) {
      const x = k * spacing - shift + 160;
      for (const floor of [0, 1]) {
        const top = 120 + floor * 540 - lift;
        if (top > h || top + 200 < 0) continue;
        g.save();
        g.beginPath();
        g.moveTo(x, top + 200);
        g.lineTo(x, top + 50);
        g.arc(x + 45, top + 50, 45, Math.PI, 0);
        g.lineTo(x + 90, top + 200);
        g.closePath();
        const sky = g.createLinearGradient(0, top, 0, top + 200);
        sky.addColorStop(0, "#2d3d7a");
        sky.addColorStop(1, "#6a4f8a");
        g.fillStyle = sky;
        g.fill();
        g.clip();
        g.fillStyle = "#fff4d6";
        g.shadowColor = "#fff4d6";
        g.shadowBlur = 20;
        g.beginPath();
        g.arc(x + 62, top + 60, 12, 0, Math.PI * 2);
        g.fill();
        g.restore();
        g.strokeStyle = "#0e0b16";
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(x + 45, top + 5);
        g.lineTo(x + 45, top + 200);
        g.moveTo(x, top + 110);
        g.lineTo(x + 90, top + 110);
        g.stroke();

        // A torch between windows, flickering.
        const tx = x + 285;
        const ty = top + 110;
        const flicker = 0.85 + 0.15 * Math.sin(time * 13 + k * 7) * Math.sin(time * 7.3 + k);
        const glow = g.createRadialGradient(tx, ty, 4, tx, ty, 150 * flicker);
        glow.addColorStop(0, "rgba(255, 170, 80, 0.32)");
        glow.addColorStop(1, "rgba(255, 170, 80, 0)");
        g.fillStyle = glow;
        g.fillRect(tx - 160, ty - 160, 320, 320);
        g.fillStyle = "#3b2a1e";
        g.fillRect(tx - 4, ty, 8, 26);
        g.fillStyle = "#ffb347";
        g.shadowColor = "#ff8c3a";
        g.shadowBlur = 16;
        g.beginPath();
        g.ellipse(tx, ty - 6, 6 * flicker, 11 * flicker, 0, 0, Math.PI * 2);
        g.fill();
        g.shadowBlur = 0;
      }
    }
  },
} satisfies Script;
