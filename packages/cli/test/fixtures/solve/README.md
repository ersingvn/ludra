# Solve and fuzz fixtures

Small levels whose answers are already known, for testing `ludra solve` and `ludra fuzz` (v0.93). Each one is a full project: `ludra.json`, `scenes/main.scene.json` and `tests/solve.test.json`.
- A solvable fixture's tests include a winning input script and the edges of its timing window, so `ludra test` proves the answers below today.
- `impossible` tests its best attempts instead.

None of them is part of `npm test` yet. To check one, run this from inside its folder:

```bash
node --conditions=ludra-dev ../../../../src/index.ts check
node --conditions=ludra-dev ../../../../src/index.ts test
```

## Shared numbers (2D)

Every 2D fixture uses the arcade engine and the default `platformer`:
- **Physics:** `gravity` 1800 px/s², `speed` 240 px/s, `jumpSpeed` 680 px/s, coyote time 0.1 s.
- **Player:** 28 × 36 px, standing on ground whose top is y 500.
- **Its best jump:** 680² / (2 · 1800) ≈ 128 px high, and 2 · 680 / 1800 ≈ 0.756 s in the air, so ≈ 181 px across on the level.
- **Widest gap it can clear:** the player's width and the coyote time add to that 181 px. Measured with the gap in `narrow-window`, a 225 px gap is clearable and a 235 px gap never is.

Windows below are the wait `W` in `right:Ws, right+jump:0.5s, right:3s`. They were measured by sweeping `W` one frame (1/60 s) at a time and keeping the waits that win. The frame numbers are the frame the jump is pressed on.

## The fixtures

| Fixture | Solvable? | Proven input | Measured | What fuzz should report |
| --- | --- | --- | --- | --- |
| `easy-walk` | Yes | `right:3s` | Shortest win **2.45 s** (frame 147): 586 px at 240 px/s. Any input that holds right for 2.45 s wins. | Nothing: no deaths, no softlocks. |
| `one-jump` | Yes | `right:1.3s, right+jump:0.5s, right:3s` | 150 px gap. Jump window **1.167–1.483 s**, frames 70–89: 20 frames, **0.33 s**. Win at 2.95 s for every jump in it. | Deaths from falling into the gap (the player respawns at the start). No softlock. |
| `narrow-window` | Yes, **tight** | `right:1.45s, right+jump:0.5s, right:3s` | 208 px gap, near the limit. Jump window **1.400–1.483 s**, frames 84–89: **6 frames, 0.1 s**. Jumping a frame earlier lands short; a frame later is too late (off the ledge past coyote time). Win at 2.95 s. | Mostly deaths. Random play should rarely win: a good difficulty signal. |
| `impossible` | **No** | none | 320 px gap, about 90 px beyond the widest clearable gap. No wait from 0.02 to 3 s wins, with a full (0.5 s) or short (0.2 s) jump; its tests pin the best attempt (the last frame on the ledge) failing. | No win ever; deaths only. `solve` should report it unsolvable. |
| `softlock` | Yes | `right:0.85s, right+jump:0.5s, right:3s` | 120 px pit, x 300–420, with a floor 220 px down (top y 720), deeper than the 128 px jump. Jump window **0.617–1.067 s**, frames 37–64 (28 frames). Win at 2.95 s. | **A softlock:** once the player is in the pit (x 300–420, y ≈ 702, grounded), no input ever wins and nobody dies. A test proves it by trying jumps and moves both ways from inside. |
| `needs-key` | Yes, **only key first** | `left:0.9s, right:4s` | The player starts at x 300, the key is behind it at x 80, and a locked door at x 600 (200 px tall: too tall to jump) blocks the goal at x 800. Going left at least **0.817 s** (frame 49) reaches the key; one frame less misses it. Fastest win **3.583 s**. Right-first runs stop at the door; jumping it fails. | No softlock, since the key is always reachable. `solve` must find the out-and-back route (left, then right). |
| `3d-hop` | Yes | `up:0.3s, up+jump:0.5s, up:1s, up+jump:0.5s, up:1s, up+jump:0.5s, up:3s` | 3D on Rapier 3D, `character` defaults (5 m/s, a 2.5 m jump). The plaza (4 m) and two 3 m stepping stones lead to a 4 m landing with the goal at z -22.5; every gap is 4 m. Three jumps:<br>• the start wait works from 0.02 to 0.54 s;<br>• the pause between jumps from 0.86 to 1.14 s.<br>Fastest found **4.367 s**. | Deaths from falling (`fallLimit` -5). Keeps the search honest on Rapier 3D. |

## Notes for the search

- In 2D the player always moves at `speed`, so in `one-jump`, `narrow-window` and `softlock` every winning jump wins on the same frame (2.95 s). The window is all about when to jump, not when you arrive.
- In 3D, a `character` stops sideways movement in the air when no direction is held, so winning scripts hold `up` through each jump.
- `needs-key` uses the `key-and-door` block's scripts (`scripts/key.ts`, `scripts/locked-door.ts`). Its state lives in `door.state.unlocked`, so a snapshot-based search has to copy entity state, not just positions.
