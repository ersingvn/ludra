# ludra

**The game engine built for AI agents.** This is the `ludra` command.

Games are plain JSON, every error comes with a fix, and agents play-test their own games headlessly before a human ever touches them.

```bash
npx ludra new my-game
cd my-game
npx ludra check                                   # validate; every problem has a fix
npx ludra play --inputs "right:1s, jump:0.4s" --ascii   # simulate and see the frame as text
npx ludra test                                    # run tests/*.test.json
npx ludra dev                                     # play it in the browser
```

| Command | What it does |
| --- | --- |
| `ludra new <folder>` | Create a game from the platformer template (art, effects and tests included) |
| `ludra check [folder]` | Validate the scene and its assets |
| `ludra play [folder]` | Deterministic headless run: timeline, events, ASCII map |
| `ludra test [folder]` | Scripted inputs plus assertions such as `won == true` or `deaths == 0` |
| `ludra components [name]` | Reference for every component, field and effect |
| `ludra dev [folder]` | Browser runtime with keyboard controls, sound and live reload |

Every command accepts `--json`. Requires Node.js 22.18 or newer.

The engine runtime is published separately as [`@ludra/core`](https://www.npmjs.com/package/@ludra/core).

Documentation, the Claude skill and examples: **https://github.com/ersingvn/ludra**

MIT licensed.
