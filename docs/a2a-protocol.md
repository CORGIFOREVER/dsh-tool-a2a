# A2A protocol reference (Agent2Agent)

This is the protocol knowledge behind `dsh-tool-a2a` — the same content ships as a DSH skill (`a2a-client`)
so any agent can interoperate over A2A **even without the plugin installed**, using its own shell/web tools
(curl / Invoke-RestMethod). A2A servers are plain HTTP endpoints; no extra tooling is required.

A2A (Agent2Agent) is Google's open protocol for agent-to-agent communication over HTTP JSON-RPC.

## Protocol essentials (verified against the official `@a2a-js/sdk`)

1. **Version header is mandatory**: every JSON-RPC request must send `A2A-Version: 1.0`. Without it the server
   rejects with "requested A2A protocol version '0.3' is not supported".
2. **Method names are PascalCase** (v1.0): `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`,
   `GetAgentCard`, `ListTasks`, `SubscribeToTask`. The kebab-case v0.3 names (`tasks/send`, `message/send`) are
   NOT accepted by v1.0 servers.
3. **Message shape**: parts use the flat `{"text": "..."}` form on the wire; `role` is `"user"` / `"agent"` (wire)
   or numeric enum (in SDK objects); every message needs a `messageId` (UUID) — servers reject messages without one.

## Discovery

```bash
curl -s http://<host>:<port>/.well-known/agent-card.json
```

Read `name`, `description`, `skills` (what the agent can do), and `supportedInterfaces`
(`protocolBinding` `JSONRPC`/`HTTP+JSON`, `protocolVersion`). Always discover the card before calling an
unknown A2A agent.

## Send a message (blocking)

```bash
# request.json:
# {"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"<uuid>","role":"user","parts":[{"text":"..."}]}}}
curl -s -X POST http://<host>:<port>/ -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' --data-binary @request.json
```

The response is either `{"result":{"message": {...}}}` (final agent message; `role:"ROLE_AGENT"`, `parts[].text`)
or `{"result":{"task": {...}}}` (task wrapper with `status.state`). Always include `messageId` (generate a UUID) —
required. Generate it with PowerShell: `[guid]::NewGuid().ToString()` or Node: `crypto.randomUUID()`.

## Stream a message (long-running tasks)

```bash
# Same shape but method "SendStreamingMessage"; the server replies with Server-Sent Events:
# event: message  / event: status-update  / event: artifact-update
curl -s -N -X POST http://<host>:<port>/ -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' -H 'Accept: text/event-stream' --data-binary @request.json
```

Consume SSE lines until a `task` event with `status.state == "COMPLETED"` (or `FAILED`/`CANCELED`).

## Poll / cancel

```bash
# GetTask:    {"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"taskId":"<id>","contextId":"<ctx>"}}
# CancelTask: {"jsonrpc":"2.0","id":1,"method":"CancelTask","params":{"taskId":"<id>","contextId":"<ctx>"}}
```

## Task states

`SUBMITTED` → `WORKING` → `COMPLETED` | `FAILED` | `CANCELED` | `INPUT_REQUIRED` | `REJECTED` | `AUTH_REQUIRED`.

## Standing up your own endpoint

The `bridge/` directory in this repository is a self-contained LLM-backed A2A server
(official `@a2a-js/sdk` + Express, OpenAI-compatible chat-completions backend):

```bash
cd bridge
npm install
export A2A_HOST=127.0.0.1            # 0.0.0.0 for cross-network
export A2A_PORT=4123
export DEEPSEEK_BASE=<OpenAI-compatible API base URL>   # required
export DEEPSEEK_MODEL=<model id>                        # optional
export DEEPSEEK_API_KEY=<key>                           # optional; falls back to ${DSH_HOME:-~/.dsh}/.credentials.yaml
node server.mjs
```

Windows helper (set the same env vars in your shell first):

```powershell
.\bridge\a2a-bridge.ps1 start        # local
.\bridge\a2a-bridge.ps1 start -Lan   # cross-network
.\bridge\a2a-bridge.ps1 stop
```

Smoke test against any running A2A server:

```bash
cd bridge
A2A_URL=http://<host>:<port> node test-client.mjs
```

## Rules

- Always send `A2A-Version: 1.0`.
- Always generate a fresh `messageId` per message.
- Discover the AgentCard first for unknown servers; respect its `skills` and `supportedInterfaces`.
- Reasoning-model backends can return empty `content` when the budget is consumed by reasoning; check the model's
  reasoning output or increase `max_tokens` (the bundled bridge falls back automatically).
- Cross-network means HTTP: any machine that can reach the server's URL can interoperate. The bridge binds
  127.0.0.1 by default; use `A2A_HOST=0.0.0.0` when you intend LAN exposure.
