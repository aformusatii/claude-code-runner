import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CanUseTool, PermissionMode, PermissionResult, query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { childEnv, type Config } from './config.ts';
import { AnswerError, buildPrompt, clip, describeTool, type Prompt, type PromptAnswer, toPermissionResult } from './prompts.ts';

export type QueryFn = typeof query;

/**
 * running  Claude is working.
 * waiting  Claude asked something (see `prompts`) and waits for POST /prompts/:id.
 * idle     The turn is done; send a message to continue the same conversation.
 * stopped  Stopped by the user; send a message to continue.
 * failed   Claude Code crashed or could not start (see `error`); send a message to retry.
 */
export type SessionStatus = 'running' | 'waiting' | 'idle' | 'stopped' | 'failed';

export type SessionEvent = {
  seq: number;
  at: string;
  type: 'message' | 'assistant' | 'tool' | 'prompt' | 'answer' | 'result' | 'error';
  text: string;
};

export type TurnResult = { ok: boolean; text: string; at: string };

export type SessionOptions = {
  permissionMode: PermissionMode;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
};

/** What the API returns for a session. Also what sessions.json stores (minus prompts). */
export type SessionView = {
  id: string;
  project: string;
  cwd: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  options: SessionOptions;
  /** Claude Code's own session id (resume key); null until the first turn starts. */
  claudeSessionId: string | null;
  /** Questions and permission requests waiting for an answer. */
  prompts: Prompt[];
  /** Messages sent while Claude was busy; they run after the current turn. */
  queuedMessages: number;
  /** Claude's latest text, useful as progress while it works. */
  lastText: string | null;
  /** The answer of the last finished turn. */
  lastResult: TurnResult | null;
  costUsd: number;
  error: string | null;
};

export type Notify = (event: 'prompt' | 'turn_done' | 'failed', session: SessionView, prompt?: Prompt) => void;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_EVENTS = 300;

type PendingPrompt = { view: Prompt; input: Record<string, unknown>; finish: (result: PermissionResult) => void };

type SessionDeps = { config: Config; query: QueryFn; notify: Notify; changed: () => void };

/**
 * One Claude Code conversation in one folder.
 *
 * While a turn runs, a Claude Code process reads user messages from an async
 * generator (streaming input). The generator hands over ONE message, waits
 * for that turn's result, then hands over whatever was queued meanwhile, so
 * every message gets exactly one result. When nothing is queued it ends,
 * the process exits, and the next message starts a new process that resumes
 * the conversation by its Claude session id. Idle sessions cost nothing.
 */
export class Session {
  private readonly deps: SessionDeps;
  private view: Omit<SessionView, 'prompts' | 'queuedMessages'>;
  private readonly queue: string[] = [];
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly events: SessionEvent[] = [];
  private seq = 0;
  private readonly eventWaiters = new Set<() => void>();
  private abort: AbortController | null = null;
  private live: ReturnType<QueryFn> | null = null;
  private turnDone: (() => void) | null = null;
  /** A message was handed to Claude and its result has not arrived yet. */
  private awaitingResult = false;

  constructor(deps: SessionDeps, view: Omit<SessionView, 'prompts' | 'queuedMessages'>) {
    this.deps = deps;
    this.view = view;
  }

  get id(): string {
    return this.view.id;
  }

  /** A Claude Code process is alive (running or waiting). */
  get active(): boolean {
    return this.abort !== null;
  }

  toView(): SessionView {
    return { ...this.view, prompts: [...this.pending.values()].map((p) => p.view), queuedMessages: this.queue.length };
  }

  /** Persisted form: no prompts (they die with the process). */
  toRecord(): Omit<SessionView, 'prompts' | 'queuedMessages'> {
    return { ...this.view };
  }

  /** Queues a message and starts Claude if it is not running. Returns true when it had to wait. */
  async send(text: string, interrupt = false): Promise<boolean> {
    this.queue.push(text);
    this.log('message', text);
    if (!this.active) {
      this.start();
      return false;
    }
    // Between a result and the process exiting the status already says idle; the message will run.
    if (this.view.status === 'idle') this.setStatus('running');
    if (interrupt && this.live) {
      this.denyAll('The user interrupted you with a new message.');
      await this.live.interrupt().catch(() => undefined);
    }
    return true;
  }

  stop(): void {
    this.queue.length = 0;
    this.denyAll('The user stopped the session.');
    this.abort?.abort();
  }

  /** Answers one of this session's prompts. Throws AnswerError on a bad body. */
  answer(promptId: string, answer: PromptAnswer): void {
    const pending = this.pending.get(promptId);
    if (!pending) throw new ApiError(404, 'PROMPT_NOT_FOUND', `No pending prompt ${promptId}`);
    const result = toPermissionResult(pending.view, pending.input, answer);
    this.log('answer', result.behavior === 'allow' ? `answered: ${JSON.stringify(answer)}` : `declined: ${result.message}`);
    pending.finish(result);
  }

  hasPrompt(promptId: string): boolean {
    return this.pending.has(promptId);
  }

  /** Events after `after`; waits up to `waitMs` for new ones when there are none yet. */
  async eventsAfter(after: number, waitMs: number, signal?: AbortSignal): Promise<SessionEvent[]> {
    const newer = () => this.events.filter((e) => e.seq > after);
    if (newer().length > 0 || waitMs <= 0) return newer();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.eventWaiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      this.eventWaiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    return newer();
  }

  // --- running Claude Code ---------------------------------------------------------

  private start(): void {
    const abort = new AbortController();
    this.abort = abort;
    this.awaitingResult = true;
    this.view.error = null;
    this.setStatus('running');
    void this.run(abort);
  }

  private async run(abort: AbortController): Promise<void> {
    const { config } = this.deps;
    let failure: string | null = null;
    try {
      const live = this.deps.query({
        prompt: this.input(abort.signal),
        options: {
          cwd: this.view.cwd,
          abortController: abort,
          ...(this.view.claudeSessionId ? { resume: this.view.claudeSessionId } : {}),
          canUseTool: this.canUseTool,
          permissionMode: this.view.options.permissionMode,
          allowDangerouslySkipPermissions: this.view.options.permissionMode === 'bypassPermissions',
          ...(this.view.options.model ? { model: this.view.options.model } : {}),
          ...(this.view.options.maxTurns ? { maxTurns: this.view.options.maxTurns } : {}),
          ...(this.view.options.maxBudgetUsd ? { maxBudgetUsd: this.view.options.maxBudgetUsd } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: config.systemPromptAppend },
          settingSources: ['user', 'project', 'local'],
          env: childEnv(),
          ...(config.claudePath ? { pathToClaudeCodeExecutable: config.claudePath } : {}),
        },
      });
      this.live = live;
      for await (const message of live) this.handle(message);
    } catch (error) {
      // The SDK also throws right after an error result (not logged in, max turns, budget).
      // That turn already ended with lastResult.ok=false; only a crash without a result is a failure.
      if (!abort.signal.aborted && this.awaitingResult) failure = error instanceof Error ? error.message : String(error);
    }

    this.live = null;
    this.abort = null;
    this.turnDone?.();
    this.turnDone = null;
    this.denyAll('The session ended.');

    if (abort.signal.aborted) {
      this.setStatus('stopped');
    } else if (failure) {
      this.view.error = clip(failure, 1000);
      this.log('error', this.view.error);
      this.setStatus('failed');
      this.deps.notify('failed', this.toView());
    } else if (this.queue.length > 0) {
      this.start(); // messages that arrived while the process was exiting
    } else {
      this.setStatus('idle');
    }
  }

  /** Streaming input: one message per turn, see the class comment. */
  private async *input(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
    while (!signal.aborted && this.queue.length > 0) {
      const text = this.queue.splice(0).join('\n\n');
      const turn = new Promise<void>((resolve) => {
        this.turnDone = resolve;
      });
      this.awaitingResult = true;
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
      await turn;
    }
  }

  private handle(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.view.claudeSessionId = message.session_id;
      this.touch();
    } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          this.view.lastText = clip(block.text, 2000);
          this.log('assistant', block.text);
        } else if (block.type === 'tool_use') {
          this.log('tool', describeTool(block.name, (block.input ?? {}) as Record<string, unknown>));
        }
      }
      this.touch();
    } else if (message.type === 'result') {
      const ok = message.subtype === 'success' && !message.is_error;
      const text =
        message.subtype === 'success' ? message.result : message.errors?.join('; ') || message.subtype.replaceAll('_', ' ');
      this.view.lastResult = { ok, text, at: new Date().toISOString() };
      // Cumulative for the call, and includes earlier spend when the call resumed a session.
      if (message.total_cost_usd > this.view.costUsd) this.view.costUsd = message.total_cost_usd;
      this.log('result', `${ok ? 'done' : 'failed'}: ${text}`);
      const done = this.turnDone;
      this.turnDone = null;
      this.awaitingResult = false;
      if (this.queue.length === 0) this.setStatus('idle');
      this.deps.notify('turn_done', this.toView());
      done?.();
    }
  }

  /** Every permission prompt and AskUserQuestion lands here and waits for POST /prompts/:id. */
  private readonly canUseTool: CanUseTool = (toolName, input, { signal, decisionReason }) =>
    new Promise<PermissionResult>((resolve) => {
      const view = buildPrompt(
        { id: newId('p'), sessionId: this.view.id, project: this.view.project },
        toolName,
        input,
        decisionReason,
      );
      const minutes = Math.round(this.deps.config.promptTimeoutMs / 60_000);
      const timer = setTimeout(
        () => {
          this.log('answer', 'no answer in time, declined');
          finish({
            behavior: 'deny',
            message: `No answer from the user within ${minutes} minutes. Do not do this; finish the turn and say what you need.`,
          });
        },
        this.deps.config.promptTimeoutMs,
      );
      const onAbort = () => finish({ behavior: 'deny', message: 'Cancelled.' });
      const finish = (result: PermissionResult) => {
        if (!this.pending.delete(view.id)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
        if (this.active && this.pending.size === 0) this.setStatus('running');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(view.id, { view, input, finish });
      this.log('prompt', view.text);
      this.setStatus('waiting');
      this.deps.notify('prompt', this.toView(), view);
    });

  private denyAll(message: string): void {
    for (const p of [...this.pending.values()]) p.finish({ behavior: 'deny', message });
  }

  // --- bookkeeping -------------------------------------------------------------------

  private setStatus(status: SessionStatus): void {
    this.view.status = status;
    this.touch();
  }

  private touch(): void {
    this.view.updatedAt = new Date().toISOString();
    this.deps.changed();
  }

  private log(type: SessionEvent['type'], text: string): void {
    this.events.push({ seq: ++this.seq, at: new Date().toISOString(), type, text: clip(text, 2000) });
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const wake of [...this.eventWaiters]) wake();
  }
}

export type CreateSession = { prompt: string; project: string; cwd: string } & Partial<SessionOptions>;

/** All sessions, the active-session limit, prompt lookup and sessions.json. */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly config: Config;
  private readonly deps: SessionDeps;
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(config: Config, queryFn: QueryFn, notify: Notify) {
    this.config = config;
    this.file = path.join(config.dataDir, 'sessions.json');
    this.deps = { config, query: queryFn, notify, changed: () => this.scheduleSave() };
    this.load();
  }

  async create(input: CreateSession): Promise<Session> {
    this.ensureCapacity();
    const permissionMode = input.permissionMode ?? this.config.permissionMode;
    if (permissionMode === 'bypassPermissions' && !this.config.allowBypassPermissions) {
      throw new ApiError(400, 'BYPASS_NOT_ALLOWED', 'bypassPermissions is disabled (ALLOW_BYPASS_PERMISSIONS)');
    }
    const now = new Date().toISOString();
    const options: SessionOptions = {
      permissionMode,
      ...pick('model', input.model ?? this.config.model),
      ...pick('maxTurns', input.maxTurns ?? this.config.maxTurns),
      ...pick('maxBudgetUsd', input.maxBudgetUsd ?? this.config.maxBudgetUsd),
    };
    const session = new Session(this.deps, {
      id: newId('s'),
      project: input.project,
      cwd: input.cwd,
      title: clip(input.prompt, 80),
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      options,
      claudeSessionId: null,
      lastText: null,
      lastResult: null,
      costUsd: 0,
      error: null,
    });
    this.sessions.set(session.id, session);
    await session.send(input.prompt);
    return session;
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', `No session ${id}`);
    return session;
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => s.toView()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async send(id: string, text: string, interrupt: boolean): Promise<{ session: Session; queued: boolean }> {
    const session = this.get(id);
    if (!session.active) this.ensureCapacity();
    const queued = await session.send(text, interrupt);
    return { session, queued };
  }

  prompts(): Prompt[] {
    return this.list()
      .flatMap((s) => s.prompts)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  answer(promptId: string, answer: PromptAnswer): Session {
    const session = [...this.sessions.values()].find((s) => s.hasPrompt(promptId));
    if (!session) throw new ApiError(404, 'PROMPT_NOT_FOUND', `No pending prompt ${promptId} (already answered or timed out?)`);
    try {
      session.answer(promptId, answer);
    } catch (error) {
      if (error instanceof AnswerError) throw new ApiError(400, 'BAD_ANSWER', error.message);
      throw error;
    }
    return session;
  }

  remove(id: string): void {
    this.get(id).stop();
    this.sessions.delete(id);
    this.scheduleSave();
  }

  get activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.active).length;
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.stop();
    this.saveNow();
  }

  private ensureCapacity(): void {
    if (this.activeCount >= this.config.maxActiveSessions) {
      throw new ApiError(
        429,
        'TOO_MANY_ACTIVE',
        `${this.activeCount} sessions are already running or waiting (MAX_ACTIVE_SESSIONS). Answer, stop or wait for one.`,
      );
    }
  }

  // sessions.json keeps the list (and resume ids) across restarts; events and prompts are memory only.
  private load(): void {
    let records: Omit<SessionView, 'prompts' | 'queuedMessages'>[] = [];
    try {
      records = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`sessions.json unreadable, starting empty: ${error}`);
    }
    for (const record of records) {
      if (record.status === 'running' || record.status === 'waiting') {
        record.status = 'idle';
        record.error = 'The runner restarted during this turn. Send a message to continue.';
      }
      this.sessions.set(record.id, new Session(this.deps, record));
    }
  }

  private scheduleSave(): void {
    this.saveTimer ??= setTimeout(() => this.saveNow(), 200);
  }

  private saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const records = [...this.sessions.values()]
      .map((s) => s.toRecord())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 500);
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

/** Short ids that an LLM can repeat back without mistakes: s_k3x9q2mw. */
function newId(prefix: string): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return `${prefix}_${[...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

function pick<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
