export interface Env {}

interface Envelope {
  t: "open" | "data" | "close" | "ping" | "pong";
  id?: string;
  d?: string;
}

/**
 * Durable Object: one instance per comfyui-mcp bridge session (keyed by session
 * id — see index.ts's idFromName).
 *
 * Wire protocol
 * -------------
 * Orchestrator (exactly one — the "control" connection):
 *   connects to  /s/<sessionId>?role=orchestrator&token=<token>
 *   receives  {t:"open", id}      a new panel (browser tab) connection attached
 *             {t:"data", id, d}   a raw bridge frame FROM that panel connection
 *             {t:"close", id}     that panel connection went away
 *   sends     {t:"data", id, d}   a raw bridge frame TO a specific panel connection
 *             {t:"ping"}          liveness probe -> DO replies {t:"pong"}
 *
 * Panel (any number — one per browser tab):
 *   connects to  /s/<sessionId>?token=<token>        (role defaults to "panel")
 *   sees NO envelope: raw bridge-protocol bytes pass through unmodified in both
 *   directions, exactly as if it had dialed the bridge directly. This is why
 *   comfyui-mcp-panel needs ZERO changes to speak through the relay — only the
 *   URL it's given (by advertise_bridge) changes.
 *
 * The DO never parses the bridge protocol itself (hello/rid/cmd JSON) — it only
 * speaks the {t,id,d} envelope on the orchestrator leg, and is otherwise a pure
 * byte relay between whichever two sockets are paired for a given connection id.
 *
 * The session token is remembered in Durable Object storage (survives the DO
 * being evicted from memory between connections — e.g. the orchestrator restarts
 * after every socket has dropped) so a reconnecting orchestrator is recognized
 * as continuing the same session rather than being treated as a new one.
 */
export class Relay {
  state: DurableObjectState;
  orchestrator: WebSocket | null = null;
  panels = new Map<string, WebSocket>();
  token: string | null = null;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "orchestrator" ? "orchestrator" : "panel";
    const token = url.searchParams.get("token") ?? "";
    if (!token) return new Response("missing token\n", { status: 401 });

    if (this.token === null) {
      this.token = (await this.state.storage.get<string>("token")) ?? null;
    }

    if (role === "orchestrator") {
      if (this.token !== null && this.token !== token) {
        return new Response("session token mismatch\n", { status: 401 });
      }
      if (this.token === null) {
        this.token = token;
        await this.state.storage.put("token", token);
      }
    } else if (this.token === null || this.token !== token) {
      // A panel can't be first — the orchestrator must connect (and set the
      // session token) before any panel tab is admitted.
      return new Response("no orchestrator connected yet, or token mismatch\n", {
        status: 401,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (role === "orchestrator") {
      this.attachOrchestrator(server);
    } else {
      this.attachPanel(server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private attachOrchestrator(sock: WebSocket): void {
    // A fresh orchestrator connection SUPERSEDES a stale one (reconnect after a
    // network blip) so we never have two "control" sockets racing.
    if (this.orchestrator && this.orchestrator !== sock) {
      try {
        this.orchestrator.close();
      } catch {
        // already gone
      }
    }
    this.orchestrator = sock;

    sock.addEventListener("message", (ev: MessageEvent) => {
      let msg: Envelope;
      try {
        msg = JSON.parse(
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer),
        );
      } catch {
        return;
      }
      if (msg.t === "data" && msg.id) {
        try {
          this.panels.get(msg.id)?.send(msg.d ?? "");
        } catch {
          // panel socket gone — its own close listener will clean up the map
        }
      } else if (msg.t === "close" && msg.id) {
        const p = this.panels.get(msg.id);
        try {
          p?.close();
        } catch {
          // already gone
        }
        this.panels.delete(msg.id);
      } else if (msg.t === "ping") {
        try {
          sock.send(JSON.stringify({ t: "pong" }));
        } catch {
          // socket gone
        }
      }
    });
    sock.addEventListener("close", () => {
      if (this.orchestrator === sock) this.orchestrator = null;
    });
    sock.addEventListener("error", () => {
      if (this.orchestrator === sock) this.orchestrator = null;
    });
  }

  private attachPanel(sock: WebSocket): void {
    const id = crypto.randomUUID();
    this.panels.set(id, sock);
    this.notifyOrchestrator({ t: "open", id });

    sock.addEventListener("message", (ev: MessageEvent) => {
      const d =
        typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      this.notifyOrchestrator({ t: "data", id, d });
    });
    const onGone = () => {
      this.panels.delete(id);
      this.notifyOrchestrator({ t: "close", id });
    };
    sock.addEventListener("close", onGone);
    sock.addEventListener("error", onGone);
  }

  private notifyOrchestrator(msg: Envelope): void {
    if (!this.orchestrator) return; // orchestrator not (yet/currently) connected — drop
    try {
      this.orchestrator.send(JSON.stringify(msg));
    } catch {
      this.orchestrator = null;
    }
  }
}
