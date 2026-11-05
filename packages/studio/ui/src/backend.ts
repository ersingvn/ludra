import type { Command, ProjectInfo, RunResponse, ServerEvent } from "./protocol.ts";

export type Connection = "connecting" | "live" | "lost";

/** What the UI needs from `ludra dev --studio`, or from the mock. */
export interface Backend {
  /** Where the game page is, for the iframe. */
  gameUrl: string;
  /** The origin to post game messages to. */
  gameOrigin: string;
  project(): Promise<ProjectInfo>;
  /** Server-sent events. Returns a function that stops listening. */
  listen(onEvent: (event: ServerEvent) => void, onConnection: (state: Connection) => void): () => void;
  run<T>(command: Command, args?: string[]): Promise<RunResponse<T>>;
}

export class ServerBackend implements Backend {
  readonly gameUrl: string;
  readonly gameOrigin: string;
  private readonly base: string;

  constructor(server: string) {
    this.base = server.replace(/\/+$/, "");
    this.gameUrl = `${this.base}/?studio=1`;
    this.gameOrigin = new URL(this.base).origin;
  }

  async project(): Promise<ProjectInfo> {
    const res = await fetch(`${this.base}/__ludra/project`);
    if (!res.ok) throw new Error(`GET /__ludra/project: ${res.status}`);
    return (await res.json()) as ProjectInfo;
  }

  listen(onEvent: (event: ServerEvent) => void, onConnection: (state: Connection) => void): () => void {
    onConnection("connecting");
    const source = new EventSource(`${this.base}/__ludra/events`);
    source.onopen = () => onConnection("live");
    // EventSource reconnects on its own; say so while it does.
    source.onerror = () => onConnection(source.readyState === EventSource.CLOSED ? "lost" : "connecting");
    source.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data) as ServerEvent);
      } catch {
        // A line that isn't JSON isn't for us.
      }
    };
    return () => source.close();
  }

  async run<T>(command: Command, args: string[] = []): Promise<RunResponse<T>> {
    const res = await fetch(`${this.base}/__ludra/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    if (!res.ok) throw new Error(`POST /__ludra/run ${command}: ${res.status} ${await res.text()}`);
    return (await res.json()) as RunResponse<T>;
  }
}
