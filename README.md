# comfyui-mcp-relay

A tiny WebSocket relay (Cloudflare Worker + Durable Object) that replaces
ephemeral `trycloudflare.com` quick tunnels for
[comfyui-mcp](https://github.com/artokun/comfyui-mcp)'s **secure bridge**.

## Why this exists

When comfyui-mcp's `connect <remote-https-url>` drives a RunPod pod, the pod's
HTTPS panel page can't open a plain `ws://127.0.0.1` socket to the agent bridge
on your laptop (browsers block insecure sockets from a secure origin — mixed
content / Private Network Access). The fix is a valid-TLS `wss://` endpoint.

comfyui-mcp originally got that via a `cloudflared` **quick tunnel** — free, but
ephemeral (random hostname every run, "no uptime guarantee" per Cloudflare's own
disclaimer) and it dropped mid-session during long idle stretches. This repo is a
small, self-hosted replacement: a Worker + Durable Object you deploy once, that
gives every `connect` session a stable relay endpoint under your own domain.

## How it works

Both sides **dial out** to the relay — nobody needs an inbound port open:

```
LAPTOP                         RELAY (this repo)              POD BROWSER
orchestrator ──dial out──▶  Worker ──▶ Durable Object  ◀──dial out── panel (per tab)
 (comfyui-mcp bridge)         (routes /s/<sessionId>)      (comfyui-mcp-panel)
```

One Durable Object instance per session (`idFromName(sessionId)`) pairs exactly
one **orchestrator** connection with any number of **panel** connections (one per
open browser tab) and relays bytes between them.

### Wire protocol

- **Orchestrator** (single control connection):
  `wss://<host>/s/<sessionId>?role=orchestrator&token=<token>`
- **Panel** (one per tab):
  `wss://<host>/s/<sessionId>?token=<token>` (role defaults to `panel`)

The **panel leg carries raw, un-enveloped bridge-protocol bytes** — a panel tab's
messages pass through completely unmodified, exactly as if it had dialed the
bridge directly. **comfyui-mcp-panel needs zero code changes for this.**

The **orchestrator's single connection is multiplexed** (since it's one physical
socket standing in for N panel-tab connections) using a small JSON envelope:

| Direction | Message | Meaning |
|---|---|---|
| DO → orchestrator | `{"t":"open","id":"<connId>"}` | a new panel tab attached |
| DO → orchestrator | `{"t":"data","id":"<connId>","d":"<raw frame>"}` | a frame from that tab |
| DO → orchestrator | `{"t":"close","id":"<connId>"}` | that tab disconnected |
| orchestrator → DO | `{"t":"data","id":"<connId>","d":"<raw frame>"}` | send a frame to that tab |
| orchestrator → DO | `{"t":"ping"}` | liveness probe → DO replies `{"t":"pong"}` |

The DO never parses bridge-protocol JSON (hello/rid/cmd) — it's a pure byte relay
keyed by connection id.

### Auth (two independent gates)

1. **Session token** (`?token=`) — generated fresh per `connect` session by
   comfyui-mcp, gates read/write access to that session's traffic. Whoever
   connects first as `role=orchestrator` sets the session's token (persisted in
   Durable Object storage so a reconnecting orchestrator after a network blip is
   still recognized); every subsequent connection (panel or orchestrator) must
   present the matching token.
2. **`RELAY_ACCESS_KEY`** (optional, `?key=`) — a shared secret gating who can
   open a session *at all*, independent of the per-session token. Protects your
   Worker/Durable Object usage from being burned by strangers. Set it once this
   has a public URL:
   ```bash
   wrangler secret put RELAY_ACCESS_KEY
   ```

## Deploy

```bash
npm install
wrangler login          # one-time, opens a browser OAuth flow
npm run deploy
```

`wrangler deploy` prints your Worker's URL (`https://comfyui-mcp-relay.<subdomain>.workers.dev`
by default — the relay uses `wss://` on the same host). Optionally bind a custom
domain in the Cloudflare dashboard.

Then point comfyui-mcp at it:
```bash
export COMFYUI_MCP_RELAY_URL=wss://comfyui-mcp-relay.<subdomain>.workers.dev
export COMFYUI_MCP_TUNNEL_BACKEND=relay   # opt-in until this is the default
```

## Notes / known limitations (v1)

- **Not using WebSocket Hibernation.** The Durable Object holds live JS
  references to open sockets rather than the hibernatable-WebSocket API, which
  is simpler but means the DO stays memory-resident (billed) for the duration of
  every open connection, not just active traffic. Fine at personal/small scale;
  worth revisiting (`state.acceptWebSocket()` + `webSocketMessage`/`webSocketClose`
  handlers) if this ever needs to scale to many concurrent sessions.
- **No per-panel-tab keepalive at the relay layer.** comfyui-mcp's own bridge
  already pings connected sockets it owns directly; relay-mediated panel
  connections aren't currently included in that loop. Cloudflare Worker/Durable
  Object-owned WebSockets don't have the same idle-reap behavior as a quick
  tunnel (a different, ephemeral Cloudflare product), so this is believed
  low-risk — flag it if drops resurface after switching to the relay.
- **Pricing.** Durable Objects with the SQLite storage backend (`new_sqlite_classes`,
  used here) are intended to work on Cloudflare's free Workers plan — verify
  current pricing/limits at deploy time, since this may change.

## Relationship to the other repos

This repo has **no shared package/types** with
[comfyui-mcp](https://github.com/artokun/comfyui-mcp) or
[comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel) — just the wire
protocol documented above. If you change the envelope format here, update
`src/services/relay-client.ts` in comfyui-mcp to match.
