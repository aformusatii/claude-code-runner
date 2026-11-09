import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

/** Something Claude is waiting for: a decision on a tool call, or answers to questions. */
export type Prompt = {
  id: string;
  sessionId: string;
  project: string;
  kind: 'permission' | 'question';
  createdAt: string;
  /** One plain sentence, ready to read aloud or show. */
  text: string;
  /** The tool Claude wants to use (permission prompts). */
  tool?: string;
  input?: Record<string, unknown>;
  reason?: string;
  questions?: Question[];
  /** How to answer, for an agent reading this cold. */
  answerWith: string;
};

/**
 * The answer body of POST /prompts/:id.
 * - permission: `allow` (true/false), optional `message` (why, or what to do instead).
 * - question: `answers` (one per question: an option label or free text),
 *   or `text` (a free reply instead), or `allow: false` to decline.
 */
export type PromptAnswer = {
  allow?: boolean;
  message?: string;
  answers?: (string | string[])[];
  text?: string;
};

export class AnswerError extends Error {}

const MAX_TEXT = 400;

export function buildPrompt(
  base: Pick<Prompt, 'id' | 'sessionId' | 'project'>,
  toolName: string,
  input: Record<string, unknown>,
  reason: string | undefined,
): Prompt {
  const createdAt = new Date().toISOString();
  if (toolName === 'AskUserQuestion') {
    const questions = parseQuestions(input);
    const text = questions
      .map((q) => `${q.question} Options: ${q.options.map((o) => o.label).join('; ')}.`)
      .join(' ');
    return {
      ...base,
      kind: 'question',
      createdAt,
      text: clip(text),
      questions,
      answerWith:
        '{"answers": ["<option label or free text>", ...one per question]} or {"text": "<free reply>"} or {"allow": false, "message": "<why>"}',
    };
  }
  return {
    ...base,
    kind: 'permission',
    createdAt,
    text: clip(`Claude wants to ${describeTool(toolName, input)}`),
    tool: toolName,
    input,
    ...(reason ? { reason } : {}),
    answerWith: '{"allow": true} or {"allow": false, "message": "<why, or what to do instead>"}',
  };
}

/** Turns an answer into what canUseTool returns. Throws AnswerError on a bad body. */
export function toPermissionResult(
  prompt: Prompt,
  input: Record<string, unknown>,
  answer: PromptAnswer,
): PermissionResult {
  if (answer.message !== undefined && typeof answer.message !== 'string') {
    throw new AnswerError('"message" must be a string');
  }
  if (answer.allow === false) {
    return { behavior: 'deny', message: answer.message?.trim() || 'The user declined.' };
  }

  if (prompt.kind === 'permission') {
    if (answer.allow !== true) throw new AnswerError('Send {"allow": true} or {"allow": false, "message": "..."}');
    return { behavior: 'allow', updatedInput: input };
  }

  const questions = prompt.questions ?? [];
  if (typeof answer.text === 'string' && answer.text.trim()) {
    // A free reply instead of picking options; Claude reads it as the user's answer.
    return { behavior: 'allow', updatedInput: { ...input, response: answer.text.trim() } };
  }
  if (!Array.isArray(answer.answers) || answer.answers.length !== questions.length) {
    throw new AnswerError(`Send "answers" with exactly ${questions.length} item(s), one per question, or "text"`);
  }
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const value = answer.answers?.[i];
    const parts = Array.isArray(value) ? value : [value];
    if (parts.length === 0 || parts.some((p) => typeof p !== 'string' || !p.trim())) {
      throw new AnswerError(`answers[${i}] must be a non-empty string (or strings for a multi-select question)`);
    }
    answers[q.question] = (parts as string[]).map((p) => p.trim()).join(', ');
  });
  return { behavior: 'allow', updatedInput: { ...input, answers } };
}

/** "run: docker ps (List containers)", "edit /path/file.ts", ... */
export function describeTool(toolName: string, input: Record<string, unknown>): string {
  const s = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  switch (toolName) {
    case 'Bash':
      return `run: ${s('command')}${s('description') ? ` (${s('description')})` : ''}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `${toolName === 'Write' ? 'write' : 'edit'} ${s('file_path') || s('notebook_path')}`;
    case 'Read':
      return `read ${s('file_path')}`;
    case 'WebFetch':
      return `fetch ${s('url')}`;
    case 'WebSearch':
      return `search the web for "${s('query')}"`;
    default:
      return `use ${toolName} ${clip(JSON.stringify(input), 200)}`;
  }
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.map((q: Record<string, unknown>) => ({
    question: String(q?.question ?? ''),
    header: String(q?.header ?? ''),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: Record<string, unknown>) => ({
      label: String(o?.label ?? ''),
      description: String(o?.description ?? ''),
    })),
  }));
}

export function clip(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
