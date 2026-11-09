import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { SessionManager } from '../src/sessions.ts';
import { fakeQuery, gate, startApp, testConfig, waitFor } from './helpers.ts';

const apps: { close: () => Promise<void> }[] = [];
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
});
async function app(...args: Parameters<typeof startApp>) {
  const started = await startApp(...args);
  apps.push(started);
  return started;
}

/** Polls GET /sessions/:id until the status matches. */
async function until(api: Awaited<ReturnType<typeof startApp>>['api'], id: string, status: string) {
  return waitFor(async () => {
    const { body } = await api('GET', `/sessions/${id}`);
    return body.status === status ? body : undefined;
  });
}

describe('auth and discovery', () => {
  test('GET / and /health are open, everything else needs the token', async () => {
    const { api } = await app(async () => 'hi');
    assert.equal((await api('GET', '/', undefined, null)).status, 200);
    assert.equal((await api('GET', '/health', undefined, null)).body.ok, true);
    assert.equal((await api('GET', '/sessions', undefined, null)).status, 401);
    assert.equal((await api('GET', '/sessions', undefined, 'wrong-token-xxxxxxxx')).status, 401);
    assert.equal((await api('GET', '/nope')).body.error.code, 'NOT_FOUND');
    assert.equal((await api('PUT', '/sessions')).status, 405);
  });

  test('GET /projects lists the folders under the workspace root', async () => {
    const { api } = await app(async () => 'hi');
    const { body } = await api('GET', '/projects');
    assert.deepEqual(
      body.map((p: { name: string; git: boolean }) => [p.name, p.git]),
      [
        ['EchoDotClientV1', true],
        ['homelab', false],
      ],
    );
  });
});

describe('a session', () => {
  test('runs a prompt in the project folder, then continues the same conversation', async () => {
    const { api, fake, notifications } = await app(async (text, { turn }) => `answer ${turn} to ${text}`);
    const created = await api('POST', '/sessions', { prompt: 'check disk space', project: 'echodotclientv1' });
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^s_[a-z2-9]{8}$/);
    assert.equal(created.body.project, 'EchoDotClientV1', 'case-insensitive project match');

    const idle = await until(api, created.body.id, 'idle');
    assert.equal(idle.lastResult.ok, true);
    assert.equal(idle.lastResult.text, 'answer 1 to check disk space');
    assert.equal(idle.claudeSessionId, 'claude-1');
    assert.equal(path.basename(fake.calls[0]!.cwd!), 'EchoDotClientV1');
    assert.equal(fake.calls[0]!.env!.API_TOKEN, undefined, "the runner's token is not passed to Claude");
    assert.equal(fake.calls[0]!.resume, undefined);
    assert.equal(notifications.at(-1)![0], 'turn_done');

    const sent = await api('POST', `/sessions/${created.body.id}/messages`, { text: 'and memory?' });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.queued, false);
    const again = await waitFor(async () => {
      const { body } = await api('GET', `/sessions/${created.body.id}`);
      return body.status === 'idle' && body.lastResult.text.includes('memory') ? body : undefined;
    });
    assert.equal(fake.calls.length, 2, 'a new process for the follow-up');
    assert.equal(fake.calls[1]!.resume, 'claude-1', 'which resumes the conversation');
    assert.equal(again.costUsd, 0.01);

    const events = await api('GET', `/sessions/${created.body.id}/events?after=0`);
    assert.deepEqual(
      events.body.events.map((e: { type: string }) => e.type),
      ['message', 'assistant', 'result', 'message', 'assistant', 'result'],
    );
  });

  test('without a project it runs in the workspace root', async () => {
    const { api, fake, config } = await app(async () => 'ok');
    const created = await api('POST', '/sessions', { prompt: 'what is running?' });
    assert.equal(created.body.project, '.');
    assert.equal(fake.calls[0]!.cwd, fs.realpathSync(config.workspaceRoot));
  });

  test('rejects bad input', async () => {
    const { api, config } = await app(async () => 'ok');
    fs.symlinkSync('/etc', path.join(config.workspaceRoot, 'escape'));
    const cases: [unknown, number, string][] = [
      [{}, 400, 'BAD_REQUEST'],
      [{ prompt: '  ' }, 400, 'BAD_REQUEST'],
      [{ prompt: 'x', project: '../etc' }, 400, 'BAD_PROJECT'],
      [{ prompt: 'x', project: '/etc' }, 400, 'BAD_PROJECT'],
      [{ prompt: 'x', project: 'escape' }, 400, 'BAD_PROJECT'],
      [{ prompt: 'x', project: 'nope' }, 404, 'PROJECT_NOT_FOUND'],
      [{ prompt: 'x', permissionMode: 'yolo' }, 400, 'BAD_REQUEST'],
      [{ prompt: 'x', permissionMode: 'bypassPermissions' }, 400, 'BYPASS_NOT_ALLOWED'],
      [{ prompt: 'x', maxTurns: 1.5 }, 400, 'BAD_REQUEST'],
    ];
    for (const [body, status, code] of cases) {
      const res = await api('POST', '/sessions', body);
      assert.equal(res.status, status, JSON.stringify(body));
      assert.equal(res.body.error.code, code, JSON.stringify(body));
    }
    assert.equal((await api('POST', '/sessions/s_missing/messages', { text: 'x' })).status, 404);
    assert.equal((await api('POST', '/prompts/p_missing', { allow: true })).status, 404);
  });
});

describe('prompts', () => {
  test('a permission request waits for an answer, then Claude continues', async () => {
    const { api, notifications } = await app(async (_text, { ask }) => {
      const decision = await ask('Bash', { command: 'docker restart grafana', description: 'Restart Grafana' });
      return decision.behavior === 'allow' ? 'restarted' : `not restarted: ${decision.message}`;
    });
    const { body: session } = await api('POST', '/sessions', { prompt: 'fix grafana' });
    const waiting = await until(api, session.id, 'waiting');
    const prompt = waiting.prompts[0];
    assert.equal(prompt.kind, 'permission');
    assert.equal(prompt.text, 'Claude wants to run: docker restart grafana (Restart Grafana)');
    assert.equal(prompt.tool, 'Bash');
    assert.match(prompt.answerWith, /"allow": true/);

    const pending = await api('GET', '/prompts');
    assert.deepEqual(
      pending.body.map((p: { id: string }) => p.id),
      [prompt.id],
    );
    const hook = notifications.find(([event]) => event === 'prompt');
    assert.equal(hook?.[2]?.id, prompt.id, 'webhook carries the prompt');

    assert.equal((await api('POST', `/prompts/${prompt.id}`, { answers: ['yes'] })).body.error.code, 'BAD_ANSWER');
    const answered = await api('POST', `/prompts/${prompt.id}`, { allow: true });
    assert.equal(answered.status, 200);
    const idle = await until(api, session.id, 'idle');
    assert.equal(idle.lastResult.text, 'restarted');
    assert.equal((await api('POST', `/prompts/${prompt.id}`, { allow: true })).status, 404, 'answered once only');
  });

  test('a denial passes the reason to Claude', async () => {
    const { api } = await app(async (_t, { ask }) => {
      const d = await ask('Bash', { command: 'rm -rf data' });
      return d.behavior === 'deny' ? `denied: ${d.message}` : 'ran';
    });
    const { body: session } = await api('POST', '/sessions', { prompt: 'clean up' });
    const waiting = await until(api, session.id, 'waiting');
    await api('POST', `/prompts/${waiting.prompts[0].id}`, { allow: false, message: 'only delete the cache' });
    assert.equal((await until(api, session.id, 'idle')).lastResult.text, 'denied: only delete the cache');
  });

  test('AskUserQuestion answers map to the question text', async () => {
    const questions = [
      {
        question: 'Restart Grafana or check Prometheus first?',
        header: 'Next step',
        multiSelect: false,
        options: [
          { label: 'Restart', description: '' },
          { label: 'Check Prometheus', description: '' },
        ],
      },
    ];
    const { api } = await app(async (_t, { ask }) => {
      const r = await ask('AskUserQuestion', { questions });
      return r.behavior === 'allow' ? JSON.stringify(r.updatedInput) : 'declined';
    });
    const { body: session } = await api('POST', '/sessions', { prompt: 'grafana is down' });
    const waiting = await until(api, session.id, 'waiting');
    const prompt = waiting.prompts[0];
    assert.equal(prompt.kind, 'question');
    assert.equal(prompt.text, 'Restart Grafana or check Prometheus first? Options: Restart; Check Prometheus.');
    assert.equal((await api('POST', `/prompts/${prompt.id}`, { answers: [] })).status, 400);
    await api('POST', `/prompts/${prompt.id}`, { answers: ['Check Prometheus'] });
    const idle = await until(api, session.id, 'idle');
    assert.deepEqual(JSON.parse(idle.lastResult.text), {
      questions,
      answers: { 'Restart Grafana or check Prometheus first?': 'Check Prometheus' },
    });
  });

  test('an unanswered prompt is declined after the timeout', async () => {
    const { api } = await app(
      async (_t, { ask }) => {
        const d = await ask('Bash', { command: 'reboot' });
        return d.behavior === 'deny' ? d.message : 'ran';
      },
      { promptTimeoutMs: 50 },
    );
    const { body: session } = await api('POST', '/sessions', { prompt: 'x' });
    const idle = await until(api, session.id, 'idle');
    assert.match(idle.lastResult.text, /No answer from the user/);
  });
});

describe('concurrency and control', () => {
  test('a message sent while Claude works is queued and runs next in the same process', async () => {
    const first = gate();
    const { api, fake } = await app(async (text, { turn }) => {
      if (turn === 1) await first.opened;
      return `did ${text}`;
    });
    const { body: session } = await api('POST', '/sessions', { prompt: 'one' });
    const sent = await api('POST', `/sessions/${session.id}/messages`, { text: 'two' });
    assert.equal(sent.body.queued, true);
    assert.equal(sent.body.session.queuedMessages, 1);
    first.open();
    const idle = await waitFor(async () => {
      const { body } = await api('GET', `/sessions/${session.id}`);
      return body.status === 'idle' && body.lastResult.text === 'did two' ? body : undefined;
    });
    assert.equal(idle.queuedMessages, 0);
    assert.equal(fake.calls.length, 1);
  });

  test('interrupt ends the current turn and runs the new message', async () => {
    const never = gate();
    const { api, fake } = await app(async (text, { turn }) => {
      if (turn === 1) await never.opened;
      return `did ${text}`;
    });
    const { body: session } = await api('POST', '/sessions', { prompt: 'slow thing' });
    await api('POST', `/sessions/${session.id}/messages`, { text: 'do this instead', interrupt: true });
    const idle = await waitFor(async () => {
      const { body } = await api('GET', `/sessions/${session.id}`);
      return body.status === 'idle' && body.lastResult.text === 'did do this instead' ? body : undefined;
    });
    assert.equal(fake.stats.interrupts, 1);
    assert.equal(idle.lastResult.ok, true);
  });

  test('stop while waiting clears the prompt; a later message resumes', async () => {
    const { api, fake } = await app(async (_t, { ask, turn }) => {
      if (turn === 1 && fake.calls.length === 1) await ask('Bash', { command: 'sleep 1000' });
      return 'resumed fine';
    });
    const { body: session } = await api('POST', '/sessions', { prompt: 'x' });
    await until(api, session.id, 'waiting');
    const stopped = await api('POST', `/sessions/${session.id}/stop`);
    assert.equal(stopped.status, 200);
    const after = await until(api, session.id, 'stopped');
    assert.deepEqual(after.prompts, []);
    assert.deepEqual((await api('GET', '/prompts')).body, []);

    await api('POST', `/sessions/${session.id}/messages`, { text: 'go on' });
    const idle = await until(api, session.id, 'idle');
    assert.equal(idle.lastResult.text, 'resumed fine');
    assert.equal(fake.calls[1]!.resume, 'claude-1');
  });

  test('MAX_ACTIVE_SESSIONS limits live sessions; idle ones do not count', async () => {
    const hold = gate();
    const { api } = await app(
      async (text) => {
        if (text === 'hold') await hold.opened;
        return 'ok';
      },
      { maxActiveSessions: 1 },
    );
    const { body: a } = await api('POST', '/sessions', { prompt: 'hold' });
    const refused = await api('POST', '/sessions', { prompt: 'second' });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.code, 'TOO_MANY_ACTIVE');
    hold.open();
    await until(api, a.id, 'idle');
    assert.equal((await api('POST', '/sessions', { prompt: 'second' })).status, 201);
  });

  test('DELETE forgets the session', async () => {
    const { api } = await app(async () => 'ok');
    const { body: session } = await api('POST', '/sessions', { prompt: 'x' });
    assert.equal((await api('DELETE', `/sessions/${session.id}`)).status, 204);
    assert.equal((await api('GET', `/sessions/${session.id}`)).status, 404);
  });

  test('events long-poll returns as soon as something happens', async () => {
    const step = gate();
    const { api } = await app(async () => {
      await step.opened;
      return 'done';
    });
    const { body: session } = await api('POST', '/sessions', { prompt: 'x' });
    const first = await api('GET', `/sessions/${session.id}/events?after=0`);
    const last = first.body.events.at(-1).seq;
    const started = Date.now();
    setTimeout(() => step.open(), 100);
    const next = await api('GET', `/sessions/${session.id}/events?after=${last}&wait=5`);
    assert.ok(Date.now() - started < 3000);
    assert.equal(next.body.events[0].type, 'assistant');
  });
});

describe('failures and restarts', () => {
  test('a Claude Code crash marks the session failed and notifies', async () => {
    const { api, notifications } = await app(async () => 'x', {}, { throwOnStart: 'Native CLI binary not found' });
    const { body: session } = await api('POST', '/sessions', { prompt: 'x' });
    const failed = await until(api, session.id, 'failed');
    assert.match(failed.error, /Native CLI binary/);
    assert.equal(notifications.at(-1)![0], 'failed');
  });

  test('an error result ends the turn (idle, ok=false) instead of failing the session', async () => {
    const { api, notifications } = await app(async () => 'x', {}, { errorResult: 'Not logged in · Please run /login' });
    const { body: session } = await api('POST', '/sessions', { prompt: 'x' });
    const idle = await until(api, session.id, 'idle');
    assert.deepEqual([idle.lastResult.ok, idle.lastResult.text, idle.error], [false, 'Not logged in · Please run /login', null]);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      notifications.map(([event]) => event),
      ['turn_done'],
    );
  });

  test('after a restart, sessions come back idle and resumable', async () => {
    const config = testConfig();
    const hold = gate();
    const first = new SessionManager(config, fakeQuery(async () => (await hold.opened, 'x')).fn, () => {});
    const session = await first.create({ prompt: 'long job', project: '.', cwd: config.workspaceRoot });
    await waitFor(() => session.toView().claudeSessionId);
    first.stopAll(); // writes sessions.json while the turn was still running
    const second = new SessionManager(config, fakeQuery(async () => 'continued').fn, () => {});
    const restored = second.get(session.id).toView();
    assert.equal(restored.status, 'idle');
    assert.match(restored.error ?? '', /restarted/);
    assert.equal(restored.claudeSessionId, 'claude-1');
  });
});
