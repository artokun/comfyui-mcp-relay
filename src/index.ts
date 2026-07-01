import { Relay } from "./relay";

export { Relay };

export interface Env {
  RELAY: DurableObjectNamespace;
  /** Optional shared anti-abuse key — see wrangler.toml. */
  RELAY_ACCESS_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("comfyui-mcp-relay: ok\n");
    }

    const m = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,128})$/);
    if (!m) {
      return new Response("expected /s/<sessionId>\n", { status: 404 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade\n", { status: 426 });
    }
    if (env.RELAY_ACCESS_KEY && url.searchParams.get("key") !== env.RELAY_ACCESS_KEY) {
      return new Response("unauthorized\n", { status: 401 });
    }

    // One Durable Object instance per session id — it pairs the orchestrator's
    // single control connection with N panel (browser tab) connections and
    // relays bytes between them. See relay.ts for the wire protocol.
    const sessionId = m[1];
    const id = env.RELAY.idFromName(sessionId);
    const stub = env.RELAY.get(id);
    return stub.fetch(request);
  },
};
