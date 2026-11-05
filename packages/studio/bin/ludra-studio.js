#!/usr/bin/env node
// Opens Ludra Studio: ludra-studio [folder] [--port 5173]. `ludra studio` does the same.
import { launchStudio } from "../dist/launch.js";

const argv = process.argv.slice(2);
const at = argv.indexOf("--port");
const port = at >= 0 ? Number(argv[at + 1]) : undefined;
const dir = argv.find((a, i) => !a.startsWith("-") && argv[i - 1] !== "--port") ?? ".";
try {
  process.exitCode = await launchStudio(dir, { port });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
