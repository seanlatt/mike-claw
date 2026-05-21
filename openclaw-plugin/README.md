# openclaw-plugin-mike-tools

Exposes Mike's legal-assistant document tools to OpenClaw agents. Runs inside the OpenClaw gateway as a tool plugin and proxies each call to Mike's Express backend over `localhost`.

## Tools

| Name | Description |
|---|---|
| `mike_list_documents` | List a user's Mike documents, optionally scoped by project. |
| `mike_read_document` | Read the extracted text of a Mike document by id (PDF or DOCX). |

Read-only on purpose. Edits, drafting, and document generation still go through Mike's chat path until a write-path equivalent is wired with explicit approval.

## Configuration

The plugin reads two env vars from the gateway process:

| Var | Purpose | Default |
|---|---|---|
| `MIKE_API_URL` | Where Mike's Express backend is reachable. | `http://127.0.0.1:3001` |
| `MIKE_INTERNAL_TOKEN` | Shared secret. Mike rejects `/openclaw/tools/*` calls without a matching `X-Mike-Internal` header. | (required) |

Mike's `.env.example` documents the matching `MIKE_INTERNAL_TOKEN` on the backend side. Both must be set to the same value.

Setting these on the gateway depends on how OpenClaw is launched on your machine:

- **launchd (macOS, default)**: add `EnvironmentVariables` to `~/Library/LaunchAgents/ai.openclaw.gateway.plist`, then `launchctl bootout`/`launchctl bootstrap` the agent. Or run `openclaw gateway restart` after editing.
- **Foreground dev**: just `export` before `openclaw gateway run`.

## Build & install

```bash
cd mike/openclaw-plugin
npm install
npm run build
openclaw plugins install . --link --force
openclaw gateway restart
openclaw plugins list | grep mike-tools
openclaw plugins inspect openclaw-plugin-mike-tools
```

`--link` symlinks the local build so editing + rebuilding picks up automatically. Drop it once the plugin is stable.

## Verify

```bash
openclaw gateway call agent --params '{
  "agentId":"main",
  "sessionId":"mike-plugin-check",
  "sessionKey":"agent=main:session=mike-plugin-check",
  "message":"List the names of any mike_ tools you can see.",
  "modelRun":true,
  "promptMode":"none",
  "idempotencyKey":"mike-plugin-check"
}' --expect-final --timeout 30000 --json | jq '.result.payloads[0].text'
```

The model should mention `mike_list_documents` and `mike_read_document`.
