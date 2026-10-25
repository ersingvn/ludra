#!/usr/bin/env node
import { parseArgs } from "node:util";
import { add, blocks } from "./commands/blocks.ts";
import { check } from "./commands/check.ts";
import { components } from "./commands/components.ts";
import { dev } from "./commands/dev.ts";
import { create } from "./commands/new.ts";
import { play } from "./commands/play.ts";
import { test } from "./commands/test.ts";
import { review } from "./commands/review.ts";
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
  ludra new <folder> [--template <name>]       Create a game project (templates: platformer, topdown, breakout, physics)
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
      --debug                                  Draw colliders, sensors, joints and ids over the screenshots
      --out screenshots                        Folder for screenshots, relative to the project (default: screenshots)
      --json                                   Machine-readable output
  ludra test [folder] [--json]                 Run tests/*.test.json (a test can pick its "scene")
  ludra review [folder] [--json] [--strict]    Find what makes a game feel unfinished: untested mechanics,
                                               silent events, default HUD, flat looks (--strict: exit 1 on issues)
  ludra components [name] [--json]             Reference for every component and field
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
      debug: { type: "boolean" },
      out: { type: "string" },
      json: { type: "boolean" },
      template: { type: "string" },
      port: { type: "string" },
      at: { type: "string" },
      id: { type: "string" },
      force: { type: "boolean" },
      strict: { type: "boolean" },
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
    case "review":
      return review(target ?? ".", values);
    case "components":
      return components(target, values);
    case "dev":
      return dev(target ?? ".", values);
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
