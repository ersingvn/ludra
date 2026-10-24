import type { Script } from "@ludra/core";

interface Params {
  /** Ball speed in px/s, kept constant. */
  speed: number;
  /** Seconds the ball rests on the paddle before launching. */
  launchDelay: number;
  /** Id of the paddle. */
  paddle: string;
}

/**
 * Rests on the paddle, launches, and keeps a constant speed (bounce: 1 does
 * the reflecting). Falling past the bottom costs a life: the paddle "dies"
 * and the ball goes back onto it.
 */
export default {
  start({ self, world, params }) {
    self.state.stuck = true;
    self.state.launchAt = world.time + (params.launchDelay as number);
  },
  update({ self, world, params }) {
    const { speed, launchDelay, paddle: paddleId } = params as unknown as Params;
    const paddle = world.get(paddleId);
    if (!paddle) return;

    if (self.state.stuck) {
      self.x = paddle.x;
      self.y = paddle.y - paddle.height / 2 - self.height / 2 - 1;
      self.vx = 0;
      self.vy = 0;
      if (world.time >= (self.state.launchAt as number)) {
        self.state.stuck = false;
        self.vx = speed * 0.5;
        self.vy = -speed * 0.866;
        world.emit("launch");
      }
      return;
    }

    if (self.y > world.height + 30) {
      world.emit("ball-lost");
      world.kill(paddle);
      self.state.stuck = true;
      self.state.launchAt = world.time + launchDelay;
      return;
    }

    // Never travel almost horizontally (it would take forever to come back), and keep the speed constant.
    const minVertical = speed * 0.35;
    if (Math.abs(self.vy) < minVertical) self.vy = (self.vy < 0 ? -1 : 1) * minVertical;
    const current = Math.hypot(self.vx, self.vy);
    if (current > 0) {
      self.vx = (self.vx / current) * speed;
      self.vy = (self.vy / current) * speed;
    }
  },
  /** A white-hot core in a golden halo, trailing a comet tail. */
  draw({ g, self, local }) {
    const trail = (local.trail ??= []) as Array<{ x: number; y: number }>;
    const last = trail.at(-1);
    // The ball jumped back onto the paddle: don't draw a streak across the screen.
    if (last && Math.hypot(self.x - last.x, self.y - last.y) > 60) trail.length = 0;
    trail.push({ x: self.x, y: self.y });
    if (trail.length > 16) trail.shift();

    g.globalCompositeOperation = "lighter";
    trail.forEach((p, i) => {
      const t = (i + 1) / trail.length;
      g.fillStyle = `rgba(255, ${150 + t * 80}, 40, ${t * 0.3})`;
      g.beginPath();
      g.arc(p.x, p.y, 7 * t, 0, Math.PI * 2);
      g.fill();
    });

    const halo = g.createRadialGradient(self.x, self.y, 2, self.x, self.y, 30);
    halo.addColorStop(0, "rgba(255, 214, 10, 0.7)");
    halo.addColorStop(1, "rgba(255, 120, 10, 0)");
    g.fillStyle = halo;
    g.fillRect(self.x - 30, self.y - 30, 60, 60);

    g.globalCompositeOperation = "source-over";
    g.shadowColor = "#ffd60a";
    g.shadowBlur = 18;
    g.fillStyle = "#fffbe6";
    g.beginPath();
    g.arc(self.x, self.y, self.width / 2, 0, Math.PI * 2);
    g.fill();
  },
} satisfies Script;
