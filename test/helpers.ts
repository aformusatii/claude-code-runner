import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { type Notify, type QueryFn, SessionManager } from '../src/sessions.ts';

export const TOKEN = 'test-token-0123456789';

export type Ask = (tool: string, input: Record<string, unknown>) => Promise<PermissionResult>;
/** What the fake Claude does with one user message; returns its reply text. */
export type TurnScript = (text: string, ctx: { ask: Ask; options: Options; turn: number }) => Promise<string>;

/**
 * A stand-in for the SDK's query(): reads the streaming input like the real
 * CLI, calls canUseTool for permissions/questions, emits init/assistant/
 * result messages, honours interrupt() and the abort controller.
 */
export function fakeQuery(script: TurnScript, opts: { throwOnStart?: string; errorResult?: string } = {}) {
  const calls: Options[] = [];
  const stats = { interrupts: 0 };
  const fn = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    calls.push(options);
    if (opts.throwOnStart) throw new Error(opts.throwOnStart);
    const signal = options.abortController!.signal;
    const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    aborted.catch(() => {});
    let interrupt: (() => void) | null = null;
    let turn = 0;
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: options.resume ?? `claude-${calls.length}` };
      for await (const m of prompt) {
        if (opts.errorResult) {
          // What the real SDK does: an error result, then the iterator throws.
          yield { type: 'result', subtype: 'success', is_error: true, result: opts.errorResult, total_cost_usd: 0 };
          throw new Error(`Claude Code returned an error result: ${opts.errorResult}`);
        }
        const text = m.message.content as string;
        const ask: Ask = (tool, input) =>
          options.canUseTool!(tool, input, { signal, toolUseID: 'tu', requestId: 'rq' }) as Promise<PermissionResult>;
        const interrupted = new Promise<null>((r) => {
          interrupt = () => r(null);
        });
        const reply = await Promise.race([script(text, { ask, options, turn: ++turn }), interrupted, aborted]);
        if (reply === null) {
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], total_cost_usd: 0.01 };
          continue;
        }
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: reply }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0.01 * turn };
      }
    }
    return Object.assign(run(), {
      interrupt: async () => {
        stats.interrupts++;
        interrupt?.();
      },
    });
  }) as unknown as QueryFn;
  return { fn, calls, stats };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-test-'));
  const workspaceRoot = path.join(base, 'workspace');
  fs.mkdirSync(path.join(workspaceRoot, 'EchoDotClientV1', '.git'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'homelab'), { recursive: true });
  return {
    port: 0,
    host: '127.0.0.1',
    apiToken: TOKEN,
    workspaceRoot,
    dataDir: path.join(base, 'data'),
    maxActiveSessions: 3,
    promptTimeoutMs: 60_000,
    permissionMode: 'default',
    allowBypassPermissions: false,
    model: undefined,
    maxTurns: undefined,
    maxBudgetUsd: undefined,
    systemPromptAppend: 'test',
    webhookUrl: undefined,
    webhookToken: undefined,
    claudePath: undefined,
    ...overrides,
  };
}

export type Notification = Parameters<Notify>;

/** Starts the HTTP app on a free port. `api()` sends authorised JSON requests. */
export async function startApp(script: TurnScript, configOverrides: Partial<Config> = {}, queryOpts = {}) {
  const config = testConfig(configOverrides);
  const fake = fakeQuery(script, queryOpts);
  const notifications: Notification[] = [];
  const manager = new SessionManager(config, fake.fn, (...args) => notifications.push(args));
  const server = http.createServer(createApp(config, manager));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api = async (method: string, route: string, body?: unknown, token: string | null = TOKEN) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const close = async () => {
    manager.stopAll();
    await new Promise((r) => server.close(r));
  };
  return { api, config, manager, fake, notifications, close };
}

export async function waitFor<T>(check: () => Promise<T | undefined | false> | T | undefined | false, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A promise you resolve from the test, to hold a fake turn open. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}
