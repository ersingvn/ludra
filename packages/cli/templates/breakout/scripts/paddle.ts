import type { Script } from "@ludra/core";

/**
 * Aims the ball by where it hits the paddle: the center sends it straight up,
 * the edges send it off at a steep angle, which is what makes breakout skillful.
 */
export default {
  touch({ self, world, params }, other) {
    if (other.id !== params.ball) return;
    const offset = Math.max(-1, Math.min(1, (other.x - self.x) / (self.width / 2)));
    const speed = Math.hypot(other.vx, other.vy) || 1;
    other.vx = offset * speed * 0.8;
    other.vy = -Math.sqrt(speed * speed - other.vx * other.vx);
    world.emit("paddle-hit");
  },
  draw({ g, self, time, recent }) {
    const hit = recent("paddle-hit", 0.3).at(-1);
    const flash = hit ? 1 - (time - hit.time) / 0.3 : 0;
    const x = self.x - self.width / 2;
    const y = self.y - self.height / 2;

    // Light spilling onto the floor under the paddle.
    const spill = g.createRadialGradient(self.x, self.y + 14, 4, self.x, self.y + 14, 90);
    spill.addColorStop(0, `rgba(0, 240, 255, ${0.35 + flash * 0.4})`);
    spill.addColorStop(1, "rgba(0, 240, 255, 0)");
    g.globalCompositeOperation = "lighter";
    g.fillStyle = spill;
    g.fillRect(self.x - 100, self.y - 20, 200, 60);
    g.globalCompositeOperation = "source-over";

    const body = g.createLinearGradient(0, y, 0, y + self.height);
    body.addColorStop(0, "#e6ffff");
    body.addColorStop(0.4, "#2ee6ff");
    body.addColorStop(1, "#006c9e");
    g.shadowColor = flash > 0 ? "#ffffff" : "#00f0ff";
    g.shadowBlur = 24 + flash * 30;
    g.fillStyle = body;
    g.beginPath();
    g.roundRect(x, y, self.width, self.height, self.height / 2);
    g.fill();

    // Magenta emitters at both ends, breathing.
    g.shadowColor = "#ff2a6d";
    g.shadowBlur = 14;
    g.fillStyle = "#ff5c9d";
    const breathe = 3.5 + Math.sin(time * 5) * 0.8;
    for (const ex of [x + 10, x + self.width - 10]) {
      g.beginPath();
      g.arc(ex, self.y, breathe, 0, Math.PI * 2);
      g.fill();
    }
  },
} satisfies Script;
