// The mock's game: a small original platformer, "Lantern Steps", as Ludra entities.

export interface MockEntity {
  id: string;
  name?: string;
  prefab?: string;
  parent?: string;
  components: Record<string, any>;
}

export const MOCK_PROJECT = {
  name: "Lantern Steps",
  dir: "C:/games/lantern-steps",
  entry: "scenes/main.scene.json",
  scenes: ["scenes/main.scene.json", "scenes/caves.scene.json"],
  window: { width: 960, height: 540, pixelated: false },
};

export function mockScene(): MockEntity[] {
  const platform = (id: string, x: number, y: number, width: number, height: number, color = "#7a5a3c"): MockEntity => ({
    id,
    components: { transform: { x, y }, body: { type: "static", width, height }, sprite: { color, image: "assets/sandstone.svg", tile: true } },
  });
  const coin = (n: number, x: number, y: number): MockEntity => ({
    id: `coin-${n}`,
    prefab: "prefabs/coin.prefab.json",
    parent: "coins",
    components: {
      transform: { x, y },
      body: { type: "sensor", width: 16, height: 16 },
      sprite: { color: "#ffd166", image: "assets/coin.svg", frameWidth: 16, frameHeight: 16, fps: 8 },
      collectible: { value: 1, sound: "coin" },
      tween: { property: "transform.y", to: y - 6, duration: 0.8, yoyo: true, loop: true },
    },
  });
  return [
    { id: "dusk", components: { transform: { x: 0, y: 0 }, script: { src: "scripts/dusk.ts", state: { hue: 28, stars: 40 } } } },
    { id: "camera", components: { transform: { x: 480, y: 270 }, camera: { follow: "player", zoom: 1, deadzone: [120, 80] } } },
    {
      id: "player",
      name: "Wren",
      components: {
        transform: { x: 80, y: 482 },
        body: { type: "dynamic", width: 26, height: 34, vx: 0, vy: 0, onGround: true },
        sprite: { color: "#e8eef2", image: "assets/wren.svg", frameWidth: 26, frameHeight: 34, idle: "0", run: "1-4", jump: "5", fps: 12, layer: 2 },
        platformer: { speed: 220, jumpSpeed: 640, coyote: 0.08, jumpBuffer: 0.1 },
        script: { src: "scripts/wren.ts", state: { lanternLit: true } },
      },
    },
    platform("ground", 480, 520, 960, 40, "#5b4632"),
    platform("ledge-1", 300, 420, 160, 20),
    platform("ledge-2", 530, 330, 160, 20),
    platform("ledge-3", 770, 240, 160, 20),
    { id: "coins", components: { transform: { x: 0, y: 0 } } },
    coin(1, 250, 380),
    coin(2, 340, 380),
    coin(3, 415, 350),
    coin(4, 600, 290),
    coin(5, 690, 250),
    {
      id: "spikes",
      components: { transform: { x: 470, y: 494 }, body: { type: "static", width: 90, height: 12 }, sprite: { color: "#c9d1d9", image: "assets/spikes.svg", tile: true }, hazard: { damage: 1 } },
    },
    {
      id: "pit",
      name: "Thorn Pit",
      components: { transform: { x: 800, y: 494 }, body: { type: "static", width: 300, height: 12 }, sprite: { color: "#c9d1d9", image: "assets/spikes.svg", tile: true }, hazard: { damage: 1 } },
    },
    {
      id: "slime-1",
      name: "Moss Slime",
      prefab: "prefabs/slime.prefab.json",
      components: {
        transform: { x: 510, y: 306 },
        body: { type: "kinematic", width: 30, height: 20, vx: 50, vy: 0 },
        sprite: { color: "#7bd389", image: "assets/slime.svg", frameWidth: 30, frameHeight: 20, fps: 6 },
        patrol: { from: 470, to: 595, speed: 50 },
        hazard: { damage: 1, stompable: true },
      },
    },
    {
      id: "checkpoint",
      components: { transform: { x: 330, y: 392 }, body: { type: "sensor", width: 14, height: 36 }, sprite: { color: "#9aa5b1" }, checkpoint: { respawn: [330, 392] } },
    },
    {
      id: "beacon",
      name: "Beacon",
      components: {
        transform: { x: 820, y: 198 },
        body: { type: "sensor", width: 24, height: 64 },
        sprite: { color: "#f2a93b", image: "assets/beacon.svg" },
        goal: { next: "scenes/caves.scene.json" },
        light: { radius: 160, color: "#ffb24d", intensity: 0.9 },
      },
    },
    {
      id: "beacon-sparks",
      parent: "beacon",
      components: { transform: { x: 820, y: 172 }, emitter: { rate: 18, lifetime: 1.2, speed: [20, 60], color: "#ffd38a", size: 2 } },
    },
    {
      id: "fireflies",
      components: { transform: { x: 480, y: 200 }, emitter: { rate: 4, lifetime: 4, speed: [4, 12], color: "#d9f99d", size: 2, area: [900, 300] } },
    },
  ];
}
