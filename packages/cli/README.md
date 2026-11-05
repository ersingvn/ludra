# @ludra/cli

**The game engine built for AI agents.** This package provides the `ludra` command.

Games are plain JSON, every error comes with a fix, and agents play-test their own games headlessly before a human ever touches them.

```bash
npx @ludra/cli new my-game
cd my-game
npx @ludra/cli check                                        # validate; every problem has a fix
npx @ludra/cli play --inputs "right:1s, jump:0.4s" --ascii  # simulate and see the frame as text
npx @ludra/cli test                                         # run tests/*.test.json
npx @ludra/cli dev                                          # play it in the browser
```

Or install it once and use the short command:

```bash
npm install -g @ludra/cli
ludra new my-game
```

| Command | What it does |
| --- | --- |
| `ludra new <folder>` | Create a game from the platformer template (art, effects and tests included) |
| `ludra check [folder]` | Validate the scene and its assets |
| `ludra play [folder]` | Deterministic headless run: timeline, events, ASCII map |
| `ludra test [folder]` | Scripted inputs plus assertions such as `won == true` or `deaths == 0` |
| `ludra components [name]` | Reference for every component, field and effect |
| `ludra dev [folder]` | Browser runtime with keyboard, gamepad and touch controls, sound and live reload. Records each session, and the player marks moments with 1 2 3 4 N |
| `ludra feedback [folder]` | What players felt, scene by scene: marks, deaths, where they stopped, crashes |
| `ludra replay <recording\|folder>` | Play a recording again, see a marked moment, or turn takes into tests with `--test` |
| `ludra build [folder]` | The whole game as one HTML file, and a zip of it for itch.io: plays with a keyboard, a gamepad or a touch screen |

Every command accepts `--json`. Requires Node.js 22.18 or newer.

The engine runtime is published separately as [`@ludra/core`](https://www.npmjs.com/package/@ludra/core).

Documentation, the Claude Code plugin and examples: **https://github.com/ersingvn/ludra**

MIT licensed.
