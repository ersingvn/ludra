import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actionsUsed, InputScript, runTest, simulate, validateScene, World, type EntityDef, type SceneDef, type Script } from "../src/index.ts";

const ground: EntityDef = { id: "ground", components: { transform: { x: 480, y: 520 }, body: { type: "static", width: 960, height: 40 } } };

function hero(x: number, extra: Record<string, unknown> = {}): EntityDef {
  return { id: "hero", components: { transform: { x, y: 480 }, body: { type: "dynamic", width: 24, height: 40 }, platformer: { speed: 200 }, ...extra } };
}

function key(id: string, x: number, name = "key", count = 1): EntityDef {
  return { id, components: { transform: { x, y: 480 }, body: { type: "static", width: 16, height: 16, sensor: true }, item: { name, count } } };
}

function door(x: number, lock: Record<string, unknown> = {}): EntityDef {
  return { id: "door", components: { transform: { x, y: 460 }, body: { type: "static", width: 20, height: 80 }, lock: { needs: "key", ...lock } } };
}

function npc(dialogue: unknown, x = 140): EntityDef {
  return { id: "smith", components: { transform: { x, y: 480 }, body: { type: "static", width: 24, height: 40, sensor: true }, dialogue: dialogue as Record<string, unknown> } };
}

function scene(...entities: EntityDef[]): SceneDef {
  const { scene, diagnostics } = validateScene({ entities: [ground, ...entities] });
  assert.ok(scene, JSON.stringify(diagnostics.filter((d) => d.severity === "error"), null, 2));
  return scene;
}

function run(s: SceneDef, inputs = "", seconds = 1, options: ConstructorParameters<typeof World>[1] = {}): World {
  const w = new World(s, options);
  simulate(w, InputScript.parse(inputs), Math.round(seconds * 60));
  return w;
}

/** Plays on from where the world is, with inputs counted from now. */
function more(w: World, inputs: string, frames: number): void {
  const script = InputScript.parse(inputs);
  const start = w.frame;
  for (let i = 0; i < frames; i++) w.step(script.at(w.frame - start));
}

const events = (w: World, type: string) => w.events.filter((e) => e.type === type);

const SMITH = {
  lines: [
    { speaker: "Smith", text: "The bridge is out." },
    {
      text: "Will you fetch my hammer?",
      choices: [
        { text: "Yes", set: { quest: "hammer" }, next: "thanks" },
        { text: "No", end: true },
      ],
    },
    { text: "Suit yourself.", end: true },
    { id: "thanks", text: "Thank you! It's in the old mine.", give: { map: 1 } },
  ],
};

describe("inventory", () => {
  test("an item is picked up into world.items, fires pickup and adds no score", () => {
    const w = run(scene(hero(100), key("key-1", 160), key("gold-1", 220, "gold", 30)), "right:1s", 1.2);
    assert.deepEqual(w.items, { key: 1, gold: 30 });
    assert.equal(w.score, 0);
    assert.deepEqual(
      events(w, "pickup").map((e) => e.type === "pickup" && [e.item, e.name, e.count]),
      [["key-1", "key", 1], ["gold-1", "gold", 30]],
    );
    assert.equal(w.get("key-1"), undefined);
  });

  test("a lock says locked once per touch, then opens with the key and uses it up", () => {
    const locked = run(scene(hero(100), door(160)), "right:1s, wait:0.2s, left:0.3s, right:0.5s", 2.2);
    assert.equal(events(locked, "locked").length, 2, "pressing against it is one touch; coming back is another");
    assert.ok(locked.get("door"), "still shut");

    const opened = run(scene(hero(100), key("key-1", 130), door(200)), "right:1.5s", 1.6);
    assert.equal(events(opened, "unlock").length, 1);
    assert.equal(opened.get("door"), undefined);
    assert.deepEqual(opened.items, {}, "take: true uses the key");
    assert.ok(opened.get("hero")!.transform.x > 260, "and the hero walks through");

    const pass = run(scene(hero(100), key("key-1", 130), door(200, { take: false })), "right:1s", 1.1);
    assert.deepEqual(pass.items, { key: 1 });
  });

  test("goal.requires waits for the item", () => {
    const goal: EntityDef = { id: "exit", components: { transform: { x: 300, y: 480 }, body: { type: "static", width: 20, height: 40, sensor: true }, goal: { requires: { key: 1 } } } };
    assert.equal(run(scene(hero(100), goal), "right:1.5s", 1.6).won, false);
    assert.equal(run(scene(hero(100), key("key-1", 200), goal), "right:1.5s", 1.6).won, true);
  });

  test("tests assert on items and flags", () => {
    const s = scene(hero(100), key("key-1", 160));
    const pass = runTest(s, { name: "t", inputs: "right:0.5s", assert: ["items.key == 1", "items.gold == 0", "items.key == 0 at 0.05s", "flags.helped == false"] });
    assert.ok(pass.pass, JSON.stringify(pass.results));
    const unset = runTest(s, { name: "t", assert: ['flags.quest == "hammer"'] });
    assert.equal(unset.pass, false);
    assert.match(unset.results[0]!.message, /not set/);
    const carried = runTest(s, { name: "t", carry: { flags: { quest: "hammer" } }, assert: ['flags.quest == "hammer"'] });
    assert.ok(carried.pass);
  });

  test("items and flags carry over from the scene before", () => {
    const w = new World(scene(hero(100)), { carry: { items: { key: 2 }, flags: { metSmith: true } } });
    assert.deepEqual(w.items, { key: 2 });
    assert.deepEqual(w.flags, { metSmith: true });
  });
});

describe("dialogue", () => {
  test("action near someone opens it; lines go on; a choice sets flags and jumps; the box closes", () => {
    const w = run(scene(hero(100), npc(SMITH)), "action:2f, wait:0.2s, action:2f, wait:0.2s, action:2f, wait:0.2s, action:2f", 1.2);
    assert.deepEqual(
      w.events.filter((e) => ["talk", "say", "choose", "endtalk"].includes(e.type)).map((e) => (e.type === "say" ? `say ${e.line}` : e.type === "choose" ? `choose ${e.choice}` : e.type)),
      ["talk", "say 0", "say 1", "choose 0", "say 3", "endtalk"],
    );
    assert.deepEqual(w.flags, { quest: "hammer" });
    assert.deepEqual(w.items, { map: 1 }, "the line's give happens when it is shown");
    assert.equal(w.talking, undefined);
  });

  test("down picks the other choice; world.talking shows the line", () => {
    const w = run(scene(hero(100), npc(SMITH)), "action:2f, wait:0.2s, action:2f, wait:0.2s, down:2f", 0.6);
    assert.deepEqual(w.talking, { entity: "smith", line: 1, choice: 1, text: "Will you fetch my hammer?", speaker: "", choices: ["Yes", "No"] });
    more(w, "action:2f", 10);
    assert.equal(w.talking, undefined, '"No" ends it');
    assert.deepEqual(w.flags, {});
  });

  test("the player can't move or jump while talking, nor on the press that ends it", () => {
    const sign = npc({ lines: [{ text: "Danger ahead." }] });
    const w = run(scene(hero(100), sign), "action:2f, right:0.5s", 0.6);
    assert.ok(w.talking, "still open: right doesn't go on");
    assert.equal(w.get("hero")!.transform.x, 100, "and the hero stays");
    const before = events(w, "jump").length;
    more(w, "jump:2f", 20);
    assert.equal(w.talking, undefined);
    assert.equal(events(w, "jump").length, before, "jump closed the box instead of jumping");
  });

  test("out of range nothing opens, and action does nothing else", () => {
    const w = run(scene(hero(100), npc(SMITH, 400)), "action:2f", 0.3);
    assert.equal(events(w, "talk").length, 0);
  });

  test("a list of dialogues uses the first whose when/has holds", () => {
    const later = [
      { when: { quest: "done" }, lines: [{ text: "My hammer! Thank you." }] },
      { has: { hammer: 1 }, lines: [{ text: "Is that my hammer?", take: { hammer: 1 }, set: { quest: "done" } }] },
      { lines: [{ text: "Hello." }] },
    ];
    const said = (w: World) => events(w, "say").map((e) => (e.type === "say" ? e.text : ""));
    assert.deepEqual(said(run(scene(hero(100), npc(later)), "action:2f", 0.2)), ["Hello."]);
    const w = run(scene(hero(100), npc(later)), "action:2f, wait:0.2s, action:2f, wait:0.2s, action:2f", 0.8, { carry: { items: { hammer: 1 } } });
    assert.deepEqual(said(w), ["Is that my hammer?", "My hammer! Thank you."]);
    assert.deepEqual(w.items, {});
  });

  test("choices with a condition show only when it holds", () => {
    const shop = npc({ lines: [{ text: "Buy?", choices: [{ text: "Sword (30 gold)", has: { gold: 30 }, take: { gold: 30 }, give: { sword: 1 } }, { text: "Leave", end: true }] }] });
    const poor = run(scene(hero(100), shop), "action:2f", 0.2);
    assert.deepEqual(poor.talking?.choices, ["Leave"]);
    const rich = run(scene(hero(100), shop), "action:2f, wait:0.2s, action:2f", 0.5, { carry: { items: { gold: 40 } } });
    assert.deepEqual(rich.items, { gold: 10, sword: 1 });
  });

  test("scripts read and write items and flags, and can't in draw hooks", () => {
    const story: Script = {
      update({ world }) {
        if (world.frame === 1) {
          world.items.add("coin", 3);
          world.flags.seen = true;
        }
        if (world.frame === 2) {
          world.self = world.items.take("coin", 5) as never;
          world.flags.took = world.items.take("coin", 2);
        }
      },
      drawUI({ world }) {
        world.flags.bad = 1;
      },
    };
    const s = scene(hero(100), { id: "story", components: { transform: { x: 0, y: 0 }, script: { src: "story.ts" } } });
    const w = run(s, "", 0.1, { scripts: { "story.ts": story } });
    assert.deepEqual(w.items, { coin: 1 });
    assert.deepEqual(w.flags, { seen: true, took: true });
    const e = w.get("story")!;
    assert.throws(() => w.callDrawHook(e, "drawUI", {} as never), /draw hook/);
    const bad: Script = {
      update({ world }) {
        world.flags.x = { no: 1 } as never;
      },
    };
    assert.throws(() => run(s, "", 0.1, { scripts: { "story.ts": bad } }), /must be a number, a string or true\/false/);
  });

  test("save and restore mid-conversation give back the same future", () => {
    const s = scene(hero(100), npc(SMITH), key("key-1", 300));
    const inputs = InputScript.parse("action:2f, wait:0.2s, action:2f, wait:0.2s, down:2f, wait:0.1s, up:2f, action:2f, wait:0.2s, action:2f, right:1s");
    const reference = new World(s);
    simulate(reference, inputs, 150);
    const w = new World(s);
    simulate(w, inputs, 20);
    const saved = w.save();
    more(w, "action:2f, down:2f, action:2f, right:1s", 100);
    w.restore(saved);
    while (w.frame < 150) w.step(inputs.at(w.frame));
    assert.deepEqual(w.snapshot(), reference.snapshot());
    assert.deepEqual(w.events, reference.events);
    assert.deepEqual(w.flags, { quest: "hammer" });
    assert.deepEqual(w.items, { map: 1, key: 1 });
  });

  test("touch screens get the action button, and up/down for choices", () => {
    assert.deepEqual(actionsUsed([scene(hero(100), npc(SMITH))]), ["left", "right", "up", "down", "jump", "action"]);
    assert.deepEqual(actionsUsed([scene(hero(100), npc({ lines: [{ text: "Hi." }] }))]), ["left", "right", "jump", "action"]);
  });
});

describe("story checks", () => {
  const codes = (entities: unknown[]) => validateScene({ entities }).diagnostics.map((d) => `${d.code} ${d.path}`);

  test("dialogue lines, choices and next are checked with paths", () => {
    const found = codes([
      { id: "a", components: { transform: { x: 0, y: 0 }, dialogue: { lines: [] } } },
      { id: "b", components: { transform: { x: 0, y: 0 }, dialogue: { lines: [{ text: "Hi", next: 4 }, { speaker: 2 }, { text: "Go", choices: [{ text: "x", next: "nowhere" }, { text: "y", set: { a: [1] } }] }] } } },
      { id: "c", components: { transform: { x: 0, y: 0 }, dialogue: [{ when: "x", lines: [{ text: "Hi", give: { gold: 0 } }] }] } },
    ]);
    for (const expected of [
      "E_DIALOGUE_LINES entities[0].components.dialogue.lines",
      "E_DIALOGUE_NEXT entities[1].components.dialogue.lines[0].next",
      "E_DIALOGUE_LINE entities[1].components.dialogue.lines[1].text",
      "E_INVALID_FIELD entities[1].components.dialogue.lines[1].speaker",
      "E_DIALOGUE_NEXT entities[1].components.dialogue.lines[2].choices[0].next",
      "E_STORY_SET entities[1].components.dialogue.lines[2].choices[1].set",
      "E_STORY_WHEN entities[2].components.dialogue[0].when",
      "E_STORY_ITEMS entities[2].components.dialogue[0].lines[0].give",
    ]) {
      assert.ok(found.includes(expected), `${expected}\n in ${found.join("\n")}`);
    }
  });

  test("items must be sensors; locks shouldn't be; needed items should come from somewhere", () => {
    const found = codes([
      hero(100),
      { id: "k", components: { transform: { x: 0, y: 0 }, body: { width: 10, height: 10 }, item: { name: "key" } } },
      { id: "d", components: { transform: { x: 0, y: 0 }, body: { width: 10, height: 10, sensor: true }, lock: { needs: "crowbar" } } },
      { id: "g", components: { transform: { x: 0, y: 0 }, body: { width: 10, height: 10, sensor: true }, goal: { requires: { key: 1, gem: 1 } } } },
    ]);
    assert.ok(found.includes("E_ITEM_NEEDS_SENSOR entities[1].components.body.sensor"), found.join("\n"));
    assert.ok(found.includes("W_LOCK_SENSOR entities[2].components.body.sensor"));
    assert.ok(found.includes("W_ITEM_NOWHERE entities[2].components.lock.needs"));
    assert.ok(found.includes("W_ITEM_NOWHERE entities[3].components.goal.requires.gem"));
    assert.ok(!found.includes("W_ITEM_NOWHERE entities[3].components.goal.requires.key"), "the key is in the scene");
  });

  test("an item a dialogue gives counts as given", () => {
    const found = codes([
      hero(100),
      npc({ lines: [{ text: "Take this.", give: { pass: 1 } }] }),
      { id: "d", components: { transform: { x: 0, y: 0 }, body: { width: 10, height: 10 }, lock: { needs: "pass" } } },
    ]);
    assert.ok(!found.some((c) => c.startsWith("W_ITEM_NOWHERE")), found.join("\n"));
  });
});
