import type { Script } from "@ludra/core";

/** A dark wall with a neon tube along it. */
export default {
  draw({ g, self, time }) {
    const x = self.x - self.width / 2;
    const y = self.y - self.height / 2;
    g.fillStyle = "#0a0020";
    g.fillRect(x, y, self.width, self.height);

    g.strokeStyle = "#00f0ff";
    g.shadowColor = "#00f0ff";
    g.shadowBlur = 16 + Math.sin(time * 2) * 4;
    g.lineWidth = 3;
    g.strokeRect(x + 4, y + 4, self.width - 8, self.height - 8);
    g.shadowBlur = 0;
    g.strokeStyle = "rgba(220, 255, 255, 0.8)";
    g.lineWidth = 1;
    g.strokeRect(x + 4, y + 4, self.width - 8, self.height - 8);
  },
} satisfies Script;
