# AGENTS.md

claude-code-runner: an HTTP API (plain `node:http`) that runs Claude Code
sessions through `@anthropic-ai/claude-agent-sdk` and turns Claude's
questions and permission requests into prompts that callers answer. See
README.md for the API and the behaviour.

## Commands

| Command | What it does |
|---|---|
| `npm test` | node:test suite. A fake `query()` (test/helpers.ts) stands in for the SDK: no network, no cost |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev` | Local server with `--watch` (needs `API_TOKEN`, uses your local Claude login) |
| `docker compose up -d --build` | Build and run the container (needs `.env`, see `.env.example`) |

Before calling a change done: `npm run typecheck && npm test`. After
Dockerfile changes: build the image and check `claude --version`, `gh
--version` and `docker ps` inside it as uid 1000.

## Layout

- `src/server.ts`: routes, auth, JSON helpers, `GET /` self-description, entry point
- `src/sessions.ts`: `Session` (one conversation; streaming input; `canUseTool` → prompts) and `SessionManager` (limit, lookup, `sessions.json`)
- `src/prompts.ts`: prompt text for a tool call or `AskUserQuestion`, answer → `PermissionResult`
- `src/projects.ts`: project name → folder inside `WORKSPACE_ROOT` (no escapes)
- `src/webhook.ts`, `src/config.ts`

## Invariants

- One user message is handed to Claude per turn; the next one only after
  that turn's `result` (see the `Session` comment). Don't push messages into
  a running turn: results could no longer be matched to messages.
- Every `canUseTool` promise must settle: answer, timeout, abort, stop or
  interrupt. A prompt that never settles blocks the session forever.
- An error result followed by an SDK throw is the end of a turn
  (`idle`, `lastResult.ok=false`), not `failed`.
- `API_TOKEN` and `WEBHOOK_TOKEN` never reach Claude's environment (`childEnv`).
- Project paths never resolve outside `WORKSPACE_ROOT` (realpath check).

## Conventions

- Keep it small: no web framework, no validation library, one runtime dependency.
  Ask before adding a dependency.
- TypeScript that Node can strip (no `enum`, `namespace`, parameter
  properties); `import type`; `.ts` extensions in imports.
- Comments explain why.
- Errors: throw `ApiError(status, CODE, message)`; the message should tell an
  agent what to do next.
- Never commit `.env` or `home/`.
