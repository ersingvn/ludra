import { fileURLToPath } from "node:url";
import { paint } from "../format.ts";
import { CliError, loadProject } from "../project.ts";

type LaunchStudio = (dir: string, options: { port?: number; cli?: string[] }) => Promise<number>;

/**
 * Opens the game in Ludra Studio, the desktop app (docs/studio.md). Studio is its own package, with
 * Electron in it, so the CLI stays small: this finds it if it's installed.
 */
export async function studio(dir: string, options: { port?: string }): Promise<number> {
  const project = loadProject(dir);
  const port = options.port === undefined ? undefined : Number(options.port);
  if (port !== undefined && (!Number.isInteger(port) || port <= 0)) throw new CliError(`Invalid --port "${options.port}".`);

  // A specifier in a variable: the CLI must build and run without Studio installed.
  const studioPackage = "@ludra/studio";
  let launch: LaunchStudio;
  try {
    ({ launchStudio: launch } = (await import(studioPackage)) as { launchStudio: LaunchStudio });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
    throw new CliError("Ludra Studio isn't installed. It's a separate package, because it brings Electron:\n  npm install -g @ludra/studio\nThen run `ludra studio` again.");
  }
  // Studio runs this same ludra for its game server, so a repo checkout serves its own engine.
  const self = fileURLToPath(new URL("../index" + (import.meta.url.endsWith(".ts") ? ".ts" : ".js"), import.meta.url));
  const cli = [process.execPath, ...process.execArgv.filter((a) => a.startsWith("--conditions")), self];
  console.log(paint("green", `▶ Opening ${project.config.name} in Ludra Studio`));
  return launch(project.dir, { port, cli });
}
