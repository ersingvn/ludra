# Designing good games with Ludra

Ludra makes sure the game *works*. This guide is about making it *good*. Read it before you design a level. Where a rule can be checked, the check is given; use it.

## 1. Start with an idea, not a level

Before touching JSON, write three lines for yourself:

1. **The hook:** one sentence a player would repeat. "Keys open doors, but a slime guards every key."
2. **The core mechanic:** the one action the whole level is about (jumping on a pad, outrunning a chaser, timing a falling platform).
3. **The mood:** a place and a feeling. "A mossy ruin at dusk, tense but cozy."

Every later choice (blocks, palette, sounds, pacing) should serve those three lines. A level that tries to be about everything is about nothing.

**Never ship the template unchanged.** At minimum, change the layout, the palette and the title (`ludra.json`), and add one mechanic the template doesn't have.

## 2. Build from blocks, then make them yours

Run `npx @ludra/cli blocks` and start from tested pieces:

```bash
npx @ludra/cli add chasing-enemy --at 700,500
npx @ludra/cli add key-and-door --at 400,500
```

Then customize. Change `params` (speed, range, delay), restyle the art, and combine blocks into something new: a key guarded by a turret, a teleporter that leads onto a falling platform. Write a new script only for what no block covers. Blocks are tested; your new script needs its own test.

## 3. Level design

**Teach, test, twist.** Introduce each mechanic in three beats:

1. **Teach:** show it where failure is cheap. The first jump pad has solid ground all around it.
2. **Test:** use it with some risk. The second pad launches over spikes.
3. **Twist:** combine it with something else. A pad launches you past a chasing enemy onto a falling platform.

**Pacing.** Alternate tension and rest. After a hard section, give the player a safe flat stretch, a coin, a breather. Put the hardest moment near the end, then a short victory lap to the goal.

**One new idea per screen** (960px). Never introduce two unfamiliar dangers at once.

**Telegraph danger.** The player should see a threat before it can hurt them: enemies visible from a distance, turrets that fire on a rhythm, platforms that shake before they fall. No hazards that appear without warning.

**Readable paths.** The way forward should be obvious. Use coins as breadcrumbs to suggest a route or a jump arc. Optional secrets are fine; mandatory hidden paths are not.

**Respect the numbers.** With the defaults, a jump rises ~128px and reaches ~180px. Design jumps at **≤ 80%** of that (rises ≤ 100px, gaps ≤ 140px), so a human with imperfect timing still makes them.

## 4. Fairness you can prove

A level an agent can beat with frame-perfect input can still be miserable for a human. Check these, they are cheap:

- **Completable without dying:** a test with `won == true` and `deaths == 0`. Required.
- **Timing windows:** every critical jump should work across a window of **at least 0.2s**. Sweep the start time and confirm several values succeed:

  ```bash
  for w in 0.3s 0.4s 0.5s 0.6s; do npx @ludra/cli play --inputs "<prefix>, wait:$w, right+jump:0.45s" | grep -cE "win|stomp"; done
  ```

  If only one value works, widen the platform, slow the enemy, or move the hazard.
- **One mechanic per test:** besides the full playthrough, test each mechanic in isolation ("the door blocks you without the key", "the chaser waits while you're far away"). Make sure nothing else interferes. If the chaser kills the player before they reach the door, that test proves nothing about the door.
- **No blind jumps:** the landing spot is on screen when the player takes off.
- **Cheap failure:** if death is likely, the respawn should be close. Split long levels or add checkpoints when they exist.

## 5. Game feel (juice)

Every player action deserves feedback. Add `effects` for each event the level uses:

| Moment | Feedback |
| --- | --- |
| jump, land | small dust puff (5-6 particles, short life), soft sound (`jump`, `thud`) |
| collect | bright burst in the item's color, `coin` |
| stomp | burst in the enemy's color, `hit`, shake 4-6 |
| die | big red burst, `explosion`, shake 8-10 |
| win | large burst in the goal's color, `powerup` |
| custom (`door-open`, `teleport`...) | a burst in the object's color and a sound that matches it |

- **Shake is seasoning.** Use it only for big moments (stomp, death, doors), never for every jump, and keep it ≤ 10.
- **Anticipation before danger:** a falling platform shakes, a turret fires on a rhythm, an enemy wakes up visibly (`state.chasing`). Players forgive hard things they saw coming.
- **Particles match their source:** coin particles are gold, slime particles purple, wood debris brown.
- **Ambient life:** an `emitter` on the goal (sparkles rising) pulls the eye toward it.

## 6. Art direction

**Pick a palette before drawing anything:** 5-7 colors, and stick to them.

| Role | Rule |
| --- | --- |
| Background | darkest, low saturation |
| Platforms and ground | mid values, cool or earthy |
| Player | the brightest, most saturated thing on screen |
| Pickups | warm and bright (gold, cyan) |
| Danger | red, magenta or orange, and nothing friendly uses those colors |

Ready-made palettes:

- **Night meadow** (the template): `#1b2140` sky, `#5fbf6a` grass, `#56658f` stone, `#7cf29c` player, `#ffd166` gold, `#ff5d73` danger
- **Desert ruins:** `#2b1d2f` sky, `#e0a96d` sand, `#a0714b` brick, `#4cc9f0` player, `#ffe66d` gold, `#e63946` danger
- **Ice cave:** `#0d1b2a` cave, `#a9d6e5` ice, `#468faf` rock, `#ffb703` player, `#f1faee` crystals, `#d62828` danger
- **Neon city:** `#10002b` night, `#3c096c` buildings, `#5a189a` platforms, `#80ffdb` player, `#ffd60a` pickups, `#ff006e` danger

**Drawing SVG that looks good:**

- **Shape language:** round shapes read as friendly (player, pickups); sharp shapes read as dangerous (spikes, enemies' teeth).
- **Shading:** one light direction for everything. A lighter band on top, a darker band at the bottom (see `ground.svg`, `platform.svg`).
- **Readable at size:** no detail smaller than 2px; big eyes for characters; a strong silhouette.
- **Consistent scale:** player about 28x36, tiles 20 or 40px, pickups about 20px.
- **Animation minimum:** idle, run (2 frames) and jump/fall for the player; 2-4 frames for anything alive (coins spin, slimes squish, flags wave).

**Look at it.** Take `--screenshot` frames and check them: sprites sit on the ground (not floating, not sunk), tiles line up, nothing clips through walls, and the player stands out at a glance.

## 7. Sound

Every player action and every important event gets a sound. Use presets that match: `jump`, `thud` for landing, `coin`, `hit` for stomps, `explosion` for deaths and big impacts, `powerup` for rewards and wins, `blip` for small UI-like events (turret shots, switches). Don't stack many loud sounds in one moment.

## 8. Ideas for mechanics

Most of these are one short script. Use them to make each game feel different:

- **Switch and gate:** touching a switch sets `gate.state.open`; the gate destroys itself or slides away.
- **Wind zone:** while the player `touches` a sensor area, add to their `vx` every frame.
- **Gravity flip pad:** a script that sets the player's velocity upward every frame while active.
- **Crumbling path:** a row of falling platforms with increasing `delay`, so the player must keep moving.
- **Collect-all door:** a door that opens when `world.score` reaches a number.
- **Boss:** an entity with `state.hp` and `state.phase`; stomps lower hp (use `touch`), and each phase changes speed or spawns minions.
- **Escort or chase sequence:** a `chasing-enemy` with a high `range` that starts the moment the player picks something up.
- **Timed run:** `time-limit` plus coins as optional time bonuses (`state.left += 2` from a coin's script).

## 9. Before you hand it off

- [ ] `check` passes with no warnings you can't explain
- [ ] A test proves it's completable with `deaths == 0`, and each mechanic has its own isolated test
- [ ] Critical jumps work across a ≥ 0.2s window
- [ ] Screenshots of the start, the hardest moment and the goal look right
- [ ] Every event in the level has an effect and a sound
- [ ] The palette is consistent and the player is the most visible thing on screen
- [ ] `ludra.json` has a real name, not the folder name
- [ ] You can state the hook in one sentence, and the level is about it

Then tell the user how to play (`npx @ludra/cli dev`), what the level is about, and anything you noticed but didn't fix.
