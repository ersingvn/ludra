#!/usr/bin/env node
import { parseArgs } from "node:util";
import { check } from "./commands/check.ts";
import { components } from "./commands/components.ts";
import { dev } from "./commands/dev.ts";
import { create } from "./commands/new.ts";
import { play } from "./commands/play.ts";
import { test } from "./commands/test.ts";
import { paint } from "./format.ts";
import { CliError } from "./project.ts";

const HELP = `ludra: the game engine built for AI agents

Usage
  ludra new <folder> [--template platformer]   Create a game project
  ludra check [folder] [--json]                Validate the scene; every problem comes with a fix
  ludra play [folder] [options]                Simulate the game headlessly
      --inputs "right:1s, jump:0.4s"           Scripted input. Actions: left right up down jump action wait
      --duration 3s                            Run length (default: inputs + 1s)
      --watch player,enemy                     Entities in the timeline (default: platformer entities)
      --every 0.25s                            Timeline sampling interval
      --ascii                                  Print the final frame as a text map
      --columns 120                            Width of the text map (default: 80)
      --screenshot 1s,2.5s,end                 Save real rendered frames as PNGs (needs Chrome, Edge or Chromium)
      --out screenshots                        Folder for screenshots, relative to the project (default: screenshots)
      --json                                   Machine-readable output
  ludra test [folder] [--json]                 Run tests/*.test.json
  ludra components [name] [--json]             Reference for every component and field
  ludra dev [folder] [--port 5173]             Play the game in the browser with live reload

Folder defaults to the current directory.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      inputs: { type: "string" },
      duration: { type: "string" },
      watch: { type: "string" },
      every: { type: "string" },
      ascii: { type: "boolean" },
      columns: { type: "string" },
      screenshot: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean" },
      template: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, target] = positionals;

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
    case "components":
      return components(target, values);
    case "dev":
      return dev(target ?? ".", values);
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
