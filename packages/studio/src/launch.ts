import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The Electron main process. Always the compiled one (Electron doesn't run TypeScript): `npm run build` first in the repo. */
const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

export interface LaunchOptions {
  /** Port for the game server. Default: a free one. */
  port?: number;
  /**
   * How to run the `ludra` command for the game server, as [program, ...args], e.g.
   * [process.execPath, "--conditions=ludra-dev", "path/to/cli/src/index.ts"]. Default: the
   * `@ludra/cli` that Studio finds, run by Electron's own Node.
   */
  cli?: string[];
  /** Wait for the window to close. Default true. */
  wait?: boolean;
}

/** The Electron binary that the `electron` package downloaded. */
export function electronPath(): string {
  const path = createRequire(import.meta.url)("electron") as unknown;
  if (typeof path !== "string") throw new Error("The electron package didn't give a path to its binary. Reinstall @ludra/studio.");
  return path;
}

/** Opens Ludra Studio on a project folder. Resolves with Studio's exit code once the window closes. */
export function launchStudio(dir: string, options: LaunchOptions = {}): Promise<number> {
  if (!existsSync(MAIN)) throw new Error(`Ludra Studio isn't built: ${MAIN} is missing. Run "npm run build".`);
  const args = [MAIN, dir];
  if (options.port) args.push("--port", String(options.port));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (options.cli) env.LUDRA_STUDIO_CLI = JSON.stringify(options.cli);
  const child: ChildProcess = spawn(electronPath(), args, { stdio: "inherit", env, detached: options.wait === false });
  if (options.wait === false) {
    child.unref();
    return Promise.resolve(0);
  }
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
