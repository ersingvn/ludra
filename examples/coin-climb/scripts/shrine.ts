import type { Script } from "@ludra/core";

/**
 * The shrine's sun disc lights up once the player holds params.coins coins: a warm glow and slow
 * rays, so the goal reads as open from the bottom of the steps.
 */
export default {
  draw({ g, self, world, time, params, recent }) {
    if (world.score < (params.coins as number)) return;
    const woke = recent("collect", 1e9).at(-1);
    const since = woke ? time - woke.time : 1;
    const strength = Math.min(1, since * 2);
    const x = self.x;
    const y = self.y;
    g.globalCompositeOperation = "lighter";
    const glow = g.createRadialGradient(x, y, 4, x, y, 70);
    glow.addColorStop(0, `rgba(255, 220, 120, ${0.7 * strength})`);
    glow.addColorStop(1, "rgba(255, 160, 60, 0)");
    g.fillStyle = glow;
    g.fillRect(x - 70, y - 70, 140, 140);
    g.translate(x, y);
    g.rotate(time * 0.5);
    g.fillStyle = `rgba(255, 230, 150, ${0.35 * strength})`;
    for (let i = 0; i < 8; i++) {
      g.rotate(Math.PI / 4);
      g.fillRect(-1.5, 10, 3, 26 + 6 * Math.sin(time * 3 + i));
    }
  },
} satisfies Script;
