# claude-code-runner

A small HTTP API that runs [Claude Code](https://code.claude.com) sessions in your project folders, in a Docker container, using the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

It was built so that a lightweight agent, such as a voice assistant on a smart speaker, can hand bigger jobs to Claude Code: "find out why Grafana is not loading", "fix the failing test in project X". When Claude needs a decision, its question or permission request becomes a **prompt** that the caller reads and answers over the same API.

```
 caller (voice agent, script, UI)            claude-code-runner                     Claude Code
 ─────────────────────────────────          ───────────────────────                ─────────────
 POST /sessions {prompt, project}  ───────►  session s_k3x9q2mw  ─── streaming ───►  works in /opt/workspace/<project>
                                             status: running                        wants to run `docker restart grafana`
 webhook {event:"prompt", prompt}  ◄───────  status: waiting  ◄──── canUseTool ────  (waits)
 POST /prompts/p_… {"allow": true} ───────►  resolves the prompt ─────────────────►  continues
 webhook {event:"turn_done"}       ◄───────  status: idle, lastResult ◄── result ──  "Grafana's volume was full; fixed."
 POST /sessions/s_…/messages       ───────►  resumes the same conversation
```

- **Several sessions at once**, each in its own folder (`MAX_ACTIVE_SESSIONS`).
- **Questions and permission requests** (Claude's `AskUserQuestion` and tool approvals) come back as prompts with one readable sentence and the exact answer format.
- **Conversations continue**: send a follow-up any time. Messages sent while Claude works are queued, or can interrupt it.
- **Idle sessions cost nothing**: the Claude Code process exits after each turn and the next message resumes the conversation.
- Plain `node:http`, one runtime dependency (`@anthropic-ai/claude-agent-sdk`), no build step (Node 24 runs the TypeScript directly).

## Quick start (Docker)

```bash
git clone https://github.com/aformusatii/claude-code-runner.git && cd claude-code-runner
mkdir home                       # the container's home: Claude login, gh login, git config
cp .env.example .env             # then edit: API_TOKEN, WORKSPACE_DIR, WORKSPACE_ROOT, DOCKER_GID, login
docker compose up -d --build
curl -s localhost:8064/health
```

`API_TOKEN` is required (`openssl rand -hex 24`). The server refuses to start without it.

### Log in to Claude (choose one)

| Option | How |
|---|---|
| Subscription token (recommended) | Run `claude setup-token` on any machine with Claude Code, put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN` |
| API key | `ANTHROPIC_API_KEY` in `.env` |
| Interactive login | `docker compose exec -it claude-code-runner claude`, then `/login`. Stored in `./home/.claude*` |

Optional: `GH_TOKEN` (or `docker compose exec -it claude-code-runner gh auth login`) lets Claude push and open PRs, and `GIT_AUTHOR_*` / `GIT_COMMITTER_*` set the commit identity.

### What's in the image

Node 24, git, the GitHub CLI (git uses it for github.com credentials), the Docker CLI with the compose plugin (it talks to the mounted host socket), Python 3 with venv/pip, build-essential, ripgrep, jq and curl. The `claude` CLI is the binary bundled with the SDK, so its version always matches the SDK. The container runs as `node` (uid 1000). It gets Docker access through `group_add: DOCKER_GID`, so there's no root at runtime.

## API

Every endpoint except `GET /` and `GET /health` needs `Authorization: Bearer <API_TOKEN>`. Bodies are JSON. Errors look like `{"error": {"code": "...", "message": "..."}}`. `GET /` describes the API in JSON, so an agent can learn it without this file.

| Method and path | Body / query | What it does |
|---|---|---|
| `GET /health` | | `{ok, activeSessions, maxActiveSessions}` |
| `GET /projects` | | The folders under `WORKSPACE_ROOT`: `[{name, path, git}]` |
| `POST /sessions` | `{prompt, project?, permissionMode?, model?, maxTurns?, maxBudgetUsd?}` | Starts a session (201). Without `project` it runs in `WORKSPACE_ROOT` itself |
| `GET /sessions` | `?status=` | All sessions, newest first |
| `GET /sessions/:id` | | One session (see below) |
| `GET /sessions/:id/events` | `?after=<seq>&wait=<s ≤ 60>` | What Claude did: messages, text, tool calls, prompts, answers, results. Long-poll |
| `POST /sessions/:id/messages` | `{text, interrupt?}` | Continues the conversation. `{queued: true}` when Claude was busy. `interrupt: true` ends the current turn first |
| `POST /sessions/:id/stop` | | Stops the current turn and declines its open prompts. A later message resumes |
| `DELETE /sessions/:id` | | Stops and forgets the session |
| `GET /prompts` | | Every open prompt across sessions, oldest first |
| `POST /prompts/:id` | see below | Answers a prompt; Claude continues |

`project` is a folder name under `WORKSPACE_ROOT`, or a relative path such as `homelab/docs`. Top-level names match case-insensitively, because speech-to-text rarely gets the case right. Absolute paths, `..`, and symlinks that point outside the root are refused.

### A session

```jsonc
{
  "id": "s_k3x9q2mw",
  "project": "EchoDotClientV1",
  "cwd": "/opt/workspace/repositories/EchoDotClientV1",
  "title": "why is grafana not loading",
  "status": "waiting",              // running | waiting | idle | stopped | failed
  "prompts": [ /* open prompts, see below */ ],
  "queuedMessages": 0,
  "lastText": "Grafana returns 502; checking its container…",   // progress while it works
  "lastResult": { "ok": true, "text": "…", "at": "…" },          // answer of the last finished turn
  "costUsd": 0.0123,                // estimated, cumulative for the session
  "claudeSessionId": "2d6e7f38-…",  // Claude Code's resume id
  "options": { "permissionMode": "default", "model": "…", "maxTurns": 30 },
  "error": null,
  "createdAt": "…", "updatedAt": "…"
}
```

| Status | Meaning | What to do |
|---|---|---|
| `running` | Claude is working | Wait, poll, or watch `events` |
| `waiting` | Claude asked something | Answer each entry in `prompts` |
| `idle` | The turn is done | Read `lastResult` (`ok: false` = an error result such as "Not logged in", max turns or budget). Send a message to continue |
| `stopped` | Someone stopped it | Send a message to continue |
| `failed` | Claude Code crashed or couldn't start (`error`) | Send a message to retry |

### Prompts: how Claude asks

Claude Code asks in two ways, and both arrive as a prompt:

```jsonc
// permission: Claude wants to use a tool that isn't pre-approved
{ "id": "p_vez2gw8z", "sessionId": "s_…", "project": "homelab", "kind": "permission",
  "text": "Claude wants to run: docker restart grafana (Restart Grafana)",
  "tool": "Bash", "input": { "command": "docker restart grafana", "description": "Restart Grafana" },
  "answerWith": "{\"allow\": true} or {\"allow\": false, \"message\": \"<why, or what to do instead>\"}" }

// question: Claude used AskUserQuestion
{ "id": "p_sunzdduz", "kind": "question",
  "text": "Which color do you prefer? Options: Red; Blue.",
  "questions": [{ "question": "Which color do you prefer?", "header": "Color", "multiSelect": false,
                  "options": [{ "label": "Red", "description": "" }, { "label": "Blue", "description": "" }] }],
  "answerWith": "{\"answers\": [\"<option label or free text>\", ...one per question]} or {\"text\": \"<free reply>\"} or {\"allow\": false, \"message\": \"<why>\"}" }
```

Answer with `POST /prompts/:id`:

| Kind | Body |
|---|---|
| permission | `{"allow": true}`, or `{"allow": false, "message": "only clear the cache"}`. Claude reads the message |
| question | `{"answers": ["Blue"]}`: one entry per question, an option label or free text (a list of strings for multi-select). Or `{"text": "whatever you think is best"}`. Or `{"allow": false, "message": "…"}` to decline |

A prompt nobody answers is declined after `PROMPT_TIMEOUT_MINUTES` with "No answer from the user…". Claude then finishes the turn and says what it needed. Stopping or interrupting a session declines its open prompts.

Which tool calls become prompts depends on the session's `permissionMode` and on Claude Code's settings (`~/.claude/settings.json` in the home volume, and `.claude/settings.json` in the project). Pre-approve safe commands there, for example `"allow": ["Bash(docker ps:*)", "Bash(df:*)"]`, so that only real decisions reach the user. `plan` is read-only. `bypassPermissions` asks nothing and needs `ALLOW_BYPASS_PERMISSIONS=true`.

By default Claude is told that it runs headless behind a voice assistant. It asks one short question at a time with 2–3 options that are easy to say aloud, and it ends each turn with a summary whose first sentence can be read out. Replace these instructions with `SYSTEM_PROMPT_APPEND`.

### Webhook

With `WEBHOOK_URL` set, the runner POSTs `{event, session, prompt?}` (with `Authorization: Bearer <WEBHOOK_TOKEN>` if set):

| event | When |
|---|---|
| `prompt` | Claude asked something. `prompt` is the new prompt |
| `turn_done` | A turn finished. `session.lastResult` has the answer |
| `failed` | Claude Code crashed. `session.error` says why |

Delivery is retried 3 times (1 s, 5 s, 20 s) and never blocks Claude. Everything is also available by polling, so the webhook is optional.

### Example

```bash
T="Authorization: Bearer $API_TOKEN"; U=http://localhost:8064
curl -s -H "$T" $U/projects
S=$(curl -s -H "$T" -H 'content-type: application/json' $U/sessions \
      -d '{"project":"homelab","prompt":"Check disk space on this host and summarise it in one sentence."}' | jq -r .id)
curl -s -H "$T" "$U/sessions/$S/events?after=0&wait=30" | jq '.events[] | "\(.type): \(.text)"'
curl -s -H "$T" $U/prompts | jq '.[] | {id, text}'
curl -s -H "$T" -H 'content-type: application/json' $U/prompts/p_xxxxxxxx -d '{"allow": true}'
curl -s -H "$T" $U/sessions/$S | jq '{status, lastResult}'
curl -s -H "$T" -H 'content-type: application/json' $U/sessions/$S/messages -d '{"text":"And on servarr?"}'
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `API_TOKEN` | required | Bearer token for the API (16+ characters). It isn't passed to Claude |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address inside the container (compose maps `APP_PORT` to it) |
| `WORKSPACE_ROOT` | `/opt/workspace` | Sessions run here or in a folder below it |
| `DATA_DIR` | `~/.claude-code-runner` | `sessions.json` (the session list and resume ids) |
| `MAX_ACTIVE_SESSIONS` | `3` | Sessions with a live Claude process (running or waiting). More gives `429 TOO_MANY_ACTIVE` |
| `PROMPT_TIMEOUT_MINUTES` | `120` | Unanswered prompts are declined after this |
| `PERMISSION_MODE` | `default` | Default for new sessions: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` |
| `ALLOW_BYPASS_PERMISSIONS` | `false` | Must be `true` to allow `bypassPermissions` |
| `DEFAULT_MODEL`, `MAX_TURNS`, `MAX_BUDGET_USD` | unset | Per-session defaults. A request can override them |
| `SYSTEM_PROMPT_APPEND` | voice-friendly text | Appended to Claude Code's system prompt |
| `WEBHOOK_URL`, `WEBHOOK_TOKEN` | unset | See [Webhook](#webhook) |
| `CLAUDE_PATH` | bundled binary | Use another `claude` executable |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | unset | Claude login (or `/login` once in the container) |
| `GH_TOKEN`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*` | unset | GitHub access and commit identity for Claude |

Compose-only settings: `APP_PORT` (8064), `DOCKER_GID` (`stat -c %g /var/run/docker.sock` on the host), `WORKSPACE_DIR` (the host folder mounted at `/opt/workspace`), `HOME_DIR` (`./home`), `CONTAINER_NAME`.

Claude Code reads its own settings, `CLAUDE.md`, skills and MCP servers from the home volume (`./home/.claude/`) and from each project, as it does on a workstation. Put your homelab notes in `./home/.claude/CLAUDE.md`.

## Behaviour worth knowing

- **One message, one result.** While a turn runs, new messages wait. Together they become the next turn, in the same process. `interrupt: true` stops the current turn first.
- **Restarts.** `sessions.json` keeps the session list and Claude's resume ids. A turn that was running when the runner stopped comes back as `idle` with a note in `error`; send a message to continue. Open prompts and the event log are kept in memory only.
- **Events** keep the last 300 entries per session.
- **Cost** is Claude Code's estimate (`total_cost_usd`), cumulative for the session.
- **Docker from inside.** The socket belongs to the host, so bind-mount paths in `docker run -v` or compose files are host paths. Mount the workspace at the same path your other tools use. For example, with `/home/you` mounted at `/opt/workspace`, a compose file under `/opt/workspace/x` that uses `./data` resolves on the host as `/opt/workspace/x/data`, which doesn't exist there. Use absolute host paths in such projects.

## Security

- Whoever holds `API_TOKEN` can make Claude do anything Claude can do. **The Docker socket is root on the host.** Keep the port on your LAN or behind an authenticating proxy, and never publish it without one.
- The API token and webhook token are removed from the environment Claude Code gets.
- Claude reads logs, web pages and repositories, and any of them can contain text that tries to steer it. Keep `PERMISSION_MODE=default` (or `plan` for read-only work), pre-approve only safe commands, and let a human answer anything that changes things.
- `.env` and `home/` hold credentials. Both are gitignored and dockerignored.

## Development

```bash
npm install
npm test            # node:test, a fake query() stands in for Claude (no network, no cost)
npm run typecheck
API_TOKEN=dev-token-1234567890 WORKSPACE_ROOT=~/projects npm run dev   # uses your local Claude login
```

Code: `src/server.ts` (HTTP and routes), `src/sessions.ts` (sessions, streaming input, prompts, persistence), `src/prompts.ts` (prompt text and answers), `src/projects.ts` (folder resolution), `src/webhook.ts`, `src/config.ts`.

Dependencies: `@anthropic-ai/claude-agent-sdk` (runtime). Dev only: `typescript`, `@types/node`.

## License

MIT
