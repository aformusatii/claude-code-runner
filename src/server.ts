import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { type Config, loadConfig, PERMISSION_MODES } from './config.ts';
import { listProjects, resolveProject } from './projects.ts';
import type { PromptAnswer } from './prompts.ts';
import { ApiError, SessionManager, type SessionOptions } from './sessions.ts';
import { webhookNotifier } from './webhook.ts';

/** Self-description at GET /, so an agent can learn the API without the README. */
const OVERVIEW = {
  name: 'claude-code-runner',
  about:
    'Runs Claude Code sessions in project folders. Start a session with a prompt, then poll it (or receive webhooks). ' +
    'When Claude asks a question or wants permission, the session status is "waiting" and the prompt is listed; answer it to let Claude continue.',
  auth: 'Authorization: Bearer <API_TOKEN> on every endpoint except GET / and GET /health',
  endpoints: [
    ['GET /projects', 'Folders Claude can work in. Use a name as "project".'],
    [
      'POST /sessions',
      '{"prompt": "...", "project"?: "name", "permissionMode"?: "default|acceptEdits|plan|auto|dontAsk", "model"?, "maxTurns"?, "maxBudgetUsd"?} → the session (201)',
    ],
    ['GET /sessions', 'All sessions, newest first. ?status=running|waiting|idle|stopped|failed'],
    ['GET /sessions/:id', 'Status, pending prompts, lastText (progress), lastResult (the answer of the finished turn).'],
    ['GET /sessions/:id/events', '?after=<seq>&wait=<seconds, max 60> → what Claude did (long-poll).'],
    ['POST /sessions/:id/messages', '{"text": "...", "interrupt"?: true} → continue the conversation; queued if Claude is busy.'],
    ['POST /sessions/:id/stop', 'Stop the running turn; the conversation can be continued later.'],
    ['DELETE /sessions/:id', 'Stop and forget the session.'],
    ['GET /prompts', 'Every pending question / permission request, oldest first.'],
    ['POST /prompts/:id', 'Answer it. Each prompt says how in "answerWith".'],
  ].map(([route, does]) => ({ route, does })),
  statuses: {
    running: 'Claude is working',
    waiting: 'Claude waits for an answer to a prompt',
    idle: 'turn finished, read lastResult; send a message to continue',
    stopped: 'stopped by a user',
    failed: 'Claude Code crashed or could not start, see error',
  },
};

const MAX_BODY_BYTES = 1_000_000;

type Route = {
  method: string;
  pattern: RegExp;
  handler: (ctx: { params: string[]; body: Record<string, unknown>; url: URL; signal: AbortSignal }) => Promise<[number, unknown]>;
};

export function createApp(config: Config, manager: SessionManager): http.RequestListener {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/$/, handler: async () => [200, OVERVIEW] },
    {
      method: 'GET',
      pattern: /^\/health$/,
      handler: async () => [200, { ok: true, activeSessions: manager.activeCount, maxActiveSessions: config.maxActiveSessions }],
    },
    { method: 'GET', pattern: /^\/projects$/, handler: async () => [200, await listProjects(config.workspaceRoot)] },
    {
      method: 'POST',
      pattern: /^\/sessions$/,
      handler: async ({ body }) => {
        const prompt = requiredString(body, 'prompt');
        const { project, cwd } = await resolveProject(config.workspaceRoot, optionalString(body, 'project'));
        const session = await manager.create({ prompt, project, cwd, ...sessionOptions(body) });
        return [201, session.toView()];
      },
    },
    {
      method: 'GET',
      pattern: /^\/sessions$/,
      handler: async ({ url }) => {
        const status = url.searchParams.get('status');
        return [200, manager.list().filter((s) => !status || s.status === status)];
      },
    },
    { method: 'GET', pattern: /^\/sessions\/([\w-]+)$/, handler: async ({ params }) => [200, manager.get(params[0]!).toView()] },
    {
      method: 'GET',
      pattern: /^\/sessions\/([\w-]+)\/events$/,
      handler: async ({ params, url, signal }) => {
        const session = manager.get(params[0]!);
        const after = Number(url.searchParams.get('after') ?? 0) || 0;
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), 60);
        const events = await session.eventsAfter(after, wait * 1000, signal);
        return [200, { status: session.toView().status, events }];
      },
    },
    {
      method: 'POST',
      pattern: /^\/sessions\/([\w-]+)\/messages$/,
      handler: async ({ params, body }) => {
        const text = requiredString(body, 'text');
        if (body.interrupt !== undefined && typeof body.interrupt !== 'boolean') throw badRequest('"interrupt" must be a boolean');
        const { session, queued } = await manager.send(params[0]!, text, body.interrupt === true);
        return [202, { queued, session: session.toView() }];
      },
    },
    {
      method: 'POST',
      pattern: /^\/sessions\/([\w-]+)\/stop$/,
      handler: async ({ params }) => {
        const session = manager.get(params[0]!);
        session.stop();
        return [200, session.toView()];
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/sessions\/([\w-]+)$/,
      handler: async ({ params }) => {
        manager.remove(params[0]!);
        return [204, null];
      },
    },
    { method: 'GET', pattern: /^\/prompts$/, handler: async () => [200, manager.prompts()] },
    {
      method: 'POST',
      pattern: /^\/prompts\/([\w-]+)$/,
      handler: async ({ params, body }) => {
        const session = manager.answer(params[0]!, body as PromptAnswer);
        return [200, session.toView()];
      },
    },
  ];

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const matching = routes.filter((r) => r.pattern.test(url.pathname));
      if (matching.length === 0) throw new ApiError(404, 'NOT_FOUND', `No route ${url.pathname}. GET / lists the API.`);
      const route = matching.find((r) => r.method === req.method);
      if (!route) throw new ApiError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not supported on ${url.pathname}`);
      const open = url.pathname === '/' || url.pathname === '/health';
      if (!open && !authorized(req.headers.authorization, config.apiToken)) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Send Authorization: Bearer <API_TOKEN>');
      }
      const body = req.method === 'POST' ? await readJson(req) : {};
      const params = route.pattern.exec(url.pathname)!.slice(1);
      const [status, payload] = await route.handler({ params, body, url, signal: abort.signal });
      send(res, status, payload);
    } catch (error) {
      if (error instanceof ApiError) {
        send(res, error.status, { error: { code: error.code, message: error.message } });
      } else {
        console.error(error);
        send(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected error, see the runner log' } });
      }
    }
  };
}

function sessionOptions(body: Record<string, unknown>): Partial<SessionOptions> {
  const options: Partial<SessionOptions> = {};
  const mode = optionalString(body, 'permissionMode');
  if (mode !== undefined) {
    if (!PERMISSION_MODES.includes(mode as (typeof PERMISSION_MODES)[number])) {
      throw badRequest(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
    }
    options.permissionMode = mode as SessionOptions['permissionMode'];
  }
  const model = optionalString(body, 'model');
  if (model) options.model = model;
  for (const key of ['maxTurns', 'maxBudgetUsd'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !(value > 0) || (key === 'maxTurns' && !Number.isInteger(value))) {
      throw badRequest(`${key} must be a positive ${key === 'maxTurns' ? 'integer' : 'number'}`);
    }
    options[key] = value;
  }
  return options;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`"${key}" is required (a non-empty string)`);
  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`"${key}" must be a string`);
  return value.trim() || undefined;
}

function badRequest(message: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'TOO_LARGE', 'Body over 1 MB');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw badRequest('Body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function authorized(header: string | undefined, token: string): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // Compare hashes so the comparison takes the same time whatever the length.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(token).digest();
  return given.length > 0 && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  if (status === 204) {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(payload, null, 1));
}

if (import.meta.main) {
  const config = loadConfig();
  const manager = new SessionManager(config, query, webhookNotifier(config.webhookUrl, config.webhookToken));
  const server = http.createServer(createApp(config, manager));
  // Long-polls hold requests up to 60 s.
  server.requestTimeout = 90_000;
  server.listen(config.port, config.host, () => {
    console.log(`claude-code-runner on http://${config.host}:${config.port}, workspace ${config.workspaceRoot}`);
  });
  const shutdown = () => {
    console.log('shutting down: stopping sessions');
    manager.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
