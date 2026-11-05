# Ludra Studio UI

Every panel of Ludra Studio: toolbar, Hierarchy, Game, Inspector and the bottom tabs (Activity, Problems,
Tests, Review, Console). The contract it speaks is [docs/studio.md](../../../docs/studio.md).

TypeScript in `src/`, compiled by `tsc` to ES modules in `dist/` (no bundler, no runtime dependencies):

```bash
npx tsc -b packages/studio/ui
```

## Three ways to open it

- **In Studio.** Electron loads `index.html?server=<url-encoded ludra dev URL>` and gives it `window.studio`.
- **In a browser, against a server.** `index.html?server=http://127.0.0.1:5173` with `ludra dev --studio`
  running. What needs `window.studio` (open project, open in editor) is hidden.
- **Mock.** `index.html?mock=1` (or no `server` at all): `mock-game.html` plays a small game with a bot at the
  keys and speaks the game link, and a fake agent changes files every few seconds, including one change that
  doesn't pass check and one to `game.md`. Nothing else is needed, so the UI can be built and screenshotted on
  its own.

Chrome won't load ES modules from `file://`, so in a browser serve the folder over http (any static server).
Electron loads them from `file://` fine.

## Layout

| File | What |
| --- | --- |
| `src/main.ts` | Boot, status bar, shortcuts and `window.studio.onMenu` |
| `src/studio.ts` | All state and actions; panels listen to it |
| `src/game-link.ts` | postMessage to and from the game iframe |
| `src/backend.ts` | `/__ludra/project`, `/__ludra/events`, `/__ludra/run` |
| `src/layout.ts` | Resizable panels, remembered in localStorage |
| `src/panels/*` | One file per panel |
| `src/syntax.ts` | Line-by-line coloring for JSON, TypeScript and Markdown, and unified diffs |
| `src/mock/*` | The mock backend and game |

Shortcuts in a browser: F5 play/pause, F10 step, Ctrl+R restart, Ctrl+P pick, Ctrl+Shift+C check,
Ctrl+Shift+T test, Ctrl+F search entities, Esc stop picking. In Electron the native menu owns these keys and
sends them through `onMenu`, so the page doesn't handle them twice.
