import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAssetPaths } from "@ludra/core";
import { isInside, listScenes, readScene, scriptPaths, type Project } from "./project.ts";

export const PROJECT_PREFIX = "/__ludra/project/";
export const SCRIPT_PREFIX = "/__ludra/script/";
/** An empty same-origin page that headless capture loads before importing the engine. */
export const BLANK_PATH = "/__ludra/blank";

const MEDIA_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".frag": "text/plain; charset=utf-8",
  ".glsl": "text/plain; charset=utf-8",
};

export interface GameServer {
  server: Server;
  /** URL path of the engine's browser module, for `import()` in the page. */
  browserModule: string;
  /** URL path of @ludra/physics, imported only by pages whose scene uses rapier. */
  physicsModule: string;
  /**
   * A `<script type="importmap">` tag that lets the browser resolve "@ludra/core" and Rapier
   * without a bundler. Pages put it before their first module script.
   */
  importMap: string;
}

/** Where the engine's packages are on disk, and the URLs the browser loads them from. */
function enginePaths() {
  const coreEntry = fileURLToPath(import.meta.resolve("@ludra/core/browser"));
  const coreDir = dirname(coreEntry);
  const coreIndex = fileURLToPath(import.meta.resolve("@ludra/core"));
  const physicsEntry = fileURLToPath(import.meta.resolve("@ludra/physics"));
  const physicsDir = dirname(physicsEntry);
  // Rapier's ES module sits next to the CommonJS entry require() finds.
  const rapierFile = join(dirname(createRequire(physicsEntry).resolve("@dimforge/rapier2d-deterministic-compat")), "rapier.mjs");
  const url = (prefix: string, dir: string, file: string) => `${prefix}${relative(dir, file).replaceAll(sep, "/")}`;
  return {
    coreDir,
    physicsDir,
    rapierFile,
    browserModule: url("/__ludra/core/", coreDir, coreEntry),
    physicsModule: url("/__ludra/physics/", physicsDir, physicsEntry),
    imports: { "@ludra/core": url("/__ludra/core/", coreDir, coreIndex), "@dimforge/rapier2d-deterministic-compat": "/__ludra/rapier.mjs" },
  };
}

/** Serves an engine source file, type-stripped when it is TypeScript. */
function serveModule(res: ServerResponse, dir: string, path: string): void {
  const file = join(dir, decodeURIComponent(path));
  if (!file.startsWith(dir + sep) || !existsSync(file)) return notFound(res);
  const source = readFileSync(file, "utf8");
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
  res.end(extname(file) === ".ts" ? stripTypeScriptTypes(source) : source);
}

/**
 * Serves a project to a browser: the engine's browser runtime, the validated
 * scene and the project's media. No bundler: when the engine runs from
 * source, its TypeScript files are type-stripped on the fly.
 * `indexHtml` builds the page served at "/".
 */
export function createGameServer(project: Project, indexHtml: (page: { browserModule: string; physicsModule: string; importMap: string }) => string): GameServer {
  const paths = enginePaths();
  const { browserModule, physicsModule } = paths;
  const importMap = `<script type="importmap">${JSON.stringify({ imports: paths.imports })}</script>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(indexHtml({ browserModule, physicsModule, importMap }));
      } else if (url.pathname === BLANK_PATH) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Ludra</title>${importMap}</head><body style="margin:0"></body></html>`);
      } else if (url.pathname === "/__ludra/scene") {
        // ?path= picks another scene, for goals with "next" and world.goto.
        const { scene, diagnostics } = readScene(project, url.searchParams.get("path") ?? undefined);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: !!scene, scene, diagnostics }));
      } else if (url.pathname === "/__ludra/version") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(version(project));
      } else if (url.pathname === "/__ludra/scripts") {
        const { scene } = readScene(project);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(scene ? scriptPaths(project, scene) : []));
      } else if (url.pathname.startsWith(SCRIPT_PREFIX)) {
        // Only the game's own script files, type-stripped so the browser can import them.
        const path = decodeURIComponent(url.pathname.slice(SCRIPT_PREFIX.length));
        const { scene } = readScene(project);
        const file = resolve(project.dir, path);
        if (!scene || !scriptPaths(project, scene).includes(path) || !isInside(project.dir, file) || !existsSync(file)) return notFound(res);
        const source = readFileSync(file, "utf8");
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
        res.end(extname(file) === ".ts" ? stripTypeScriptTypes(source) : source);
      } else if (url.pathname.startsWith(PROJECT_PREFIX)) {
        // Only media files inside the project are served, never source or config.
        const file = resolve(project.dir, decodeURIComponent(url.pathname.slice(PROJECT_PREFIX.length)));
        const type = MEDIA_TYPES[extname(file).toLowerCase()];
        if (!type || !isInside(project.dir, file) || !existsSync(file)) return notFound(res);
        res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
        res.end(readFileSync(file));
      } else if (url.pathname.startsWith("/__ludra/core/")) {
        serveModule(res, paths.coreDir, url.pathname.slice("/__ludra/core/".length));
      } else if (url.pathname.startsWith("/__ludra/physics/")) {
        serveModule(res, paths.physicsDir, url.pathname.slice("/__ludra/physics/".length));
      } else if (url.pathname === "/__ludra/rapier.mjs") {
        // Rapier with its WebAssembly inlined: one file, a few MB, loaded only by rapier scenes.
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" });
        res.end(readFileSync(paths.rapierFile));
      } else {
        notFound(res);
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end((err as Error).message);
    }
  });
  return { server, browserModule, physicsModule, importMap };
}

/** Changes whenever a scene, prefab or any file they reference changes, so the page knows to reload. */
function version(project: Project): string {
  if (!existsSync(project.entryPath)) return "missing";
  const files: string[] = [];
  for (const path of listScenes(project)) {
    files.push(resolve(project.dir, path));
    const { scene } = readScene(project, path);
    if (!scene) continue;
    files.push(...collectAssetPaths(scene).map((ref) => resolve(project.dir, ref.path)));
    files.push(...scriptPaths(project, scene).map((p) => resolve(project.dir, p)));
  }
  const prefabs = join(project.dir, "prefabs");
  if (existsSync(prefabs)) files.push(prefabs, ...readdirSync(prefabs).map((name) => join(prefabs, name)));
  return [...new Set(files)].map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0)).join(":");
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}
