import { existsSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * Puts a graph of ES modules into one page without a bundler. Each module keeps its own code;
 * only the strings it imports change, to a short name (`@pack/3`) that the page's import map
 * points at the module's blob URL. TypeScript is type-stripped, as the dev server does.
 */
export class ModulePacker {
  /** Module code by its name, in the order they were found. */
  readonly modules = new Map<string, string>();
  private readonly names = new Map<string, string>();
  /** Specifiers that code builds at run time ("three/addons/" + path), and the module each means. */
  private readonly aliases = new Map<string, string>();
  private readonly resolveBare: (specifier: string) => string | undefined;
  private readonly skip: ReadonlySet<string>;

  /**
   * `resolveBare` finds the file for a bare specifier ("three", "@ludra/core"), or undefined.
   * Files in `skip` are left out, and imports of them stay as they are: for modules the game
   * imports somewhere but never runs, like 3D physics in a 2D game.
   */
  constructor(resolveBare: (specifier: string) => string | undefined, skip: ReadonlySet<string> = new Set()) {
    this.resolveBare = resolveBare;
    this.skip = skip;
  }

  /** Makes `specifier` import `file`, even where the code that asks for it builds the string itself. */
  alias(specifier: string, file: string): void {
    this.aliases.set(specifier, this.addFile(file));
  }

  /** Adds a file and everything it imports. Returns its name. */
  addFile(file: string): string {
    const known = this.names.get(file);
    if (known) return known;
    const name = this.name(file);
    const source = readFileSync(file, "utf8");
    this.modules.set(name, this.link(extname(file) === ".ts" ? stripTypeScriptTypes(source) : source, file));
    return name;
  }

  /** Adds code that isn't a file (the page's own start-up module). Its imports are file URLs or bare. */
  addSource(code: string, id: string): string {
    const name = this.name(id);
    this.modules.set(name, this.link(code, id));
    return name;
  }

  private name(key: string): string {
    const name = `@pack/${this.names.size}`;
    this.names.set(key, name);
    // Holds the module's place, so a cycle back to it finds the name before its code is done.
    this.modules.set(name, "");
    return name;
  }

  /**
   * Rewrites static imports, re-exports, side-effect imports and dynamic `import("...")` with a
   * literal. A string that only looks like an import (in a comment, say) is left alone unless it
   * names a file that exists, and then rewriting it changes nothing that runs.
   */
  private link(code: string, from: string): string {
    const name = this.names.get(from)!;
    return code
      .replace(IMPORT, (whole: string, before: string, quote: string, specifier: string) => {
        const file = this.resolve(specifier, from);
        return file ? `${before}${quote}${this.addFile(file)}${quote}` : whole;
      })
      // A blob URL can't be the base of a relative URL, and `new URL("../x", import.meta.url)` at the
      // top of a module (three's DRACOLoader has one) would throw. A made-up path can, and says
      // nothing about the machine that built the game. Fetching from it fails, as it should.
      .replace(/\bimport\.meta\.url\b/g, JSON.stringify(`ludra:/${name.slice(1)}`));
  }

  private resolve(specifier: string, from: string): string | undefined {
    let file: string | undefined;
    if (specifier.startsWith("file:")) file = fileURLToPath(specifier);
    else if (specifier.startsWith("./") || specifier.startsWith("../")) file = resolve(dirname(from), specifier);
    else if (!/^[a-z]+:/i.test(specifier) && !specifier.startsWith("/")) file = this.resolveBare(specifier);
    return file && !this.skip.has(file) && existsSync(file) && statSync(file).isFile() ? file : undefined;
  }

  /**
   * The page's `<script>`s: the modules as JSON, and a classic script that makes a blob URL for
   * each, an import map naming them, and then imports `entry`. A classic script runs before any
   * module, so its import map is in place in time.
   */
  html(entry: string): string {
    const json = scriptSafe(JSON.stringify(Object.fromEntries(this.modules)));
    const aliases = scriptSafe(JSON.stringify(Object.fromEntries(this.aliases)));
    return `<script id="ludra-modules" type="application/json">${json}</script>
<script>
(() => {
  const modules = JSON.parse(document.getElementById("ludra-modules").textContent);
  const imports = {};
  for (const name in modules) imports[name] = URL.createObjectURL(new Blob([modules[name]], { type: "text/javascript" }));
  const aliases = ${aliases};
  for (const specifier in aliases) imports[specifier] = imports[aliases[specifier]];
  const map = document.createElement("script");
  map.type = "importmap";
  map.textContent = JSON.stringify({ imports });
  document.head.append(map);
  const start = document.createElement("script");
  start.type = "module";
  start.textContent = ${JSON.stringify(`import ${JSON.stringify(entry)};`)};
  document.body.append(start);
})();
</script>`;
  }
}

/** `from "x"`, `import "x"` and `import("x")`. */
const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n\r]+)\2/g;

/** JSON that can sit inside a `<script>` element: "</script" and "<!--" can't close or confuse it. */
export function scriptSafe(json: string): string {
  return json.replaceAll("<", "\\u003c");
}

/** A .zip of the given files, deflated, as itch.io and other stores want web games uploaded. */
export function zip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 1980-01-01, the earliest time a zip can hold: the same game always gives the same bytes.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const packed = deflateRawSync(file.data, { level: 9 });
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** Files a .gltf names beside itself (its buffers and images), as project paths. */
export function gltfFiles(projectDir: string, path: string): string[] {
  if (extname(path).toLowerCase() !== ".gltf") return [];
  const file = join(projectDir, path);
  if (!existsSync(file)) return [];
  try {
    const gltf = JSON.parse(readFileSync(file, "utf8")) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    const uris = [...(gltf.buffers ?? []), ...(gltf.images ?? [])].map((item) => item.uri).filter((uri): uri is string => !!uri && !/^[a-z]+:/i.test(uri));
    return uris.map((uri) => normalizePath(`${dirname(path)}/${decodeURIComponent(uri)}`));
  } catch {
    return [];
  }
}

/** "a/./b/../c.png" → "a/c.png": the one spelling of a project path that the build keys assets by. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
