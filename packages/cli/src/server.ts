import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAssetPaths } from "@ludra/core";
import { isInside, readScene, scriptPaths, type Project } from "./project.ts";

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
}

/**
 * Serves a project to a browser: the engine's browser runtime, the validated
 * scene and the project's media. No bundler: when the engine runs from
 * source, its TypeScript files are type-stripped on the fly.
 * `indexHtml` builds the page served at "/".
 */
export function createGameServer(project: Project, indexHtml: (browserModule: string) => string): GameServer {
  const coreEntry = fileURLToPath(import.meta.resolve("@ludra/core/browser"));
  const coreDir = dirname(coreEntry);
  const browserModule = `/__ludra/core/${relative(coreDir, coreEntry).replaceAll(sep, "/")}`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(indexHtml(browserModule));
      } else if (url.pathname === BLANK_PATH) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>Ludra</title></head><body style="margin:0"></body></html>');
      } else if (url.pathname === "/__ludra/scene") {
        const { scene, diagnostics } = readScene(project);
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
        const file = join(coreDir, decodeURIComponent(url.pathname.slice("/__ludra/core/".length)));
        if (!file.startsWith(coreDir + sep) || !existsSync(file)) return notFound(res);
        const source = readFileSync(file, "utf8");
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(extname(file) === ".ts" ? stripTypeScriptTypes(source) : source);
      } else {
        notFound(res);
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end((err as Error).message);
    }
  });
  return { server, browserModule };
}

/** Changes whenever the scene or any file it references changes, so the page knows to reload. */
function version(project: Project): string {
  if (!existsSync(project.entryPath)) return "missing";
  const files = [project.entryPath];
  const { scene } = readScene(project);
  if (scene) {
    files.push(...collectAssetPaths(scene).map((ref) => resolve(project.dir, ref.path)));
    files.push(...scriptPaths(project, scene).map((path) => resolve(project.dir, path)));
  }
  return files.map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0)).join(":");
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}
