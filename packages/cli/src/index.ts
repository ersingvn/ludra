#!/usr/bin/env node
import { parseArgs } from "node:util";
import { add, blocks } from "./commands/blocks.ts";
import { check } from "./commands/check.ts";
import { components } from "./commands/components.ts";
import { dev } from "./commands/dev.ts";
import { diff } from "./commands/diff.ts";
import { fuzz } from "./commands/fuzz.ts";
import { inspect } from "./commands/inspect.ts";
import { create } from "./commands/new.ts";
import { play } from "./commands/play.ts";
import { test } from "./commands/test.ts";
import { review } from "./commands/review.ts";
import { solve } from "./commands/solve.ts";
import { paint } from "./format.ts";
import { CliError } from "./project.ts";

// Ludra strips types from game scripts with Node's built-in stripTypeScriptTypes, which warns that it is
// experimental on every use. That warning is noise for game authors, so drop just that one.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning instanceof Error ? warning.message : warning).includes("stripTypeScriptTypes")) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const HELP = `ludra: the game engine built for AI agents

Usage
  ludra new <folder> [--template <name>]       Create a game project (templates: platformer, topdown, breakout, physics, 3d)
  ludra check [folder] [--json]                Validate every scene; every problem comes with a fix
  ludra play [folder] [options]                Simulate the game headlessly
      --scene scenes/level-2.scene.json        Scene to play (default: the entry scene in ludra.json)
      --inputs "right:1s, jump:0.4s"           Scripted input. Actions: left right up down jump action wait
      --duration 3s                            Run length (default: inputs + 1s)
      --watch player,enemy                     Entities in the timeline (default: the players)
      --every 0.25s                            Timeline sampling interval
      --ascii                                  Print the final frame as a text map
      --columns 120                            Width of the text map (default: 80)
      --screenshot 1s,2.5s,end                 Save real rendered frames as PNGs (needs Chrome, Edge or Chromium)
      --sheet 0.5s                             One PNG of the whole run: a frame every 0.5s and the last, each
                                               labelled with its time and the events since the one before
      --camera map                             3D: draw the frames as a map, the whole level from above with
                                               each entity's id; or 0,20,12@0,0,0 from a point at a point,
                                               or 0,20,12@player from a point at an entity
      --debug                                  Draw colliders, sensors, joints and ids over the screenshots
      --out screenshots                        Folder for screenshots, relative to the project (default: screenshots)
      --json                                   Machine-readable output
  ludra diff <before> <after> [options]        What changed between two screenshots, or two folders of them by
                                               file name: share of pixels, regions and where, an image of each
      --out screenshots/diff                   Folder for the diff images (default: screenshots/diff)
      --threshold 24                           How much a colour channel must move to count (0-255)
      --json                                   Machine-readable output
  ludra test [folder] [--json]               Run tests/*.test.json (a test can pick its "scene")
  ludra solve [folder] [options]               Search the inputs for a way to win; exit 1 when none is found
      --scene scenes/level-2.scene.json        Scene to solve (default: the entry scene)
      --goal "player.x > 900"                  What counts as done, as a test assertion (default: won == true)
      --time 30s                               How long to search (default: 30s; 2m for minutes)
      --budget 2000000                         Most frames to simulate
      --allow-deaths                           Accept routes that cost a life
      --seed 1                                 Seed for the search's own choices
      --json                                   Machine-readable output
  ludra fuzz [folder] [options]                Play random sessions to find crashes, softlocks and where players die;
                                               exit 1 on crashes, softlocks or a level that can't be won
      --scene scenes/level-2.scene.json        Scene to play (default: the entry scene)
      --sessions 200                           How many sessions
      --seconds 60                             Longest session
      --time 60s                               How long to play in all (2m for minutes)
      --seed 1                                 Seed for the random inputs
      --no-softlocks                           Skip the softlock checks (faster)
      --json                                   Machine-readable output
  ludra review [folder] [--json] [--strict]    Find what makes a game feel unfinished: untested mechanics,
                                               frame-perfect jumps, crashes and softlocks found by random play,
                                               silent events, default HUD, flat looks (--strict: exit 1 on issues)
      --fast                                   Skip the random play (a few seconds per scene)
  ludra components [name] [--json]             Reference for every component and field
  ludra inspect <file> [--json]                What a .glb/.gltf model holds (size in metres, triangles, animations,
                                               bones), or an image's size or a WAV's duration
  ludra blocks [--json]                        Catalog of ready-made gameplay blocks
  ludra add <block> [folder] --at x,y          Add a block: entities, scripts, art and effects
      --id name                                Id prefix for its entities (default: the block name)
      --force                                  Replace files you changed that the block also ships
  ludra dev [folder] [--port 5173]             Play the game in the browser with live reload

Folder defaults to the current directory.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scene: { type: "string" },
      inputs: { type: "string" },
      duration: { type: "string" },
      watch: { type: "string" },
      every: { type: "string" },
      ascii: { type: "boolean" },
      columns: { type: "string" },
      screenshot: { type: "string" },
      sheet: { type: "string" },
      camera: { type: "string" },
      debug: { type: "boolean" },
      out: { type: "string" },
      json: { type: "boolean" },
      template: { type: "string" },
      port: { type: "string" },
      at: { type: "string" },
      id: { type: "string" },
      force: { type: "boolean" },
      strict: { type: "boolean" },
      fast: { type: "boolean" },
      time: { type: "string" },
      budget: { type: "string" },
      "allow-deaths": { type: "boolean" },
      seed: { type: "string" },
      threshold: { type: "string" },
      goal: { type: "string" },
      sessions: { type: "string" },
      seconds: { type: "string" },
      "no-softlocks": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, target, extra] = positionals;

  if (values.help || !command || command === "help") {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case "new":
      return create(target, values);
    case "check":
      return check(target ?? ".", values);
    case "play":
      return play(target ?? ".", values);
    case "test":
      return test(target ?? ".", values);
    case "solve":
      return solve(target ?? ".", values);
    case "fuzz":
      return fuzz(target ?? ".", values);
    case "review":
      return review(target ?? ".", values);
    case "components":
      return components(target, values);
    case "dev":
      return dev(target ?? ".", values);
    case "inspect":
      return inspect(target, values);
    case "diff":
      return diff(target, extra, values);
    case "blocks":
      return blocks(values);
    case "add":
      return add(target, extra ?? ".", values);
    default:
      throw new CliError(`Unknown command "${command}".\n\n${HELP}`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // parseArgs reports unknown flags with a code; show those like our own errors.
  const known = err instanceof CliError || (err as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS");
  console.error(known ? paint("red", (err as Error).message) : err);
  process.exitCode = 1;
}
