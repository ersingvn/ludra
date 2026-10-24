import type { Script } from "@ludra/core";

/** Counts down params.seconds. When time runs out the player dies and the clock restarts. */
export default {
  start({ self, params }) {
    self.state.left = params.seconds as number;
  },
  update({ self, world, params, dt }) {
    self.state.left = Math.max(0, (self.state.left as number) - dt);
    if (self.state.left === 0) {
      world.emit("timeout");
      world.kill(world.player()!);
      self.state.left = params.seconds as number;
    }
  },
} satisfies Script;
