import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../format.ts";
import { CliError } from "../project.ts";

/** Same relative location from `src/commands` and `dist/commands`. */
const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

export function create(dir: string | undefined, options: { template?: string }): number {
  if (!dir) throw new CliError("Usage: ludra new <folder> [--template platformer|topdown|breakout]");
  const template = options.template ?? "platformer";
  const source = join(TEMPLATES_DIR, template);
  if (!existsSync(source)) {
    throw new CliError(`Unknown template "${template}". Templates: ${readdirSync(TEMPLATES_DIR).join(", ")}.`);
  }

  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new CliError(`${target} already exists and is not empty. Choose a new folder.`);
  }

  const name = basename(target);
  cpSync(source, target, { recursive: true });
  // npm never publishes files named .gitignore, so templates ship it as _gitignore.
  const gitignore = join(target, "_gitignore");
  if (existsSync(gitignore)) renameSync(gitignore, join(target, ".gitignore"));
  for (const file of listFiles(target)) {
    const text = readFileSync(file, "utf8");
    if (text.includes("{{name}}")) writeFileSync(file, text.replaceAll("{{name}}", name));
  }

  const shown = relative(process.cwd(), target) || ".";
  console.log(paint("green", `✓ Created ${name} from the "${template}" template in ${shown}`));
  console.log(`
Next steps:
  npx @ludra/cli check ${shown}          validate the scene
  npx @ludra/cli play ${shown} --ascii   simulate it headlessly and see the final frame
  npx @ludra/cli test ${shown}           run tests/*.test.json
  npx @ludra/cli dev ${shown}            play it in the browser`);
  return 0;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
