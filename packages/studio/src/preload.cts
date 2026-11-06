/**
 * `window.studio`: what the Studio UI may ask the desktop app for (docs/studio.md, "Shell").
 * A sandboxed preload, so CommonJS, and only these calls cross into the main process.
 */
import type { IpcRendererEvent } from "electron";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

interface Info {
  version: string;
  platform: string;
  project: { dir: string; url: string } | null;
}

const info = ipcRenderer.sendSync("studio:info") as Info;

contextBridge.exposeInMainWorld("studio", {
  version: info.version,
  platform: info.platform,
  project: info.project,
  /** Asks for a folder and opens it. Resolves false if cancelled or not a game. */
  openProject: (): Promise<boolean> => ipcRenderer.invoke("studio:open-project"),
  openRecent: (dir: string): Promise<boolean> => ipcRenderer.invoke("studio:open-recent", dir),
  recent: (): Promise<string[]> => ipcRenderer.invoke("studio:recent"),
  /** Shows a project file (path relative to the project) in Explorer / Finder. */
  reveal: (path: string): Promise<boolean> => ipcRenderer.invoke("studio:reveal", path),
  /** Opens a project file in the person's editor, at a line if given. */
  openInEditor: (path: string, line?: number): Promise<boolean> => ipcRenderer.invoke("studio:open-in-editor", path, line),
  /** Menu commands: "play", "step", "restart", "pick", "check", "test", "review". Returns an unsubscribe. */
  onMenu: (callback: (command: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, command: string) => callback(command);
    ipcRenderer.on("studio:menu", listener);
    return () => ipcRenderer.removeListener("studio:menu", listener);
  },
});
