import type { Script } from "@ludra/core";

interface Params {
  /** Run speed in px/s. */
  speed: number;
  /** Starts chasing when the player is this close horizontally. */
  range: number;
}

/** Waits until the player comes near, then runs toward them. Pair with a stompable hazard. */
export default {
  update({ self, world, params }) {
    const { speed, range } = params as unknown as Params;
    const player = world.player();
    const distance = player ? player.x - self.x : Infinity;
    self.state.chasing = Math.abs(distance) < range;
    self.vx = self.state.chasing ? Math.sign(distance) * speed : 0;
  },
} satisfies Script;
