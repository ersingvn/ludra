import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { actionsUsed } from "../src/controls.ts";
import { Gamepads } from "../src/controls.ts";
import type { SceneDef } from "../src/types.ts";

const scene = (components: Record<string, unknown>, prefabs?: Record<string, unknown>): SceneDef =>
  ({ entities: [{ id: "p", components: { transform: { x: 0, y: 0 }, body: { type: "dynamic", width: 10, height: 10 }, ...components } }], ...(prefabs ? { prefabs } : {}) }) as SceneDef;

describe("the actions a game uses", () => {
  it("come from its player components", () => {
    assert.deepEqual(actionsUsed([scene({ platformer: {} })]), ["left", "right", "jump"]);
    assert.deepEqual(actionsUsed([scene({ topdown: {} })]), ["left", "right", "up", "down"]);
    assert.deepEqual(actionsUsed([scene({ topdown: { directions: "4" } })]), ["left", "right", "up", "down"]);
    assert.deepEqual(actionsUsed([scene({ topdown: { directions: "x" } })]), ["left", "right"]);
    assert.deepEqual(actionsUsed([scene({ topdown: { directions: "y" } })]), ["up", "down"]);
    assert.deepEqual(actionsUsed([scene({})]), []);
  });

  it("add up over scenes and prefabs, and what scripts read", () => {
    const withPrefab = scene({}, { hero: { components: { platformer: {} } } });
    assert.deepEqual(actionsUsed([withPrefab]), ["left", "right", "jump"]);
    assert.deepEqual(actionsUsed([scene({ topdown: { directions: "x" } }), scene({ topdown: { directions: "y" } })]), ["left", "right", "up", "down"]);
    const script = `export default { update({ input }) { if (input.pressed("action")) fire(); if (input.held( 'jump' )) hover(); } };`;
    assert.deepEqual(actionsUsed([scene({ topdown: {} })], [script]), ["left", "right", "up", "down", "jump", "action"]);
    assert.deepEqual(actionsUsed([], [`held("fly")`]), [], "only real actions");
  });
});

describe("gamepads", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let pads: unknown[] = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { getGamepads: () => pads } });
  after(() => (saved ? Object.defineProperty(globalThis, "navigator", saved) : delete (globalThis as { navigator?: unknown }).navigator));

  const pad = (axes: number[], pressed: number[] = []) => ({ connected: true, axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })) });

  it("move with the stick or the d-pad, jump with A and act with the other face buttons", () => {
    const gamepads = new Gamepads();
    pads = [pad([-0.9, 0.1])];
    assert.deepEqual([...gamepads.poll().actions], ["left"]);
    pads = [pad([0.3, -0.8])];
    assert.deepEqual([...gamepads.poll().actions], ["up"], "a light lean is no direction");
    pads = [pad([0, 0], [15, 13, 0, 2])];
    assert.deepEqual([...gamepads.poll().actions].sort(), ["action", "down", "jump", "right"]);
    pads = [null, pad([0, 0], [14]), { ...pad([1, 0]), connected: false }];
    assert.deepEqual([...gamepads.poll().actions], ["left"], "empty slots and unplugged pads count for nothing");
  });

  it("pause and mute once per press of Start and Back", () => {
    const gamepads = new Gamepads();
    pads = [pad([0, 0], [9, 8])];
    const first = gamepads.poll();
    assert.equal(first.pause, true);
    assert.equal(first.mute, true);
    const held = gamepads.poll();
    assert.equal(held.pause, false);
    assert.equal(held.mute, false);
    pads = [pad([0, 0])];
    gamepads.poll();
    pads = [pad([0, 0], [9])];
    assert.equal(gamepads.poll().pause, true);
  });

  it("are nothing where there's no Gamepad API", () => {
    pads = [];
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    assert.equal(new Gamepads().poll().actions.size, 0);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { getGamepads: () => pads } });
  });
});
