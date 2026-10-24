import type { Script } from "@ludra/core";

/** A stable pseudo-random number per index, so fireflies keep their paths. */
function hash(n: number): number {
  const x = Math.sin(n * 91.7 + 47.3) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Moonlit night over the grove: darkness everywhere except the hero's lantern,
 * then colored light from glowing things (params.lights maps an id prefix to a
 * color), and fireflies. Presentation only: the darkness never hides a hazard
 * completely (params.darkness stays well below 1).
 */
export default {
  drawUI({ g, world, view, time }) {
    const toScreen = (x: number, y: number) => [(x - view.cameraX) * view.zoom, (y - view.cameraY) * view.zoom] as const;
    const hero = world.player();
    const darkness = 0.62;

    // Darkness with a soft hole where the lantern shines.
    const [hx, hy] = hero ? toScreen(hero.x, hero.y) : [view.width / 2, view.height / 2];
    const flicker = 1 + Math.sin(time * 11) * 0.015 + Math.sin(time * 7.3) * 0.02;
    const night = g.createRadialGradient(hx, hy, 30 * flicker, hx, hy, 210 * flicker);
    night.addColorStop(0, "rgba(6, 10, 30, 0)");
    night.addColorStop(1, `rgba(6, 10, 30, ${darkness})`);
    g.fillStyle = night;
    g.fillRect(0, 0, view.width, view.height);

    // Light from glowing things, added on top of the darkness.
    g.globalCompositeOperation = "lighter";
    const lights: Record<string, string> = { "gem-": "#2fb8ff", portal: "#b25cff", "slime-": "#8a3cff", thorns: "#ff3355" };
    for (const e of world.all()) {
      const prefix = Object.keys(lights).find((p) => e.id.startsWith(p));
      if (!prefix) continue;
      const [x, y] = toScreen(e.x, e.y);
      const radius = (prefix === "portal" ? 110 : 60) * (0.85 + 0.15 * Math.sin(time * 2.4 + e.x));
      const light = g.createRadialGradient(x, y, 0, x, y, radius);
      light.addColorStop(0, `${lights[prefix]}66`);
      light.addColorStop(1, `${lights[prefix]}00`);
      g.fillStyle = light;
      g.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    if (hero) {
      const lantern = g.createRadialGradient(hx, hy, 0, hx, hy, 120 * flicker);
      lantern.addColorStop(0, "rgba(255, 190, 110, 0.32)");
      lantern.addColorStop(1, "rgba(255, 190, 110, 0)");
      g.fillStyle = lantern;
      g.fillRect(hx - 130, hy - 130, 260, 260);
    }

    // Fireflies drifting on their own little loops.
    for (let i = 0; i < 36; i++) {
      const [x, y] = toScreen(
        hash(i) * world.width + Math.sin(time * (0.3 + hash(i + 50) * 0.5) + i) * 40,
        hash(i + 100) * world.height + Math.cos(time * (0.25 + hash(i + 80) * 0.4) + i * 2) * 30,
      );
      const blink = Math.max(0, Math.sin(time * (1.5 + hash(i + 7) * 2) + i * 3));
      g.fillStyle = `rgba(220, 255, 140, ${0.75 * blink})`;
      g.shadowColor = "#d4ff6b";
      g.shadowBlur = 10;
      g.beginPath();
      g.arc(x, y, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  },
} satisfies Script;
