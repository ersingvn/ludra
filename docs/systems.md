# Game systems (v0.98): design and who builds what

v0.98 is the first step from "Ludra makes small arcade games" toward "an AI can make any game in Ludra":
the systems that bigger games stand on. Three parts, built in parallel by three sessions, each on its own
branch cut from `feat/v0.98-systems`, then merged back into it.

Already on `feat/v0.98-systems`: `world.findPath` (2D, `packages/core/src/nav.ts`) and the `chase`
component (2D), with tests, skill docs and a demo.

## Rules for everyone

The same rules as all of Ludra (see `README.md`, "The idea"):

- **Deterministic.** Game state changes only in the simulation (`start`/`update`/`touch`, components), never
  in draw hooks or the browser. No `Math.random`, no `Date`; only `+ - * /` and `Math.sqrt` for anything
  that changes the game (trigonometry from `dmath.ts`). The same inputs give the same game on every machine.
- **Saved.** Any new game state lives on `Entity` or `World` and comes back through `World.save()` /
  `restore()` bit for bit (`packages/physics/test/saving.test.ts` shows how to check).
- **Testable.** A test can drive it with input scripts and assert on it (`packages/core/src/assertions.ts`).
  `ludra play` prints what happened.
- **Checked.** Mistakes in a scene give a `ludra check` diagnostic with a JSON path and a fix
  (`packages/core/src/validate.ts`). `ludra components <name>` documents every field
  (`packages/core/src/components.ts`).
- **No ceiling.** The default look is replaceable: a game's own `drawUI` hook can draw any of it instead.
- **Taught.** The skill (`plugins/ludra/skills/make-2d-platformer-games/SKILL.md`), the templates'
  `CLAUDE.md` and `ludra components` say how to use it. `review` flags what makes it feel unfinished.
- Run `npm test`, and `npm run ludra -- review --strict` on every `packages/cli/templates/*`, before you hand over.
- Commits: `v0.98 <part>: <what>`, small and each one green. Don't push to `main`.

## Parts and who owns which files

| Part | Session | Branch | Owns |
| --- | --- | --- | --- |
| **A. Story: inventory, flags, dialogue** | victus-41 | `feat/systems-story` | new `packages/core/src/story.ts`, new `packages/core/src/dialogue-ui.ts`, its tests |
| **B. Progress: saving the player's game, menus** | victus-d7 | `feat/systems-save` | new `packages/core/src/progress.ts`, `packages/core/src/browser.ts` (except the one call below), its tests |
| **C. 3D: findPath and chase in 3D, integration** | victus-85 | `feat/v0.98-systems` | `packages/core/src/nav.ts`, the `chase` code in `world.ts`, the PR and release |

Everyone needs to touch some shared files: `world.ts`, `components.ts`, `validate.ts`, `types.ts`,
`script.ts`, `assertions.ts`, `review.ts`, `play.ts`, the skill. Keep those edits small and additive (new
fields, new cases, one call), so merges stay easy. Don't reformat or move code you don't own.

Work in a worktree under the repo, never a new folder on the Desktop:

```bash
cd C:\Users\Victus\Desktop\ludra
git worktree add .worktrees/story -b feat/systems-story feat/v0.98-systems   # part A
git worktree add .worktrees/save  -b feat/systems-save  feat/v0.98-systems   # part B
cd .worktrees/<name> && npm install && npm run build
```

When done, tell victus-85 (SendMessage) the branch and last commit. victus-85 merges.

## A. Story: inventory, flags, dialogue (victus-41)

What adventure games, RPGs and anything with a story need, with no script.

### Inventory

- **`item` component:** `{ "name": "key", "count": 1 }` on a sensor body. A player touching it takes it:
  the entity is removed, `world` gains `count` of `name`, and an **`pickup`** event fires
  (`{ entity: <player>, item: <entity id>, name, count }`). Unlike `collectible`, it doesn't add score.
- **`world.items`** in scripts: `get(name) -> number`, `add(name, n = 1)`, `take(name, n = 1) -> boolean`
  (false and no change when there aren't enough), `all() -> Record<string, number>`.
- **Assertions:** `"items.key >= 1"`, `"items.gold == 30 at end"`.
- **Doors and locks with no script:** `requires` on `goal` (`"requires": { "key": 1 }`), and a new
  `lock` component, `{ "needs": "key", "take": true }` on a solid: a player touching it with the item
  removes the lock entity (and the item, when `take`), fires `unlock`. Without the item it fires
  `locked` once per touch (so a game can say "it's locked").

### Flags

- **`world.flags`**: a flat record of string → number | string | boolean, for story state ("talked to the
  smith", "chose to help"). Scripts read and write it. Assertions: `"flags.helped == true"`.

### Dialogue

- **`dialogue` component** on an NPC or a sign:
  ```json
  "dialogue": {
    "range": 48,
    "lines": [
      { "speaker": "Smith", "text": "The bridge is out." },
      { "text": "Will you fetch my hammer?", "choices": [
        { "text": "Yes", "set": { "quest": "hammer" }, "next": 3 },
        { "text": "No", "end": true } ] },
      { "text": "Suit yourself." },
      { "text": "Thank you! It's in the old mine.", "give": { "map": 1 } }
    ],
    "when": { "quest": "done" }
  }
  ```
  `when` (optional) picks this dialogue only when the flags match; a list of dialogues
  (`"dialogue": [ {...}, {...} ]`) uses the first whose `when` matches, so an NPC can say different things
  as the story moves on. A line can `set` flags, `give` items, `take` items, `next` (line index) or `end`.
- **Talking:** the player within `range` px presses `action` to start. While a conversation is open the
  player doesn't move, `action` (or `jump`) goes to the next line, `up`/`down` pick a choice. All in the
  simulation, so input scripts drive it: `"action:2f, wait:0.2s, down:2f, action:2f"`.
- **Events:** `talk` (`{ entity: npc }`) when it opens, `say` (`{ entity, line }`) for each line shown,
  `choose` (`{ entity, choice }`), `endtalk`.
- **State:** `world.talking` → `{ entity, line, choice, text, speaker, choices } | undefined`, read-only to
  scripts and draw hooks, so a game's own `drawUI` can draw the box any way it likes.
- **Default box:** `packages/core/src/dialogue-ui.ts` exports `drawDialogue(ctx, world, view)`, a clean box
  at the bottom with the speaker, wrapped text and the choices. Part B calls it from `browser.ts` (see
  below). When the game has its own `drawUI`, the engine doesn't draw it: the game does.
- **`ludra play`** prints each line said and each choice made, so an agent can read a conversation.
- **`review`:** a `dialogue` no test opens is untested; `talk` and `pickup` count as events players must
  hear or see (silent → flagged, like `collect`).

### Carrying between scenes

Items and flags carry over to the next scene like score: add `items` and `flags` to `WorldOptions.carry`
and to the carry object that `browser.ts` passes on (Part B owns `browser.ts`: tell victus-d7, or make that
one-line change and say so).

## B. Progress: saving the player's game, menus (victus-d7)

A player who closes the tab shouldn't lose an hour of play.

### Saving

- **`progress.ts`:** what a run has achieved, as plain JSON: `{ scene, score, deaths, lives, items, flags,
  checkpoint? }` (items and flags come from Part A through `carry`; until then save what `carry` has).
  `encodeProgress(world, scenePath)` and `decodeProgress(json)` with validation, versioned (`"v": 1`).
- **In the browser:** progress is saved to `localStorage` (key from the game's name in `ludra.json`) each
  time a scene starts and when a checkpoint is reached. Starting the game again offers **Continue**.
  `ludra build` games do the same. Recording and Studio (`?studio=1`) runs never save.
- **Scripts:** `world.save` is taken (the engine's snapshot), so name it `world.progress`:
  `world.progress.save()` (fires `saved`), `world.progress.clear()`, `world.progress.exists`. Headless
  runs keep it in memory so tests can assert `"events.saved >= 1"`.
- A scene can opt out: `"world": { "save": false }` (an arcade game that should always start fresh).

### Menus

- **Pause menu:** `Esc` (and Start on a gamepad, P too) pauses and shows Resume, Restart, Sound on/off,
  and Quit to title (when the game has a title scene: the entry scene in `ludra.json`). Keyboard, gamepad
  and touch.
- **Title:** when progress exists, the entry scene gets **Continue** / **New game** before it starts
  (a small overlay; a game with its own `drawUI` title can read `world.progress.exists` and do it itself).
- The menus pause the simulation clock; nothing in them changes the game except Restart / Continue /
  New game, which start a scene as `goto` does.
- Look: calm and readable, in the game's own font when it loads one; replaceable like everything else.

### The call Part A needs

In `browser.ts`, where the HUD is drawn (`/** The HUD: ... */`), after the game's `drawUI` hooks or the
default HUD: `drawDialogue(ctx, world, view)` when `world.talking` is set and the game has no `drawUI`.
Part A writes `drawDialogue`; you add the call (or Part A does, in one commit that says so).

## C. 3D and integration (victus-85)

- `world.findPath` in 3D: a grid over x/z from static bodies' footprints, for walkers on the ground.
- `chase` in 3D, with a `character` or a dynamic body as the target, around walls on x/z.
- Merging A and B, the release notes, version bump to 0.98.0, the PR and the release.
