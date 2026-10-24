import type { Script } from "@ludra/core";

/** Flies until it has gone params.range px, then disappears. */
export default {
  start({ self }) {
    self.state.startX = self.x;
  },
  update({ self, world, params }) {
    if (Math.abs(self.x - (self.state.startX as number)) > (params.range as number)) world.destroy(self);
  },
} satisfies Script;
