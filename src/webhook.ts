import type { Prompt } from './prompts.ts';
import type { Notify, SessionView } from './sessions.ts';

export type WebhookPayload = {
  event: 'prompt' | 'turn_done' | 'failed';
  session: SessionView;
  prompt?: Prompt;
};

const RETRY_DELAYS_MS = [1_000, 5_000, 20_000];

/**
 * POSTs every event to WEBHOOK_URL, retrying a few times. Fire and forget:
 * a receiver that is down never blocks Claude, and GET /prompts and
 * GET /sessions/:id still have everything.
 */
export function webhookNotifier(url: string | undefined, token: string | undefined, fetchFn: typeof fetch = fetch): Notify {
  if (!url) return () => {};
  return (event, session, prompt) => {
    const payload: WebhookPayload = { event, session, ...(prompt ? { prompt } : {}) };
    const body = JSON.stringify(payload);
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetchFn(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body,
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok) return;
          throw new Error(`HTTP ${response.status}`);
        } catch (error) {
          const delay = RETRY_DELAYS_MS[attempt];
          if (delay === undefined) {
            console.warn(`webhook ${event} for ${session.id} failed: ${error instanceof Error ? error.message : error}`);
            return;
          }
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    })();
  };
}
