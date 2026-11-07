import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Backend } from "../ui/src/backend.ts";
import type { EditRequest, EditResult, FileText } from "../ui/src/protocol.ts";
import { mergeComponents, prefabPath, SceneDoc } from "../ui/src/panels/scene-doc.ts";

/** A backend with files in memory, and edits that the test answers. */
function fakeBackend(files: Record<string, string>, answer: (req: EditRequest) => EditResult): Backend & { edits: EditRequest[] } {
  const edits: EditRequest[] = [];
  return {
    edits,
    gameUrl: "",
    gameOrigin: "",
    project: async () => ({ name: "t", dir: "", entry: "scenes/main.scene.json", scenes: [], window: { width: 1, height: 1 } }),
    listen: () => () => {},
    run: async () => ({ ok: true, exitCode: 0, result: {} }) as never,
    file: async (path: string): Promise<FileText> => {
      if (!(path in files)) throw new Error(`404 ${path}`);
      return { path, version: `v:${files[path]!.length}`, text: files[path]! };
    },
    edit: async (req) => {
      edits.push(req);
      return answer(req);
    },
    undo: async () => ({ ok: false }),
    redo: async () => ({ ok: false }),
  };
}

const scene = {
  prefabs: { local: { components: { sprite: { color: "#f00" } } } },
  entities: [
    { id: "coin-1", prefab: "coin", components: { transform: { x: 10, y: 20 }, body: { width: 30 } } },
    { id: "mine", prefab: "local", components: { transform: { x: 0, y: 0 } } },
    { id: "level", components: { tilemap: { rows: ["#"], legend: {} } } },
  ],
};
const coin = { components: { body: { type: "static", width: 16, height: 16 }, collectible: {} } };

describe("the inspector's scene file", () => {
  it("reads the scene, finds entities, tilemap cells and prefabs", async () => {
    const backend = fakeBackend({ "scenes/main.scene.json": JSON.stringify(scene), "prefabs/coin.prefab.json": JSON.stringify(coin) }, () => ({ ok: true, version: "x", diagnostics: [] }));
    let changes = 0;
    const doc = new SceneDoc(backend, () => changes++);
    await doc.load("scenes/main.scene.json");
    assert.ok(doc.loaded && doc.error === null);
    assert.equal(doc.entity("coin-1")?.index, 0);
    assert.equal(doc.entity("level-0-0"), undefined);
    assert.equal(doc.tilemapOf("level-0-0"), "level");
    assert.equal(doc.tilemapOf("levels-0-0"), undefined);
    assert.equal(doc.tilemapOf("level-x"), undefined);

    // The scene's own prefabs at once; files once they've loaded.
    assert.deepEqual(doc.prefab("local"), { sprite: { color: "#f00" } });
    assert.equal(doc.prefab("coin"), undefined, "loading");
    const before = changes;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(changes > before, "says when it has it");
    assert.deepEqual(doc.prefab("coin"), coin.components);
    assert.equal(doc.prefab("nothing"), undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(doc.prefab("nothing"), null, "no such file");
  });

  it("merges a prefab under the entity's overrides, one level deep, with null dropping one", () => {
    assert.deepEqual(mergeComponents(coin.components, { body: { width: 30 }, transform: { x: 1, y: 2 }, collectible: null }), {
      body: { type: "static", width: 30, height: 16 },
      transform: { x: 1, y: 2 },
    });
    assert.deepEqual(mergeComponents(null, { a: { b: 1 } }), { a: { b: 1 } });
    assert.equal(prefabPath("coin"), "prefabs/coin.prefab.json");
    assert.equal(prefabPath("prefabs/x.prefab.json"), "prefabs/x.prefab.json");
  });

  it("sends edits with the version it read, and reads the file again after a write or a 409", async () => {
    const files = { "scenes/main.scene.json": JSON.stringify(scene) };
    let reply: EditResult = { ok: false, status: 409, error: "stale", version: "v:new" };
    const backend = fakeBackend(files, () => reply);
    const doc = new SceneDoc(backend, () => {});
    await doc.load("scenes/main.scene.json");
    const version = doc.version;

    // The agent wrote the file: the edit is refused, and the doc holds what's there now.
    files["scenes/main.scene.json"] = JSON.stringify({ entities: [] });
    const refused = await doc.edit([{ op: "remove", entity: "coin-1" }], "Removed coin-1");
    assert.equal(refused.ok, false);
    assert.equal(backend.edits[0]!.version, version);
    assert.equal(backend.edits[0]!.label, "Removed coin-1");
    assert.equal(doc.entity("coin-1"), undefined, "read again");
    assert.notEqual(doc.version, version);

    reply = { ok: true, version: "whatever", diagnostics: [] };
    files["scenes/main.scene.json"] = JSON.stringify({ entities: [{ id: "a", components: {} }] });
    assert.equal((await doc.edit([{ op: "add", entity: { id: "a" } }], "Added a")).ok, true);
    assert.equal(doc.entity("a")?.index, 0);
  });

  it("says why when the file can't be read", async () => {
    const doc = new SceneDoc(fakeBackend({ "scenes/bad.scene.json": "{ nope" }, () => ({ ok: true, version: "", diagnostics: [] })), () => {});
    await doc.load("scenes/bad.scene.json");
    assert.match(doc.error ?? "", /isn't valid JSON/);
    await doc.load("scenes/missing.scene.json");
    assert.match(doc.error ?? "", /404/);
  });
});
