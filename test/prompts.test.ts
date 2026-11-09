import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { buildPrompt, describeTool, toPermissionResult } from '../src/prompts.ts';

const base = { id: 'p_1', sessionId: 's_1', project: 'x' };

test('describeTool gives a short readable action', () => {
  assert.equal(describeTool('Bash', { command: 'df -h' }), 'run: df -h');
  assert.equal(describeTool('Edit', { file_path: '/a/b.ts' }), 'edit /a/b.ts');
  assert.equal(describeTool('Write', { file_path: '/a/c.ts' }), 'write /a/c.ts');
  assert.equal(describeTool('WebFetch', { url: 'http://x' }), 'fetch http://x');
  assert.match(describeTool('mcp__grafana__query', { q: 'up' }), /^use mcp__grafana__query \{"q":"up"\}$/);
});

test('multi-select answers are joined; free text goes in "response"', () => {
  const input = {
    questions: [{ question: 'Which hosts?', header: 'Hosts', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }],
  };
  const prompt = buildPrompt(base, 'AskUserQuestion', input, undefined);
  assert.deepEqual(toPermissionResult(prompt, input, { answers: [['a', 'b']] }), {
    behavior: 'allow',
    updatedInput: { ...input, answers: { 'Which hosts?': 'a, b' } },
  });
  assert.deepEqual(toPermissionResult(prompt, input, { text: 'all of them' }), {
    behavior: 'allow',
    updatedInput: { ...input, response: 'all of them' },
  });
  assert.deepEqual(toPermissionResult(prompt, input, { allow: false }), { behavior: 'deny', message: 'The user declined.' });
  assert.throws(() => toPermissionResult(prompt, input, { answers: [''] }), /non-empty/);
});

test('config refuses to start without a real API token or with an unsafe mode', () => {
  assert.throws(() => loadConfig({}), /API_TOKEN is required/);
  assert.throws(
    () => loadConfig({ API_TOKEN: 'x'.repeat(20), PERMISSION_MODE: 'bypassPermissions' }),
    /ALLOW_BYPASS_PERMISSIONS/,
  );
  const config = loadConfig({ API_TOKEN: 'x'.repeat(20), PROMPT_TIMEOUT_MINUTES: '5', MAX_BUDGET_USD: '2.5' });
  assert.equal(config.promptTimeoutMs, 300_000);
  assert.equal(config.maxBudgetUsd, 2.5);
});
