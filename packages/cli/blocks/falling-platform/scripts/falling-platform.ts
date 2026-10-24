import type { Script } from "@ludra/core";

const GRAVITY = 1800;

/**
 * idle → (a player stands on it) → shaking for params.delay s → falling →
 * gone (below the world) for params.respawn s → back to idle at its start.
 */
export default {
  start({ self }) {
    self.state.phase = "idle";
    self.state.homeX = self.x;
    self.state.homeY = self.y;
  },
  update({ self, world, params, dt }) {
    const homeX = self.state.homeX as number;
    const homeY = self.state.homeY as number;
    switch (self.state.phase) {
      case "idle": {
        const player = world.player();
        const standing = player && player.grounded && player.y < self.y && self.touches(player);
        if (standing) {
          self.state.phase = "shaking";
          self.state.timer = params.delay as number;
          world.emit("platform-crack");
        }
        break;
      }
      case "shaking":
        self.state.timer = (self.state.timer as number) - dt;
        self.x = homeX + (world.random() - 0.5) * 3;
        if ((self.state.timer as number) <= 0) {
          self.x = homeX;
          self.state.phase = "falling";
          self.state.speed = 0;
        }
        break;
      case "falling":
        self.state.speed = (self.state.speed as number) + GRAVITY * dt;
        self.y += (self.state.speed as number) * dt;
        if (self.y > world.height + 200) {
          self.state.phase = "gone";
          self.state.timer = params.respawn as number;
        }
        break;
      case "gone":
        self.state.timer = (self.state.timer as number) - dt;
        if ((self.state.timer as number) <= 0) {
          self.x = homeX;
          self.y = homeY;
          self.state.phase = "idle";
        }
        break;
    }
  },
} satisfies Script;
