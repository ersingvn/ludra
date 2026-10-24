import type { Script } from "@ludra/core";

/** Mixes a #rrggbb color toward white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/** Breaks when the ball hits it and adds params.points to the score. Glows in params.color. */
export default {
  touch({ self, world, params }, other) {
    if (other.id !== params.ball) return;
    world.score += params.points as number;
    world.emit("brick", { points: params.points, color: params.color });
    world.destroy(self);
  },
  draw({ g, self, params, time }) {
    const color = params.color as string;
    const x = self.x - self.width / 2;
    const y = self.y - self.height / 2;
    const pulse = 0.7 + 0.3 * Math.sin(time * 3 + self.x * 0.03);

    const body = g.createLinearGradient(0, y, 0, y + self.height);
    body.addColorStop(0, shade(color, 0.45));
    body.addColorStop(0.45, color);
    body.addColorStop(1, shade(color, -0.45));
    g.shadowColor = color;
    g.shadowBlur = 22 * pulse;
    g.fillStyle = body;
    g.beginPath();
    g.roundRect(x, y, self.width, self.height, 7);
    g.fill();

    g.shadowBlur = 0;
    g.strokeStyle = "rgba(255, 255, 255, 0.65)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x + 10, y + 5);
    g.lineTo(x + self.width - 10, y + 5);
    g.stroke();

    // One pip per point, so the rows read as worth more.
    g.fillStyle = "rgba(255, 255, 255, 0.85)";
    for (let i = 0; i < (params.points as number); i++) {
      g.beginPath();
      g.arc(x + self.width - 14 - i * 9, y + self.height - 9, 2.5, 0, Math.PI * 2);
      g.fill();
    }
  },
} satisfies Script;
