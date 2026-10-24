import type { Script } from "@ludra/core";

interface Params {
  /** Seconds between shots. */
  interval: number;
  /** Bullet speed in px/s. */
  speed: number;
  /** -1 fires left, 1 fires right. */
  direction: number;
  /** Bullets vanish after flying this many px. */
  range: number;
}

/** Fires a deadly bullet every params.interval seconds. */
export default {
  start({ self, params }) {
    self.state.shots = 0;
    self.state.next = (params.interval as number) / 2;
  },
  update({ self, world, params }) {
    const { interval, speed, direction, range } = params as unknown as Params;
    if (world.time < (self.state.next as number)) return;
    world.spawn({
      components: {
        transform: { x: self.x + direction * (self.width / 2 + 8), y: self.y - 2 },
        body: { type: "kinematic", width: 12, height: 6, sensor: true, vx: direction * speed },
        sprite: { color: "#ff5d73", image: "assets/bullet.svg", layer: 2 },
        hazard: {},
        script: { src: "scripts/bullet.ts", params: { range } },
      },
    });
    self.state.shots = (self.state.shots as number) + 1;
    self.state.next = world.time + interval;
    world.emit("turret-shot");
  },
} satisfies Script;
