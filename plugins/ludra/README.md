# Ludra plugin for Claude Code

Teaches Claude to build games with [Ludra](https://github.com/ersingvn/ludra), the game engine built for AI agents.

## Install

```
/plugin marketplace add ersingvn/ludra
/plugin install ludra@ludra
```

Then ask Claude something like *"make me a platformer with a moving platform and an enemy to stomp"*.

## What it adds

The `ludra` skill. Claude uses it whenever you ask to make, change, test or polish a game. It teaches Claude to:

- create a game with `npx ludra new` and edit its JSON scenes
- run `ludra check` after every edit and apply the fixes it suggests
- watch the game with `ludra play` (timeline, events and an ASCII map) and prove it works with `ludra test`, including that the level can be beaten without dying
- draw sprites and spritesheets as SVG, and add particles, sound and screen shake
- hand off with `ludra dev` so you can play it in the browser

It needs Node.js 22.18 or newer and the `ludra` npm package (`npx ludra` fetches it).
