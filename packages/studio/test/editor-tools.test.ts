// v0.99 viewport tools (docs/editor.md, part B): the arithmetic the viewport uses, and the edits the
// tools, the palette and the hierarchy send, against the mock's scene file (part A's server rules).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Editor } from "../ui/src/editor.ts";
import { MockSceneFile } from "../ui/src/mock/edits.ts";
import type { GameView } from "../ui/src/protocol.ts";
import type { Toast } from "../ui/src/studio.ts";
import { dragTo, duplicate, entityBox, frameLook, freshId, placeEdit, reorderEdits, screenScale, snap, toScreen, toWorld, youDid } from "../ui/src/tools.ts";

const VIEW: GameView = { cameraX: 100, cameraY: 50, zoom: 2, width: 960, height: 540, rect: { left: 10, top: 20, width: 480, height: 270 } };

describe("viewport tools: screen and world", () => {
  test("toWorld and toScreen are each other's inverse through the game's camera and canvas", () => {
    // The canvas is drawn at half size, zoomed 2x: one CSS px is one world px.
    assert.deepEqual(toWorld(VIEW, { x: 10, y: 20 }), { x: 100, y: 50 });
    assert.deepEqual(toWorld(VIEW, { x: 490, y: 290 }), { x: 580, y: 320 });
    assert.equal(screenScale(VIEW), 1);
    for (const p of [{ x: 33, y: 77 }, { x: 400.5, y: 12 }]) {
      const back = toScreen(VIEW, toWorld(VIEW, p));
      assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9);
    }
  });

  test("dragTo snaps to the grid, keeps whole px without one, and Shift holds one axis", () => {
    const from = { x: 100, y: 200 };
    assert.deepEqual(dragTo(from, { x: 0, y: 0 }, { x: 13.4, y: -7.6 }, { grid: 0, axisLock: false }), { x: 113, y: 192 });
    assert.deepEqual(dragTo(from, { x: 0, y: 0 }, { x: 13.4, y: -7.6 }, { grid: 16, axisLock: false }), { x: 112, y: 192 });
    assert.deepEqual(dragTo(from, { x: 0, y: 0 }, { x: 30, y: 9 }, { grid: 16, axisLock: true }), { x: 128, y: 200 });
    assert.deepEqual(dragTo(from, { x: 0, y: 0 }, { x: 3, y: -40 }, { grid: 0, axisLock: true }), { x: 100, y: 160 });
    // An axis that doesn't move keeps its value even off the grid.
    assert.deepEqual(dragTo({ x: 101.5, y: 7 }, { x: 0, y: 0 }, { x: 0, y: 20 }, { grid: 16, axisLock: false }), { x: 101.5, y: 32 });
    assert.equal(snap(23, 16), 16);
    assert.equal(snap(24.6, 0), 25);
  });

  test("entityBox reads the body, then the sprite, then a 24 px square; frameLook zooms in on small things", () => {
    assert.deepEqual(entityBox({ transform: { x: 5, y: 6 }, body: { width: 10, height: 20 }, sprite: { width: 99 } }), { x: 5, y: 6, width: 10, height: 20 });
    assert.deepEqual(entityBox({ transform: { x: 5, y: 6 }, sprite: { frameWidth: 16, frameHeight: 8 } }, { x: 1, y: 2 }), { x: 1, y: 2, width: 16, height: 8 });
    assert.deepEqual(entityBox(undefined), { x: 0, y: 0, width: 24, height: 24 });
    assert.deepEqual(entityBox({ transform: { x: 1, y: 2 }, emitter: { area: [900, 300] } }), { x: 1, y: 2, width: 900, height: 300 });
    assert.deepEqual(frameLook({ x: 300, y: 200, width: 16, height: 16 }, { width: 960, height: 540, zoom: 1 }), { x: 300, y: 200, zoom: 4 });
    assert.deepEqual(frameLook({ x: 0, y: 0, width: 960, height: 40 }, { width: 960, height: 540, zoom: 1 }), { x: 0, y: 0, zoom: 1 });
  });
});

describe("viewport tools: the edits", () => {
  test("freshId numbers past what's taken; placeEdit names the prefab and where", () => {
    assert.equal(freshId("coin-3", ["coin-3", "coin-4", "coin-6"]), "coin-5");
    assert.equal(freshId("player", ["player", "player-2"]), "player-3");
    assert.deepEqual(placeEdit("prefabs/coin.prefab.json", { x: 10.4, y: 19.6 }, ["coin-1", "coin-2"]), {
      op: "add",
      entity: { id: "coin-3", prefab: "coin", components: { transform: { x: 10, y: 20 } } },
    });
    assert.equal(placeEdit("slime", { x: 0, y: 0 }, []).entity.id, "slime-1");
  });

  test("duplicate copies everything but the id and moves it, even when the prefab held the transform", () => {
    const original = { id: "coin-1", prefab: "coin", components: { sprite: { color: "#fff" } } };
    const copy = duplicate(original, ["coin-1"], { x: 16, y: 0 });
    assert.deepEqual(copy, { id: "coin-2", prefab: "coin", components: { sprite: { color: "#fff" }, transform: { x: 16, y: 0 } } });
    assert.deepEqual(original.components, { sprite: { color: "#fff" } });
  });

  test("reorderEdits is a remove and an add after the right neighbour, and nothing when the order stays", () => {
    const list = ["a", "b", "c", "d"].map((id) => ({ id, components: {} }));
    assert.deepEqual(reorderEdits(list, "d", "b", "before"), [{ op: "remove", entity: "d" }, { op: "add", entity: { id: "d", components: {} }, after: "a" }]);
    assert.deepEqual(reorderEdits(list, "c", "a", "before")?.[1], { op: "add", entity: { id: "c", components: {} }, after: null });
    assert.deepEqual(reorderEdits(list, "a", "d", "after")?.[1], { op: "add", entity: { id: "a", components: {} }, after: "d" });
    assert.equal(reorderEdits(list, "b", "c", "before"), undefined);
    assert.equal(reorderEdits(list, "b", "a", "after"), undefined);
    assert.equal(reorderEdits(list, "b", "b", "after"), undefined);
    assert.equal(reorderEdits(list, "x", "a", "after"), undefined);
  });

  test("Activity says what the person did", () => {
    assert.equal(youDid("Moved coin-3"), "You moved coin-3");
    assert.equal(youDid(undefined), "You changed the scene");
    assert.equal(youDid("Undo Deleted coin-2"), "You undid: deleted coin-2");
    assert.equal(youDid("Redo Moved coin-2"), "You redid: moved coin-2");
  });
});

/** An Editor on the mock's scene file, recording the change events and toasts. */
function setup() {
  const changes: { by: string; label?: string }[] = [];
  const toasts: Toast[] = [];
  const file = new MockSceneFile(
    (_files, by, label) => changes.push({ by, ...(label ? { label } : {}) }),
    () => undefined,
  );
  const runs: { command: string; args: string[] }[] = [];
  const editor = new Editor({
    backend: {
      file: async (p) => file.file(p),
      edit: async (r) => file.edit(r),
      undo: async () => file.undo(),
      redo: async () => file.redo(),
      run: async <T>(command: string, args: string[] = []) => {
        runs.push({ command, args });
        return { ok: true, exitCode: 0, result: {} as T };
      },
    },
    scene: () => file.path,
    liveIds: () => file.entities.map((e) => e.id),
    toast: (t) => toasts.push(t),
  });
  const at = (id: string) => file.entities.find((e) => e.id === id);
  return { file, editor, changes, toasts, runs, at };
}

describe("the editor against the mock's scene file", () => {
  test("a drag writes transform.x and y as one edit, labelled for undo and Activity", async () => {
    const { editor, changes, at } = setup();
    assert.equal(await editor.move("coin-3", { x: 432, y: 352 }), true);
    assert.deepEqual(at("coin-3")!.components.transform, { x: 432, y: 352 });
    assert.deepEqual(changes, [{ by: "studio", label: "Moved coin-3" }]);
    // Dropping it where it is writes nothing.
    assert.equal(await editor.move("coin-3", { x: 432, y: 352 }), false);
    assert.equal(changes.length, 1);
  });

  test("when the agent wrote the file in between (409), the edit is made again on the new version", async () => {
    const { file, editor, changes, at } = setup();
    await editor.entities();
    file.agentChanged([{ op: "set", id: "ledge-1", path: ["components", "body", "width"], value: 200 }]);
    assert.equal(await editor.move("ledge-2", { x: 560, y: 330 }), true);
    assert.equal(at("ledge-2")!.components.transform.x, 560);
    assert.equal(at("ledge-1")!.components.body.width, 200, "the agent's work is still there");
    assert.equal(changes.length, 1);
  });

  test("delete, duplicate, rename, reorder and place, then undo and redo", async () => {
    const { file, editor, changes, at } = setup();
    const ids = () => file.entities.map((e) => e.id);
    assert.equal(await editor.duplicate("coin-1", { x: 16, y: 0 }), "coin-6");
    assert.equal(ids()[ids().indexOf("coin-1") + 1], "coin-6", "the copy goes right after the original");
    assert.equal(at("coin-6")!.components.transform.x, at("coin-1")!.components.transform.x + 16);
    assert.equal(await editor.rename("coin-6", "bonus"), true);
    assert.ok(at("bonus"));
    assert.equal(await editor.reorder("bonus", "dusk", "before"), true);
    assert.equal(ids()[0], "bonus");
    assert.equal(await editor.remove("bonus"), true);
    assert.equal(at("bonus"), undefined);
    assert.equal(await editor.placePrefab("slime", { x: 700, y: 480 }), "slime-2");
    assert.deepEqual(at("slime-2"), { id: "slime-2", prefab: "slime", components: { transform: { x: 700, y: 480 } } });
    assert.deepEqual(
      changes.map((c) => c.label),
      ["Duplicated coin-1 as coin-6", "Renamed coin-6 to bonus", "Moved bonus before dusk", "Deleted bonus", "Placed slime-2"],
    );
    assert.equal(await editor.undo(), true);
    assert.equal(at("slime-2"), undefined);
    assert.equal(await editor.undo(), true);
    assert.ok(at("bonus"));
    assert.equal(await editor.redo(), true);
    assert.equal(at("bonus"), undefined);
  });

  test("refusals become toasts and change nothing", async () => {
    const { file, editor, toasts, changes } = setup();
    const before = file.text();
    assert.equal(await editor.rename("coin-1", "coin-2"), false);
    assert.match(toasts.at(-1)!.title, /taken/);
    assert.equal(await editor.move("not-in-the-file", { x: 1, y: 1 }), false);
    assert.match(toasts.at(-1)!.detail!, /tilemap or a script/);
    assert.equal(await editor.redo(), false);
    assert.equal(toasts.at(-1)!.title, "Nothing to redo");
    assert.equal(file.text(), before);
    assert.equal(changes.length, 0);
  });

  test("an undo the agent's work would lose is refused, with the reason", async () => {
    const { file, editor, toasts } = setup();
    await editor.move("coin-2", { x: 1, y: 2 });
    file.agentChanged([{ op: "set", id: "coin-2", path: ["components", "collectible", "value"], value: 3 }]);
    assert.equal(await editor.undo(), false);
    assert.match(toasts.at(-1)!.detail!, /agent/);
  });

  test("a block is placed through ludra add at the clicked point", async () => {
    const { editor, runs } = setup();
    assert.equal(await editor.placeBlock("spike-row", { x: 300.4, y: 499.5 }), true);
    assert.deepEqual(runs, [{ command: "add", args: ["spike-row", "--at", "300,500"] }]);
  });

  test("edits go one at a time, in order", async () => {
    const { editor, at } = setup();
    const results = await Promise.all([editor.move("coin-1", { x: 1, y: 1 }), editor.move("coin-1", { x: 2, y: 2 }), editor.move("coin-1", { x: 3, y: 3 })]);
    assert.deepEqual(results, [true, true, true]);
    assert.deepEqual(at("coin-1")!.components.transform, { x: 3, y: 3 });
  });
});
