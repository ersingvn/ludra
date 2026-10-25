import type { Script } from "@ludra/core";

/**
 * Lights the checkpoint's lantern once the player has touched it: a flickering
 * flame and warm light on the grass, so players can see where they'll respawn.
 */
export default {
  draw({ g, self, time, recent }) {
    const lit = recent("checkpoint", 1e9).find((e) => (e.data as { checkpoint: string }).checkpoint === self.id);
    // The lantern hangs at the top left of the post.
    const x = self.x - 6;
    const y = self.y - self.height / 2 + 19;
    if (!lit) return;

    const since = time - lit.time;
    const flicker = 1 + Math.sin(time * 13) * 0.06 + Math.sin(time * 7.7) * 0.05;
    // A burst of light when it first catches, settling into a steady glow.
    const flare = Math.max(0, 1 - since * 1.5);
    const radius = (70 + flare * 60) * flicker;
    g.globalCompositeOperation = "lighter";
    const light = g.createRadialGradient(x, y, 2, x, y, radius);
    light.addColorStop(0, `rgba(255, 200, 110, ${0.55 + flare * 0.3})`);
    light.addColorStop(1, "rgba(255, 160, 60, 0)");
    g.fillStyle = light;
    g.fillRect(x - radius, y - radius, radius * 2, radius * 2);

    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#ffd166";
    g.shadowColor = "#ffb347";
    g.shadowBlur = 14;
    g.beginPath();
    g.ellipse(x, y + 1, 2.5 * flicker, 4 * flicker, 0, 0, Math.PI * 2);
    g.fill();
  },
} satisfies Script;
