import os from 'node:os';
import path from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;

export type Config = {
  port: number;
  host: string;
  /** Every request except GET / and GET /health needs `Authorization: Bearer <apiToken>`. */
  apiToken: string;
  /** Sessions run in this folder or in a project folder below it, never outside. */
  workspaceRoot: string;
  /** sessions.json lives here. */
  dataDir: string;
  /** Sessions with a live Claude Code process (running or waiting for an answer). */
  maxActiveSessions: number;
  /** An unanswered prompt is denied after this long, so a session never hangs forever. */
  promptTimeoutMs: number;
  permissionMode: PermissionMode;
  allowBypassPermissions: boolean;
  model: string | undefined;
  maxTurns: number | undefined;
  maxBudgetUsd: number | undefined;
  systemPromptAppend: string;
  webhookUrl: string | undefined;
  webhookToken: string | undefined;
  /** Optional: a separately installed `claude` instead of the binary bundled with the SDK. */
  claudePath: string | undefined;
};

const DEFAULT_SYSTEM_PROMPT_APPEND = [
  'You run headless inside claude-code-runner. A person reaches you through another assistant,',
  'often by voice on a smart speaker, and cannot see your terminal or files.',
  'When you need a decision, use the AskUserQuestion tool: one short question with 2-3 short options',
  'that are easy to say aloud. Do not ask for anything you can find out yourself.',
  'End every turn with a short plain-text summary. Its first sentence must work when read aloud:',
  'no markdown, no code, no long paths.',
].join(' ');

/** Reads and validates the environment. Throws with every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const int = (name: string, fallback: number | undefined, min = 1): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) problems.push(`${name} must be an integer >= ${min}`);
    return value;
  };
  const num = (name: string): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) problems.push(`${name} must be a positive number`);
    return value;
  };
  const opt = (name: string): string | undefined => env[name]?.trim() || undefined;

  const apiToken = opt('API_TOKEN') ?? '';
  // The API drives an agent that has the Docker socket: it must never be open.
  if (apiToken.length < 16) problems.push('API_TOKEN is required (at least 16 characters)');

  const permissionMode = (opt('PERMISSION_MODE') ?? 'default') as PermissionMode;
  if (!PERMISSION_MODES.includes(permissionMode as (typeof PERMISSION_MODES)[number])) {
    problems.push(`PERMISSION_MODE must be one of ${PERMISSION_MODES.join(', ')}`);
  }
  const allowBypassPermissions = opt('ALLOW_BYPASS_PERMISSIONS') === 'true';
  if (permissionMode === 'bypassPermissions' && !allowBypassPermissions) {
    problems.push('PERMISSION_MODE=bypassPermissions needs ALLOW_BYPASS_PERMISSIONS=true');
  }

  const webhookUrl = opt('WEBHOOK_URL');
  if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) problems.push('WEBHOOK_URL must be an http(s) URL');

  const config: Config = {
    port: int('PORT', 3000) ?? 3000,
    host: opt('HOST') ?? '0.0.0.0',
    apiToken,
    workspaceRoot: path.resolve(opt('WORKSPACE_ROOT') ?? process.cwd()),
    dataDir: path.resolve(opt('DATA_DIR') ?? path.join(os.homedir(), '.claude-code-runner')),
    maxActiveSessions: int('MAX_ACTIVE_SESSIONS', 3) ?? 3,
    promptTimeoutMs: (int('PROMPT_TIMEOUT_MINUTES', 120) ?? 120) * 60_000,
    permissionMode,
    allowBypassPermissions,
    model: opt('DEFAULT_MODEL'),
    maxTurns: int('MAX_TURNS', undefined),
    maxBudgetUsd: num('MAX_BUDGET_USD'),
    systemPromptAppend: opt('SYSTEM_PROMPT_APPEND') ?? DEFAULT_SYSTEM_PROMPT_APPEND,
    webhookUrl,
    webhookToken: opt('WEBHOOK_TOKEN'),
    claudePath: opt('CLAUDE_PATH'),
  };

  if (problems.length > 0) throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  return config;
}

/**
 * The environment Claude Code gets: ours minus the runner's own secrets, so
 * the agent cannot read the API token with `env` and drive itself.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const { API_TOKEN: _a, WEBHOOK_TOKEN: _w, ...rest } = env;
  return rest;
}
