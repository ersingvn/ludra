import type { Command, EditRequest, EditResult, FileText, ProjectInfo, RunResponse, ServerEvent, UndoResult } from "./protocol.ts";

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
  /** A file's text and version (GET /__ludra/file). */
  file(path: string): Promise<FileText>;
  /** Writes edits to a scene file. Refusals (400, 409, 422) come back as { ok: false }; only network failures throw. */
  edit(req: EditRequest): Promise<EditResult>;
  /** Undoes or redoes Studio's own last edit. */
  undo(): Promise<UndoResult>;
  redo(): Promise<UndoResult>;
}

export class ServerBackend implements Backend {
  readonly gameUrl: string;
  readonly gameOrigin: string;
  private readonly base: string;
  /** The `?token=` part every studio request carries, or "" when the server has none. */
  private readonly auth: string;

  constructor(server: string, token = "") {
    this.base = server.replace(/\/+$/, "");
    this.auth = token ? `?token=${encodeURIComponent(token)}` : "";
    this.gameUrl = `${this.base}/?studio=1${token ? `&token=${encodeURIComponent(token)}` : ""}`;
    this.gameOrigin = new URL(this.base).origin;
  }

  async project(): Promise<ProjectInfo> {
    const res = await fetch(`${this.base}/__ludra/project${this.auth}`);
    if (!res.ok) throw new Error(`GET /__ludra/project: ${res.status}`);
    return (await res.json()) as ProjectInfo;
  }

  listen(onEvent: (event: ServerEvent) => void, onConnection: (state: Connection) => void): () => void {
    onConnection("connecting");
    const source = new EventSource(`${this.base}/__ludra/events${this.auth}`);
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

  async file(path: string): Promise<FileText> {
    const res = await fetch(`${this.base}/__ludra/file${this.auth ? `${this.auth}&` : "?"}path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`GET /__ludra/file ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as FileText;
  }

  async edit(req: EditRequest): Promise<EditResult> {
    const res = await this.post("edit", req);
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok) return body as EditResult;
    if (res.status === 400 || res.status === 409 || res.status === 422) return { ...body, ok: false, status: res.status } as EditResult;
    throw new Error(`POST /__ludra/edit: ${res.status} ${JSON.stringify(body)}`);
  }

  async undo(): Promise<UndoResult> {
    return this.history("undo");
  }

  async redo(): Promise<UndoResult> {
    return this.history("redo");
  }

  private async history(which: "undo" | "redo"): Promise<UndoResult> {
    const res = await this.post(which, {});
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok) return body as UndoResult;
    if (res.status === 409) return { ...body, ok: false, status: 409 } as UndoResult;
    throw new Error(`POST /__ludra/${which}: ${res.status} ${JSON.stringify(body)}`);
  }

  private post(endpoint: string, body: unknown): Promise<Response> {
    return fetch(`${this.base}/__ludra/${endpoint}${this.auth}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async run<T>(command: Command, args: string[] = []): Promise<RunResponse<T>> {
    const res = await fetch(`${this.base}/__ludra/run${this.auth}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    if (!res.ok) throw new Error(`POST /__ludra/run ${command}: ${res.status} ${await res.text()}`);
    return (await res.json()) as RunResponse<T>;
  }
}
