import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "ludra-live-browser.lock");
/** A lock older than this was left by a test run that was killed. */
const STALE_MS = 10 * 60 * 1000;

/**
 * Runs `play` while no other test file plays a game in a real browser. `node --test` runs files at
 * once, and two or three Chromes playing in real time on one machine slow each other until keys and
 * a take's last moments are lost. A folder is the lock: making one is atomic on every OS.
 */
export async function oneLiveBrowser<T>(play: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) rmSync(LOCK, { recursive: true, force: true });
      } catch {
        // Gone between the two calls: try again.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    return await play();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
