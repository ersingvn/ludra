import type { Script } from "@ludra/core";

/**
 * A vortex of light over the portal sprite. It spins slowly while the portal
 * is asleep and wakes up (faster, brighter) once params.need crystals are found.
 */
export default {
  draw({ g, self, world, params, time }) {
    const awake = world.score >= (params.need as number);
    const spin = time * (awake ? 3.2 : 0.9);
    g.globalCompositeOperation = "lighter";
    g.lineCap = "round";
    for (let i = 0; i < 5; i++) {
      const radius = 8 + i * 4.5;
      const start = spin * (i % 2 === 0 ? 1 : -1.3) + i;
      g.strokeStyle = i % 2 === 0 ? "#d8a6ff" : "#6be4ff";
      g.globalAlpha = awake ? 0.9 : 0.35;
      g.lineWidth = awake ? 2.5 : 1.5;
      g.shadowColor = g.strokeStyle;
      g.shadowBlur = awake ? 14 : 6;
      g.beginPath();
      g.arc(self.x, self.y, radius, start, start + Math.PI * 1.1);
      g.stroke();
    }
    if (awake) {
      const core = g.createRadialGradient(self.x, self.y, 0, self.x, self.y, 26);
      core.addColorStop(0, "rgba(255, 255, 255, 0.9)");
      core.addColorStop(1, "rgba(178, 92, 255, 0)");
      g.globalAlpha = 0.7 + 0.3 * Math.sin(time * 6);
      g.fillStyle = core;
      g.fillRect(self.x - 26, self.y - 26, 52, 52);
    }
  },
} satisfies Script;
