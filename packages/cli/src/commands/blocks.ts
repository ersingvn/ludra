import { relative } from "node:path";
import { addBlock, listBlocks, loadBlock } from "../blocks.ts";
import { pad, paint } from "../format.ts";
import { CliError, loadProject } from "../project.ts";

/** `ludra blocks`: the catalog. */
export function blocks(options: { json?: boolean }): number {
  const all = listBlocks();
  if (options.json) {
    console.log(JSON.stringify(all.map(({ name, description, tags, usage, positioned }) => ({ name, description, tags, usage, positioned: positioned ?? true })), null, 2));
    return 0;
  }
  const width = Math.max(...all.map((b) => b.name.length)) + 2;
  for (const block of all) {
    console.log(`${paint("bold", pad(block.name, width))}${block.description} ${paint("dim", `[${block.tags.join(", ")}]`)}`);
  }
  console.log(paint("dim", `\nAdd one with: ludra add <block> --at x,y   (y = top of the surface it sits on; 500 in the templates)`));
  return 0;
}

export interface AddOptions {
  at?: string;
  id?: string;
  force?: boolean;
  json?: boolean;
}

/** `ludra add <block> [folder] --at x,y`. */
export function add(name: string | undefined, dir: string, options: AddOptions): number {
  if (!name) throw new CliError("Usage: ludra add <block> [folder] --at x,y [--id name]. Run `ludra blocks` for the catalog.");
  const block = loadBlock(name);
  const project = loadProject(dir);

  let at = { x: 0, y: 0 };
  if (block.positioned !== false) {
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(options.at ?? "");
    if (!match) throw new CliError(`ludra add ${name} needs --at x,y. ${block.usage}`);
    at = { x: Number(match[1]), y: Number(match[2]) };
  }

  const result = addBlock(project.dir, project.entryPath, block, at, { id: options.id, force: options.force });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(paint("green", `✓ Added "${block.name}" to ${project.entryLabel}`));
  for (const e of result.entities) console.log(`  entity  ${pad(e.id, 22)} at (${e.x}, ${e.y})`);
  for (const f of result.files) {
    const note = f.status === "kept yours" ? paint("yellow", "kept yours (differs from the block; use --force to replace)") : paint("dim", f.status);
    console.log(`  file    ${pad(f.path, 22)} ${note}`);
  }
  if (result.effects.length > 0) console.log(`  effects ${result.effects.join(", ")}`);
  console.log(`\n${paint("dim", block.usage)}`);
  console.log(paint("dim", `Next: ludra check ${relative(process.cwd(), project.dir) || "."}, then play and test it.`));
  return 0;
}
