import { generateText, Output, isStepCount, hasToolCall, pruneMessages, NoObjectGeneratedError, type LanguageModel, type ToolSet } from 'ai';
import type { z } from 'zod';
import type { Run } from '../runs.js';

export interface LlmCtx {
  model: LanguageModel;
  run: Run;
  instructions: string;
}

// Providers sometimes return temporary errors (overloaded, high demand, slow answers).
// We retry those ourselves so the user can see what is happening in the activity feed.
const RETRY_DELAYS_S = [10, 20, 40, 60, 90]; // up to 6 attempts, about 4 minutes of waiting in total
const STEP_TIMEOUT_MS = 120_000; // one model answer taking longer than this counts as a temporary failure
// Malformed answers ("could not be parsed", Groq's tool_use_failed) are random model slips: a retry usually works.
const TRANSIENT = /could not be parsed|failed_generation|tool_use_failed|parsing failed|invalid tool call|tool call validation failed|not in request\.tools|overload|high demand|unavailable|503|529|500|502|504|timeout|timed out|aborted due to timeout|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|try again later|internal error/i;
const RATE_LIMIT = /429|rate limit|too many requests|resource_exhausted|try again in|retry in/i;
const DAILY = /per day|perday|daily|insufficient_quota|insufficient balance|credit balance is too low|request too large/i;
const ACCOUNT = /free tier is not available|set up billing|billing to upgrade|upgrade to the paid tier|billing (?:is )?(?:not )?(?:enabled|required)|enable billing|account is not active|organization has been disabled/i;
const FATAL = /requires more credits|can only afford|401|402|403|invalid.*key|unauthorized|authentication|insufficient balance|insufficient_quota|credit balance is too low|payment required|not found|no longer available|not supported|request too large/i;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Run stopped')); }, { once: true });
  });
}

/** Runs one model call, retrying temporary provider problems and telling the user while it waits. */
async function withRetry<T>(ctx: LlmCtx, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      ctx.run.aiWaiting(false);
      if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
      const m = e instanceof Error ? e.message : String(e);
      // Free tiers limit requests/tokens per minute: wait and continue. Daily limits cannot be waited out.
      const rateLimited = RATE_LIMIT.test(m) && !DAILY.test(m);
      const retryable = !ACCOUNT.test(m) && (rateLimited || (TRANSIENT.test(m) && !FATAL.test(m)));
      let delay = RETRY_DELAYS_S[attempt - 1];
      if (!retryable || delay === undefined) throw e;
      const malformed = /could not be parsed|failed_generation|tool_use_failed|parsing failed|invalid tool call|tool call validation failed|not in request\.tools/i.test(m);
      if (malformed) delay = 2;
      const asked = m.match(/(?:try again|retry) in ([\d.]+)\s*(ms|s|m)?/i);
      if (asked) {
        const v = Number(asked[1]) * (asked[2] === 'm' ? 60 : asked[2] === 'ms' ? 0.001 : 1);
        delay = Math.min(120, Math.max(5, Math.ceil(v) + 2));
      }
      ctx.run.log(
        malformed
          ? `The AI sent a badly formatted answer. Asking again (attempt ${attempt + 1} of ${RETRY_DELAYS_S.length + 1})…`
          : rateLimited
          ? `Reached the AI provider's per-minute limit (common with free keys). Waiting ${delay} s, then continuing (attempt ${attempt + 1} of ${RETRY_DELAYS_S.length + 1})…`
          : `The AI provider is busy or slow right now. Trying again in ${delay} s (attempt ${attempt + 1} of ${RETRY_DELAYS_S.length + 1})… Provider said: "${m.replace(/\s+/g, ' ').trim().slice(0, 140)}"`,
      );
      await sleep(delay * 1000, ctx.run.abort.signal);
    }
  }
}

export function errText(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  const raw = m.replace(/\s+/g, ' ').trim().slice(0, 240);
  const friendly = friendlyError(m);
  return friendly === raw ? raw : `${friendly} (Provider said: "${raw}")`;
}

export function friendlyError(m: string) {
  if (ACCOUNT.test(m))
    return 'The AI provider says this key\'s account needs billing set up before it can be used (for Gemini: the free tier is not available for this Google project). Enable billing, use a key from another account, or pick another provider. This is not a problem with your website.';
  if (/could not be parsed|failed_generation|tool_use_failed|parsing failed|invalid tool call|tool call validation failed|not in request\.tools/i.test(m))
    return 'The AI kept sending badly formatted answers (this happens with some free or smaller models). Try again, or pick another model. This is not a problem with your website.';
  if (/request too large|reduce your message size/i.test(m))
    return 'One request is bigger than this key\'s per-minute limit (common with free keys). Pick another model with higher limits, or use a paid key. This is not a problem with your website.';
  if (/no longer available|not found|not supported|does not exist/i.test(m) && /model/i.test(m))
    return 'This model cannot be used with your key (the provider said it is not available). Start again and pick another model, ideally the one marked "recommended".';
  if (/402|insufficient balance|insufficient_quota|credit balance is too low|insufficient credits|payment required|requires more credits|can only afford/i.test(m))
    return 'Your AI account has no credit left (the provider said: insufficient balance). Add credit on the provider\'s website, or start again with another key. This is not a problem with your website.';
  if (/overload|high demand|unavailable|503|529|try again later/i.test(m))
    return 'The AI provider is overloaded right now. This is temporary and not a problem with your website: try again in a few minutes, or pick another model (stable models are busy less often than preview ones).';
  if (/401|403|invalid.*key|unauthorized|authentication/i.test(m)) return 'The AI provider rejected the API key.';
  if (/429|rate limit|quota|exhausted/i.test(m) && /per day|perday|daily/i.test(m))
    return 'This key has used up its free daily limit. Try again tomorrow, use another key, or add credit with the provider. This is not a problem with your website.';
  if (/429|rate limit|quota|exhausted/i.test(m)) return 'The AI provider rate limit or quota was reached. Free keys run out quickly; try a Quick test or a paid key.';
  return m.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** Pulls a JSON object out of model text (handles ```json fences and extra prose). */
function salvageJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function schemaIssues(e: unknown): string {
  const cause = (e as { cause?: { issues?: { path: (string | number)[]; message: string }[] } })?.cause;
  const issues = cause?.issues;
  if (!issues?.length) return errText(e);
  return issues.slice(0, 5).map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ');
}

/** Asks the model for a JSON object matching the schema. Salvages near-misses, retries with feedback. */
export async function structured<S extends z.ZodType>(ctx: LlmCtx, task: string, prompt: string, schema: S): Promise<z.infer<S>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
    try {
      const res = await withRetry(ctx, () =>
        generateText({
          model: ctx.model,
          instructions: ctx.instructions,
          prompt: `TASK: ${task}\n\n${prompt}${attempt ? `\n\nYour previous answer could not be used (${schemaIssues(lastErr)}). Reply with ONLY a valid JSON object that matches the schema exactly, with every field present.` : ''}`,
          output: Output.object({ schema }),
          reasoning: 'medium',
          maxOutputTokens: 8000,
          abortSignal: ctx.run.abort.signal,
          maxRetries: 3,
          timeout: { stepMs: STEP_TIMEOUT_MS },
          onLanguageModelCallStart: () => ctx.run.aiWaiting(true),
          onLanguageModelCallEnd: () => ctx.run.aiWaiting(false),
        }),
      );
      ctx.run.addUsage(res.usage);
      return res.output as z.infer<S>;
    } catch (e) {
      lastErr = e;
      if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
      // Many models return almost-right JSON (wrapped in prose or code fences, or with small type
      // slips). Our schemas fill defaults, so try to use what the model sent before asking again.
      if (NoObjectGeneratedError.isInstance(e)) {
        const parsed = schema.safeParse(salvageJson(e.text));
        if (parsed.success) return parsed.data as z.infer<S>;
      }
      if (ACCOUNT.test(String(e)) || FATAL.test(String(e)) || TRANSIENT.test(String(e)) || /429|rate limit/i.test(String(e))) throw new Error(errText(e));
    }
  }
  throw new Error(`The AI could not produce a valid answer for "${task}": ${errText(lastErr)}`);
}

/** Lets the model use browser tools until it stops, calls `stopTool`, or reaches `maxSteps`. */
export async function toolLoop(
  ctx: LlmCtx,
  task: string,
  prompt: string,
  tools: ToolSet,
  maxSteps: number,
  stopTool?: string,
): Promise<{ text: string; toolCalls: { toolName: string; input: unknown }[] }> {
  try {
    const res = await withRetry(ctx, () => generateText({
      model: ctx.model,
      instructions: ctx.instructions,
      prompt: `TASK: ${task}\n\n${prompt}`,
      tools,
      stopWhen: stopTool ? [isStepCount(maxSteps), hasToolCall(stopTool)] : isStepCount(maxSteps),
      // Browser steps are simple decisions: less "thinking" makes each step much faster.
      reasoning: 'low',
      // Free tiers count the requested output size against per-minute limits, so keep it modest.
      maxOutputTokens: 4000,
      onStepEnd: (step) => {
        ctx.run.addUsage(step.usage);
        ctx.run.stepProgress(`Step ${step.stepNumber + 1} of up to ${maxSteps}`);
      },
      abortSignal: ctx.run.abort.signal,
      // Retry inside the step first (honours the provider's retry-after), so a short
      // rate limit does not restart the whole browser session.
      maxRetries: 4,
      timeout: { stepMs: STEP_TIMEOUT_MS },
      onLanguageModelCallStart: () => ctx.run.aiWaiting(true),
      onLanguageModelCallEnd: () => ctx.run.aiWaiting(false),
      // Keep the context small (free tiers limit tokens per minute): only the latest page
      // snapshot is kept, older ones are dropped once a newer one exists.
      prepareStep: async ({ messages }) =>
        messages.length > 4
          ? { messages: pruneMessages({ messages, toolCalls: [{ type: 'before-last-2-messages', tools: ['snapshot'] }], emptyMessages: 'remove' }) }
          : {},
    }));
    ctx.run.stepProgress(undefined);
    const toolCalls = res.steps.flatMap((s) => s.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input })));
    return { text: res.text, toolCalls };
  } catch (e) {
    if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
    throw new Error(errText(e));
  }
}
