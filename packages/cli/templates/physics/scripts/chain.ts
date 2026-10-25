import type { Script } from "@ludra/core";

/**
 * Draws the chain a pendulum hangs from: links from its pivot (params.pivot, a point
 * in the world) to the body, so players can read the swing before it reaches them.
 */
export default {
  draw({ g, self, params }) {
    const pivot = params.pivot as { x: number; y: number };
    const dx = self.x - pivot.x;
    const dy = self.y - pivot.y;
    const length = Math.hypot(dx, dy);
    const links = Math.max(2, Math.round(length / 14));
    g.lineCap = "round";
    for (let i = 0; i < links; i++) {
      const t = (i + 0.5) / links;
      const x = pivot.x + dx * t;
      const y = pivot.y + dy * t;
      // Links alternate face-on and edge-on, like a real chain.
      g.save();
      g.translate(x, y);
      g.rotate(Math.atan2(dy, dx));
      g.strokeStyle = "#9aa3b5";
      g.lineWidth = 2.5;
      g.beginPath();
      if (i % 2 === 0) g.ellipse(0, 0, 7, 3.5, 0, 0, Math.PI * 2);
      else {
        g.moveTo(-7, 0);
        g.lineTo(7, 0);
      }
      g.stroke();
      g.restore();
    }
    // The bolt it hangs from.
    g.fillStyle = "#5c677d";
    g.beginPath();
    g.arc(pivot.x, pivot.y, 6, 0, Math.PI * 2);
    g.fill();
  },
} satisfies Script;
