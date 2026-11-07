// index.html?mock=1: a Backend with no server. The game is mock-game.html, and an "agent" edits files
// on a timer, so every panel has something real-looking to show.

import type { Backend, Connection } from "../backend.ts";
import type { CheckResult, Command, RunCommand, Diagnostic, EditRequest, EditResult, FileChange, FileText, ReviewResult, RunResponse, ServerEvent, TestRunResult, UndoResult } from "../protocol.ts";
import type { Studio } from "../studio.ts";
import { MOCK_COMPONENTS } from "./components.ts";
import { MockSceneFile, type GameOp } from "./edits.ts";
import { MOCK_BLOCKS, MOCK_PREFABS, MOCK_PROJECT, type MockEntity } from "./scene.ts";

interface Step {
  files: FileChange[];
  ops: unknown[];
  /** What check says after this change. */
  broken?: boolean;
}

const BROKEN: Diagnostic = {
  severity: "error",
  code: "E_BODY_SIZE",
  path: "entities[6].components.body.width",
  message: "body.width must be a positive number, but it is -160.",
  fix: 'Set entities[6].components.body.width to the ledge\'s width, e.g. 160. A negative size doesn\'t flip a body; use "flipX" on the sprite.',
  file: "scenes/main.scene.json",
};

const WARNING: Diagnostic = {
  severity: "warning",
  code: "W_UNUSED_ASSET",
  path: "assets/old-slime.svg",
  message: "assets/old-slime.svg isn't used by any scene, prefab or script.",
  fix: "Delete it, or use it: sprite.image in prefabs/slime.prefab.json.",
  file: "scenes/main.scene.json",
};

const NEW_COIN: MockEntity = {
  id: "coin-6",
  prefab: "prefabs/coin.prefab.json",
  parent: "coins",
  components: {
    transform: { x: 760, y: 200 },
    body: { type: "sensor", width: 16, height: 16 },
    sprite: { color: "#ffd166", image: "assets/coin.svg", frameWidth: 16, frameHeight: 16, fps: 8 },
    collectible: { value: 5, sound: "coin-big" },
  },
};

const STEPS: Step[] = [
  {
    files: [
      {
        path: "scenes/main.scene.json",
        kind: "scene",
        change: "changed",
        diff: `--- a/scenes/main.scene.json
+++ b/scenes/main.scene.json
@@ -118,11 +118,11 @@
       "id": "slime-1",
       "name": "Moss Slime",
       "prefab": "prefabs/slime.prefab.json",
       "components": {
         "transform": { "x": 510, "y": 306 },
-        "patrol": { "from": 470, "to": 595, "speed": 50 },
+        "patrol": { "from": 470, "to": 595, "speed": 85 },
         "hazard": { "damage": 1, "stompable": true }
       }
     },
`,
      },
    ],
    ops: [{ op: "set", id: "slime-1", path: ["components", "patrol", "speed"], value: 85 }],
  },
  {
    files: [
      {
        path: "scripts/wren.ts",
        kind: "script",
        change: "changed",
        diff: `--- a/scripts/wren.ts
+++ b/scripts/wren.ts
@@ -12,14 +12,19 @@ import { defineScript } from "@ludra/core";
 export default defineScript({
   state: { lanternLit: true },
   update(self, world, input) {
-    // Land softly: a small dust puff
-    if (self.body.landed) world.emit("dust", { x: self.x, y: self.y + 17 });
+    // Land softly: a dust puff that grows with the fall
+    if (self.body.landed) {
+      const size = Math.min(3, self.body.fallSpeed / 300);
+      world.emit("dust", { x: self.x, y: self.y + 17, size });
+      if (size > 2) world.shake(0.15, 3);
+    }
     if (input.pressed("down") && self.state.lanternLit) {
       self.state.lanternLit = false;
       world.sound("lantern-off");
     }
   },
 });
`,
      },
    ],
    ops: [{ op: "keep" }],
  },
  {
    files: [
      {
        path: "scenes/main.scene.json",
        kind: "scene",
        change: "changed",
        diff: `--- a/scenes/main.scene.json
+++ b/scenes/main.scene.json
@@ -96,6 +96,17 @@
       }
     },
+    {
+      "id": "coin-6",
+      "prefab": "prefabs/coin.prefab.json",
+      "parent": "coins",
+      "components": {
+        "transform": { "x": 760, "y": 200 },
+        "collectible": { "value": 5, "sound": "coin-big" }
+      }
+    },
     {
       "id": "spikes",
       "components": {
`,
      },
      {
        path: "assets/coin-big.wav",
        kind: "asset",
        change: "added",
      },
    ],
    ops: [{ op: "add", entity: NEW_COIN }],
  },
  {
    files: [
      {
        path: "scenes/main.scene.json",
        kind: "scene",
        change: "changed",
        diff: `--- a/scenes/main.scene.json
+++ b/scenes/main.scene.json
@@ -61,7 +61,7 @@
     {
       "id": "ledge-3",
       "components": {
-        "transform": { "x": 770, "y": 240 },
-        "body": { "type": "static", "width": 160, "height": 20 },
+        "transform": { "x": 770, "y": 240 },
+        "body": { "type": "static", "width": -160, "height": 20 },
         "sprite": { "color": "#7a5a3c", "image": "assets/sandstone.svg", "tile": true }
       }
     },
`,
      },
    ],
    ops: [{ op: "reject", diagnostics: [BROKEN] }],
    broken: true,
  },
  {
    files: [
      {
        path: "scenes/main.scene.json",
        kind: "scene",
        change: "changed",
        diff: `--- a/scenes/main.scene.json
+++ b/scenes/main.scene.json
@@ -61,7 +61,7 @@
     {
       "id": "ledge-3",
       "components": {
         "transform": { "x": 770, "y": 240 },
-        "body": { "type": "static", "width": -160, "height": 20 },
+        "body": { "type": "static", "width": 180, "height": 20 },
         "sprite": { "color": "#7a5a3c", "image": "assets/sandstone.svg", "tile": true, "flipX": true }
       }
     },
`,
      },
    ],
    ops: [{ op: "set", id: "ledge-3", path: ["components", "body", "width"], value: 180 }],
  },
  {
    files: [
      {
        path: "tests/gameplay.test.json",
        kind: "test",
        change: "changed",
        diff: `--- a/tests/gameplay.test.json
+++ b/tests/gameplay.test.json
@@ -8,5 +8,10 @@
       "inputs": "right:1.2s, right+jump:20f, right:2s",
       "assert": ["player.y < 400", "deaths == 0"]
+    },
+    {
+      "name": "the big coin is worth five",
+      "inputs": "right:6s",
+      "assert": ["score >= 5", "events includes collect"]
     }
   ]
 }
`,
      },
    ],
    ops: [],
  },
  {
    files: [
      {
        path: "game.md",
        kind: "design",
        change: "changed",
        diff: `--- a/game.md
+++ b/game.md
@@ -3,8 +3,9 @@
 ## Look

-Dusk over sandstone. Warm lantern light against a violet sky.
+Dusk over sandstone. Warm lantern light against a violet sky, and the
+only bright things are what the player wants: coins, the beacon, Wren.

 Palette: \`#111833\` \`#3b2d5a\` \`#c46e4e\` \`#f2a93b\` \`#ffd166\` \`#6cc47d\`
-- Enemies are soft and round; hazards are sharp and grey.
+- Enemies are soft and round; hazards are sharp, grey and never warm.
`,
      },
    ],
    ops: [{ op: "restart", reason: "game.md isn't hot" }],
  },
];

export class MockBackend implements Backend {
  readonly gameUrl = "mock-game.html";
  readonly gameOrigin = "*";
  private onEvent: ((e: ServerEvent) => void) | null = null;
  private version = 1;
  private broken = false;
  private stepIndex = 0;
  private hasBigCoinTest = false;
  private studio: Studio | null = null;
  /** The scene file as Studio's edits see it. */
  readonly scene = new MockSceneFile(
    (files, by, label) => {
      this.version++;
      this.onEvent?.({ type: "change", version: this.version, at: new Date().toISOString(), files, by, ...(label ? { label } : {}) });
    },
    (ops) => setTimeout(() => this.studio?.link.sendRaw({ type: "mock-apply", ops, files: [this.scene.path] }), 60),
  );

  async project() {
    await delay(60);
    return { ...MOCK_PROJECT, prefabs: MOCK_PREFABS, blocks: MOCK_BLOCKS, components: MOCK_COMPONENTS };
  }

  async file(path: string): Promise<FileText> {
    await delay(40);
    return this.scene.file(path);
  }

  async edit(req: EditRequest): Promise<EditResult> {
    await delay(50);
    return this.scene.edit(req);
  }

  async undo(): Promise<UndoResult> {
    await delay(40);
    return this.scene.undo();
  }

  async redo(): Promise<UndoResult> {
    await delay(40);
    return this.scene.redo();
  }

  listen(onEvent: (e: ServerEvent) => void, onConnection: (s: Connection) => void): () => void {
    this.onEvent = onEvent;
    onConnection("live");
    setTimeout(() => onEvent({ type: "hello", version: this.version }), 0);
    return () => (this.onEvent = null);
  }

  /** The agent at work: one change every few seconds, round and round. */
  start(studio: Studio): void {
    this.studio = studio;
    const next = () => {
      const step = STEPS[this.stepIndex % STEPS.length]!;
      this.stepIndex++;
      this.version++;
      this.broken = Boolean(step.broken);
      if (step.files.some((f) => f.path.startsWith("tests/"))) this.hasBigCoinTest = true;
      // The agent wrote the scene: Studio's edits against the old version are refused from now on.
      if (step.files.some((f) => f.path === this.scene.path)) this.scene.agentChanged(step.ops.filter((op) => ["set", "add"].includes((op as GameOp).op)) as GameOp[]);
      this.onEvent?.({ type: "change", version: this.version, at: new Date().toISOString(), files: step.files, by: "files" });
      // The game hears about it through its own /events in the real thing; here we tell it.
      if (step.ops.length > 0) setTimeout(() => studio.link.sendRaw({ type: "mock-apply", ops: step.ops, files: step.files.map((f) => f.path) }), 140);
      setTimeout(next, this.stepIndex < STEPS.length ? 6500 : 11000);
    };
    setTimeout(next, 2200);
    // Fill Tests and Review once, so they aren't empty in screenshots.
    setTimeout(() => void studio.runCommand("test", true), 900);
    setTimeout(() => void studio.runCommand("review", true), 1400);
  }

  async run<T>(command: RunCommand, args: string[] = []): Promise<RunResponse<T>> {
    if (command === "add") return { ok: true, exitCode: 0, result: this.addBlock(args) as T };
    await delay(command === "review" ? (args.includes("--fast") ? 900 : 2200) : command === "test" ? 1100 : 450);
    let result: CheckResult | TestRunResult | ReviewResult;
    if (command === "check") result = this.check();
    else if (command === "test") result = this.test();
    else result = this.review();
    return { ok: result.ok, exitCode: result.ok ? 0 : 1, result: result as T };
  }

  /** `ludra add <block> --at x,y [--id name]`: one entity where it was asked for, through the same edit path. */
  private addBlock(args: string[]): unknown {
    const [block = "", ...rest] = args;
    const at = (rest.includes("--at") ? rest[rest.indexOf("--at") + 1]! : "0,0").split(",").map(Number);
    const id = rest.includes("--id") ? rest[rest.indexOf("--id") + 1]! : `${block}-${this.scene.entities.length + 1}`;
    const entity: MockEntity = { id, components: { transform: { x: at[0] ?? 0, y: at[1] ?? 0 }, body: { type: "static", width: 64, height: 20 }, sprite: { color: "#9aa5b1" } } };
    const result = this.scene.edit({ path: this.scene.path, version: this.scene.version, edits: [{ op: "add", entity }], label: `Added ${block}` });
    return result.ok ? { block, entities: [{ id, x: at[0], y: at[1] }], files: [], effects: [] } : { error: result.error ?? "refused" };
  }

  private check(): CheckResult {
    const diagnostics = this.broken ? [BROKEN, WARNING] : [WARNING];
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    return { ok: errors === 0, file: "scenes/main.scene.json", errors, warnings: diagnostics.length - errors, diagnostics };
  }

  private test(): TestRunResult {
    const pass = (name: string, duration: number, sources: string[]) => ({ name, pass: true, duration, results: sources.map((source) => ({ source, pass: true, actual: true, time: duration, message: "ok" })) });
    const gameplay = [
      pass("Wren reaches the first ledge", 0.21, ["player.y < 400", "deaths == 0"]),
      pass("the beacon can be reached", 0.48, ["won == true"]),
      {
        name: "the slime can be stomped",
        pass: false,
        duration: 0.36,
        results: [
          { source: "events includes stomp", pass: false, actual: ["jump", "collect", "die"], time: 6, message: "no stomp event in 6.00 s; it fired jump, collect, die" },
          { source: "deaths == 0", pass: false, actual: 1, time: 6, message: "deaths is 1" },
        ],
      },
    ];
    if (this.hasBigCoinTest) gameplay.push(pass("the big coin is worth five", 0.3, ["score >= 5"]));
    const files = [
      { file: "gameplay.test.json", tests: gameplay },
      { file: "spikes.test.json", tests: [pass("spikes hurt", 0.12, ["deaths == 1"]), pass("a checkpoint saves the climb", 0.4, ["player.x > 300"])] },
    ];
    const all = files.flatMap((f) => f.tests);
    const failed = all.filter((t) => !t.pass).length;
    return { ok: failed === 0, passed: all.length - failed, failed, files };
  }

  private review(): ReviewResult {
    const findings: ReviewResult["findings"] = [
      { level: "issue", area: "fair", code: "R_TIGHT_JUMP", where: "scenes/main.scene.json", message: "The jump from ledge-2 to ledge-3 leaves 3 frames (0.05 s) of room, tighter than a person can count on.", fix: "Move ledge-3 16 px left or 10 px down, then run `ludra solve` to see the window again." },
      { level: "issue", area: "looks", code: "R_OFF_PALETTE", where: "scenes/main.scene.json → spikes", message: "spikes uses #cfd6de, which isn't in game.md's palette.", fix: "Use a color from game.md, or add this one there on purpose." },
      { level: "idea", area: "feel", code: "R_SILENT_EVENT", where: "scenes/main.scene.json", message: "stomp has no sound, so a stomp feels like nothing happened.", fix: 'Add "stomp" to the scene\'s sounds, e.g. a short "squish" preset.' },
      { level: "idea", area: "readable", code: "R_LOW_CONTRAST", where: "scenes/main.scene.json at 4.2 s", message: "Moss Slime is hard to tell from the hills behind it (contrast 1.6).", fix: "Lighten the slime or darken the far hills." },
      { level: "idea", area: "players", code: "R_NO_PLAYTEST", where: "recordings/", message: "Nobody has played this game yet, as far as Ludra knows.", fix: "Have a person play it with `ludra dev` and mark moments with 1 2 3 4 N, then read `ludra feedback`." },
      { level: "idea", area: "shipping", code: "R_NO_TOUCH", where: "ludra.json", message: "There are no touch controls, so it can't be played on a phone.", fix: 'Add "touch": "auto" to ludra.json.' },
    ];
    const issues = findings.filter((f) => f.level === "issue").length;
    return { ok: issues === 0, issues, ideas: findings.length - issues, findings };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
