# dsh-tool-a2a

A2A (Agent2Agent) client tools for DeepSeek Harness (DSH) agents.
Registers structured `a2a_discover` / `a2a_send` / `a2a_get` / `a2a_cancel` tools so an agent can interoperate with
any A2A agent — Google's open Agent2Agent protocol over HTTP JSON-RPC — instead of hand-rolling curl calls.

The repo also ships an optional LLM-backed A2A bridge (`bridge/`) so you can stand up your own A2A endpoint in minutes.

> **No hardcoded endpoints or absolute paths**: every deployment-specific value comes from plugin config or
> environment variables. See [Configuration](#configuration).

## Tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `a2a_discover` | Fetch an A2A agent card (name, description, skills, interfaces) | `baseUrl` |
| `a2a_send` | Send a message to an A2A agent and get its reply (blocking) | `text`, `baseUrl?`, `taskId?`, `contextId?` |
| `a2a_get` | Poll a task's status / reply | `taskId`, `contextId?` |
| `a2a_cancel` | Cancel a running task | `taskId`, `contextId?` |

Protocol details are hard-won and verified against the official `@a2a-js/sdk`:
- every JSON-RPC request must send the `A2A-Version: 1.0` header;
- v1.0 method names are PascalCase (`SendMessage`, `GetTask`, `CancelTask`, ...);
- every message needs a `messageId`.

## Installation (into a DSH web profile)

```bash
# from the profile directory (e.g. ~/.dsh/profiles/web)
npm install dsh-tool-a2a
# or install straight from the repository:
#   npm install git+https://github.com/CORGIFOREVER/dsh-tool-a2a.git
```

Then add a row to the profile's `cordis.patch.yml`:

```yaml
- id: tool-a2a
  name: 'dsh-tool-a2a'
  config:
    baseUrl: <A2A server base URL>   # required — e.g. your local bridge, or any remote A2A agent
    timeoutMs: 120000                # optional
```

Restart the harness. The four `a2a_*` tools then appear in the agent's catalog.

## Configuration

| Key | Required | Meaning |
| --- | --- | --- |
| `baseUrl` | yes | A2A server base URL. Set in plugin config, or default to the `A2A_BASE_URL` environment variable. No URL is hardcoded in source. |
| `timeoutMs` | no | Per-call timeout (default `120000`). |
| `maxReplyChars` | no | Reply truncation cap (default `16000`). |

Each tool also accepts an optional `baseUrl` parameter to override the configured default per call, so one plugin
can drive many different A2A agents.

## Optional: run your own A2A bridge

`bridge/` contains a self-contained LLM-backed A2A server (official `@a2a-js/sdk` + Express, OpenAI-compatible
chat-completions backend).

```bash
cd bridge
npm install
# all deployment specifics via environment — nothing hardcoded:
export A2A_HOST=127.0.0.1        # 0.0.0.0 for cross-network
export A2A_PORT=4123
export DEEPSEEK_BASE=<OpenAI-compatible API base URL>   # required
export DEEPSEEK_MODEL=<model id>                        # optional
export DEEPSEEK_API_KEY=<key>                           # optional; falls back to ${DSH_HOME:-~/.dsh}/.credentials.yaml
node server.mjs
```

Windows helper (sets the same env vars in your shell first):

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

### Agent card

Every A2A server advertises itself at `/.well-known/agent-card.json` — discover it with `a2a_discover` before
messaging an unknown agent.

## Releasing

The package is published to npm automatically from GitHub Actions via **OIDC trusted publishing (provenance)** —
no npm token and no OTP required.

1. Bump `version` in `package.json` (e.g. `0.1.1`).
2. Commit and push.
3. Tag and push:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The workflow checks that the tag matches `package.json`'s version, then runs `npm publish --provenance --access public`.
The npm registry verifies the GitHub OIDC identity against this repository's `repository` field.

## License

MIT
