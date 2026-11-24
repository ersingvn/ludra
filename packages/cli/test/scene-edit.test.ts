import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdits, EditError, printLike, textVersion } from "../src/scene-edit.ts";

const stringified = (scene: unknown) => `${JSON.stringify(scene, null, 2)}\n`;

const scene = {
  name: "Edits",
  world: { gravity: 1800 },
  entities: [
    { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } },
    { id: "coin-1", prefab: "coin", components: { transform: { x: 200, y: 400 } } },
    { id: "player", components: { transform: { x: 100, y: 482 }, platformer: {} } },
  ],
};

/** The lines that differ between two texts of the same length in lines. */
function changedLines(a: string, b: string): string[] {
  const x = a.split("\n");
  const y = b.split("\n");
  assert.equal(x.length, y.length, `same number of lines:\n${b}`);
  return y.filter((line, i) => line !== x[i]);
}

describe("scene edits: the file stays as it was written", () => {
  it("changes one value on one line", () => {
    const text = stringified(scene);
    const next = applyEdits(text, [{ op: "set", entity: "coin-1", field: "components.transform.x", value: 240 }]);
    assert.deepEqual(changedLines(text, next), ['          "x": 240,']);
    assert.ok(next.endsWith("}\n"));
  });

  it("keeps an agent's own layout: inline objects, tabs, CRLF, number spelling and key order", () => {
    const text = [
      "{",
      '\t"entities": [',
      '\t\t{ "id": "a", "components": { "transform": { "x": 1.50, "y": 2 }, "sprite": { "color": "#fff" } } },',
      '\t\t{ "id": "b", "components": { "transform": { "y": 9, "x": 3 } } }',
      "\t],",
      '\t"legend": { "b": 1, "2": 2, "a": 3 }',
      "}",
      "",
    ].join("\r\n");
    const next = applyEdits(text, [
      { op: "set", entity: "b", field: "components.transform.x", value: 4 },
      { op: "scene", field: "legend.a", value: 5 },
    ]);
    // Only the edited lines change; 1.50 stays 1.50, "y" stays before "x", "2" stays after "b".
    assert.deepEqual(changedLines(text.replaceAll("\r\n", "\n"), next.replaceAll("\r\n", "\n")).map((l) => l.trim()), [
      '{ "id": "b", "components": { "transform": { "y": 9, "x": 4 } } }',
      '"legend": { "b": 1, "2": 2, "a": 5 }',
    ]);
    assert.ok(next.includes("\r\n") && !/[^\r]\n/.test(next), "CRLF kept");
  });

  it("adds an entity in the file's style, after the one named, first or last", () => {
    const text = stringified(scene);
    const coin = { id: "coin-2", prefab: "coin", components: { transform: { x: 300, y: 400 } } };
    const after = JSON.parse(applyEdits(text, [{ op: "add", entity: coin, after: "coin-1" }]));
    assert.deepEqual(after.entities.map((e: { id: string }) => e.id), ["ground", "coin-1", "coin-2", "player"]);
    const first = JSON.parse(applyEdits(text, [{ op: "add", entity: coin, after: null }]));
    assert.equal(first.entities[0].id, "coin-2");
    const last = applyEdits(text, [{ op: "add", entity: coin }]);
    assert.equal(JSON.parse(last).entities[3].id, "coin-2");
    // Written as JSON.stringify(…, null, 2) would, so the file reads the same as before.
    assert.equal(last, stringified({ ...scene, entities: [...scene.entities, coin] }));
  });

  it("removes and renames without rewriting the others", () => {
    const text = stringified(scene);
    const removed = applyEdits(text, [{ op: "remove", entity: "coin-1" }]);
    assert.equal(removed, stringified({ ...scene, entities: [scene.entities[0], scene.entities[2]] }));
    const renamed = applyEdits(text, [{ op: "set", entity: "player", field: "id", value: "hero" }]);
    assert.deepEqual(changedLines(text, renamed), ['      "id": "hero",']);
  });

  it("removes a field when value is left out, and overrides a prefab's component on the entity", () => {
    const text = stringified(scene);
    const next = JSON.parse(
      applyEdits(text, [
        { op: "set", entity: "ground", field: "components.body.height" },
        { op: "set", entity: "coin-1", field: "components.sprite.color", value: "#f00" },
        { op: "set", entity: "player", field: "components.platformer", value: null },
      ]),
    );
    assert.deepEqual(next.entities[0].components.body, { type: "static", width: 960 });
    assert.deepEqual(next.entities[1].components.sprite, { color: "#f00" });
    assert.equal(next.entities[2].components.platformer, null, "null drops a prefab's component");
  });

  it("does all the edits or none, and says what's wrong", () => {
    const text = stringified(scene);
    const bad = (edits: unknown, pattern: RegExp) =>
      assert.throws(
        () => applyEdits(text, edits),
        (err: Error) => err instanceof EditError && pattern.test(err.message),
      );
    bad([], /non-empty/);
    bad([{ op: "set", entity: "nobody", field: "components.transform.x", value: 1 }], /no entity "nobody"/);
    bad([{ op: "set", entity: "coin-1", field: "id", value: "player" }], /"player" is taken/);
    bad([{ op: "add", entity: { id: "ground", components: {} } }], /"ground" is taken/);
    bad([{ op: "add", entity: { components: {} } }], /needs an entity with an id/);
    bad([{ op: "add", entity: { id: "x" }, after: "nobody" }], /no entity "nobody" to add after/);
    bad([{ op: "set", entity: "ground", field: "components.body.type.inner", value: 1 }], /not an object/);
    bad([{ op: "set", entity: "ground", field: "components.__proto__.polluted", value: 1 }], /isn't a field/);
    bad([{ op: "scene", field: "entities", value: [] }], /add.*remove/);
    bad([{ op: "fly" }], /Unknown op/);
    bad([{ op: "set", entity: "ground", field: "components.transform.x", value: 1 }, { op: "remove", entity: "gone" }], /^edits\[1\]: There is no entity "gone"/);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("says to edit the tilemap for one of its cells", () => {
    const text = stringified({ entities: [{ id: "level", components: { tilemap: { rows: ["##"], legend: { "#": { color: "#fff" } } } } }] });
    assert.throws(() => applyEdits(text, [{ op: "remove", entity: "level-0-1" }]), /cell of the tilemap "level".*Edit the tilemap/);
  });

  it("names a version by the text", () => {
    assert.equal(textVersion("a"), textVersion("a"));
    assert.notEqual(textVersion("a"), textVersion("a "));
    assert.match(textVersion(""), /^[0-9a-f]{16}$/);
  });

  it("prints a value the same as the text when nothing changed", () => {
    const text = '{\n    "a": [1,2,  3],\n    "b": { "c": "\\u00e9" }\n}';
    assert.equal(printLike(text, JSON.parse(text)), `${text}\n`, "adds only the trailing newline");
  });
});
