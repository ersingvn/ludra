import { Emitter } from "./dom.ts";
import type { GameMessage, StudioMessage } from "./protocol.ts";

type Events = { [K in GameMessage["type"]]: Extract<GameMessage, { type: K }> } & { any: GameMessage };

/** The Studio side of the game link: postMessage to and from the game iframe. */
export class GameLink extends Emitter<Events> {
  private frame: HTMLIFrameElement | null = null;
  private readonly origin: string;

  constructor(origin: string) {
    super();
    this.origin = origin;
    window.addEventListener("message", (e: MessageEvent) => {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const msg = e.data as { ludra?: unknown; type?: unknown } | null;
      if (!msg || typeof msg !== "object" || msg.ludra !== 1 || typeof msg.type !== "string") return;
      const message = msg as unknown as GameMessage;
      this.emit(message.type, message as never);
      this.emit("any", message);
    });
  }

  attach(frame: HTMLIFrameElement): void {
    this.frame = frame;
  }

  send(message: StudioMessage): void {
    this.frame?.contentWindow?.postMessage({ ludra: 1, ...message }, this.origin);
  }

  /** For the mock: messages that aren't in the contract. */
  sendRaw(message: Record<string, unknown>): void {
    this.frame?.contentWindow?.postMessage({ ludra: 1, ...message }, this.origin);
  }
}
