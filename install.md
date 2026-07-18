# AI Self-Deployment Guide

This file is written for a Codex or other coding agent that has been asked to deploy Multi-Agent Port on a Mac, Windows, or Linux computer.

## Goal

Deploy one lightweight Relay and one Bridge on every computer that runs Codex. The Relay routes MCP Tool Calls. Each Bridge uses the local `codex app-server` login and creates or resumes normal Codex Desktop tasks.

Do not copy credentials from another computer. Never print bearer tokens, Bridge tokens, pairing credentials, private keys, or complete sensitive environment variables in chat or logs.

## 1. Inspect before changing anything

Record only non-secret values:

```text
OS and architecture
Node.js and npm versions
Codex executable path and version
Whether `codex app-server --listen stdio://` starts
Repository/install directory
Existing Relay or Bridge process/service
Default Codex project root
Every project root that remote Codex tasks must be allowed to enter
```

Requirements:

- Node.js 20 or newer
- npm
- a locally installed and authenticated Codex whose `app-server` command works
- network access from each Bridge to the Relay

If an existing installation is found, back up its startup script and preserve its credentials file and Bridge SQLite ledger before updating.

## 2. Install and verify the source

```bash
git clone https://github.com/luyii-code-1/muit-agent-port.git
cd muit-agent-port
npm ci
npm run check
npm test
npm run build
```

Do not continue to persistent service installation if type checking, tests, or build fails.

## 3. Start the Relay

Choose a computer reachable by every Codex computer. Generate a new admin token locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the Relay environment without committing secrets:

```text
MESH_HOST=0.0.0.0
MESH_PORT=8787
MESH_DB_PATH=<persistent-path>/mesh.db
MESH_MCP_TOKEN=<new-random-token>
MESH_BRIDGE_PACKAGE_PATH=<optional-path-to-bridge-zip>
```

Start and verify:

```bash
npm run start:relay
curl http://127.0.0.1:8787/healthz
```

Open `http://<relay-address>:8787/` on the private network. Use HTTPS/WSS through a reverse proxy when traffic leaves a trusted private network.

## 4. Pair each Bridge

Generate a six-digit one-time pairing code from the Relay dashboard or with `codex_mesh_pairing_code`.

Mac/Linux example:

```bash
npm run pair:bridge -- \
  --relay ws://<relay-address>:8787/bridge \
  --node <unique-node-id> \
  --code <six-digit-code> \
  --cwd /absolute/default/project/root \
  --inbox /absolute/default/project/root/.codex-mesh/inbox \
  --roots /absolute/default/project/root,/another/allowed/project \
  --labels macos,firmware
```

Windows PowerShell example:

```powershell
npm run pair:bridge -- --relay ws://<relay-address>:8787/bridge --node <unique-node-id> --code <six-digit-code> --cwd "C:\Users\user\Documents\Codex" --inbox "C:\Users\user\Documents\Codex\.codex-mesh\inbox" --roots "C:\Users\user\Documents\Codex,G:\Android-RID" --labels windows,android
```

The persistent Bridge service must provide these settings on every start:

```text
MESH_RELAY_URL
MESH_NODE_ID
MESH_CREDENTIALS_PATH
MESH_DEFAULT_CWD
MESH_INBOX_ROOT
MESH_ALLOWED_ROOTS
MESH_CODEX_COMMAND
MESH_BRIDGE_DB_PATH
MESH_APPROVAL_POLICY=never
MESH_SANDBOX=workspace-write
```

`MESH_ALLOWED_ROOTS` must include every existing project whose Codex task will be resumed. Keep it narrow: list project roots explicitly instead of allowing a whole user profile or disk. New cross-computer conversations are created as isolated empty projects below `MESH_INBOX_ROOT`.

Use the operating system's normal user-level service manager to keep the Bridge running:

- macOS: LaunchAgent
- Windows: Task Scheduler or a user startup script
- Linux: systemd user service

Run the service as the same user whose Codex Desktop/CLI is authenticated. Preserve the generated credentials file and local Bridge ledger across upgrades.

## 5. Add the Relay MCP server to Codex

Store the Relay admin token in an environment variable available to Codex, for example `CODEX_MESH_TOKEN`. Add the MCP server to the user's global `~/.codex/config.toml`:

```toml
[mcp_servers.codex_mesh]
url = "http://<relay-address>:8787/mcp"
bearer_token_env_var = "CODEX_MESH_TOKEN"
tool_timeout_sec = 70
enabled = true
```

Restart Codex after changing global configuration, then verify the server appears in `/mcp`. Do not put the token directly in a repository-level config file.

## 6. End-to-end validation

1. Call `codex_mesh_nodes` and confirm every expected computer is connected.
2. Call `codex_mesh_threads` and locate a harmless existing target task.
3. Send a consultation with `codex_mesh_delegate(routing="exact")` asking it to assess a read-only command.
4. Read its `READY` response.
5. Call `codex_mesh_confirm` and run only a harmless command such as `echo MESH_OK` plus the current directory.
6. Confirm the result is returned and the message appears inside the expected Codex Desktop task.
7. Test an allowed project outside the default root when the deployment uses multiple roots.

Do not test deployment by editing application source code.

## 7. Two-phase collaboration rule

### Verify Desktop attachment

1. Keep Codex Desktop running on the target computer and load the existing task that should receive work.
2. Send a consultation with `routing=exact` and that task ID.
3. The Relay dashboard should show `Desktop 附着`, and the new turn should appear in the original Desktop task.
4. The live timeline should show status, Thinking summaries, tool calls, commands, or file events as Codex exposes them.

The Desktop IPC endpoint is `\\.\pipe\codex-ipc` on Windows and `~/.codex/ipc/ipc.sock` on macOS. If Desktop is unavailable or no Desktop window owns the target task, the Bridge reports an IPC error instead of claiming that work is still running.

`routing=new` has no existing Desktop task to attach to, so it intentionally uses the empty-project background mode and is labeled `后台` in the dashboard.

All state-changing delegated work follows two phases:

1. `codex_mesh_delegate`: inspect and discuss current state; no modifications.
2. `codex_mesh_confirm`: authorize the agreed work in the same remote conversation.

Use `wait_seconds=0` on confirmation when the local and remote Codex should work in parallel. Poll the returned execution task later with `codex_mesh_task`.

## 8. Recover a stuck task

The current Bridge executes one task at a time by default. A long-running Codex turn therefore leaves later tasks in `dispatched` until the first turn ends.

Check the original task rather than repeatedly delegating duplicates:

```text
codex_mesh_task(task_id=<original-task-id>, wait_seconds=0)
```

If it remains `running` with no update:

1. Do not assume Codex Desktop will show the turn as running. A turn started by the Bridge's external `codex app-server` client may exist only in the background even when its thread is visible in history.
2. Restart that computer's Bridge service or its narrowly identified Bridge process. Do not terminate every `node` or Codex process on the computer.
3. Confirm the interrupted `running` task and any already accepted queued duplicate reach `failed`. Bridge restart intentionally blocks automatic replay to avoid duplicate edits.
4. Dispatch one concise replacement consultation only after the queue is clear.

Do not keep creating retries while the Bridge concurrency is occupied. The present release has no remote cancellation Tool Call and its internal turn timeout is intentionally long, so restarting the Bridge is the reliable recovery path. Desktop task visibility is not a cancellation mechanism.

## 9. Upgrade

```bash
git pull --ff-only
npm ci
npm run check
npm test
npm run build
```

Back up the startup configuration, preserve credentials and the Bridge ledger, then restart Relay/Bridge services one at a time. Verify node reconnection and one harmless exact-thread consultation after every upgrade.

## Completion report

An AI installer should report:

- installed commit and path
- Relay address without tokens
- node IDs and non-secret labels
- service/startup mechanism
- default, inbox, and allowed roots
- type-check, test, and build results
- end-to-end consultation/confirmation result
- any remaining manual or permission-dependent step

Never include credentials or historical task content in the report.
