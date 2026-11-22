import { generateText, Output, isStepCount, hasToolCall, pruneMessages, type LanguageModel, type ToolSet } from 'ai';
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
const TRANSIENT = /overload|high demand|unavailable|503|529|500|502|504|timeout|timed out|aborted due to timeout|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|try again later|internal error/i;
const FATAL = /401|402|403|invalid.*key|unauthorized|authentication|insufficient balance|insufficient_quota|credit balance|billing|payment required|quota|not found|no longer available|not supported/i;

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
      if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
      const m = e instanceof Error ? e.message : String(e);
      const delay = RETRY_DELAYS_S[attempt - 1];
      if (!TRANSIENT.test(m) || FATAL.test(m) || delay === undefined) throw e;
      ctx.run.log(`The AI provider is busy or slow right now. Trying again in ${delay} s (attempt ${attempt + 1} of ${RETRY_DELAYS_S.length + 1})…`);
      await sleep(delay * 1000, ctx.run.abort.signal);
    }
  }
}

function errText(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  if (/no longer available|not found|not supported|does not exist/i.test(m) && /model/i.test(m))
    return 'This model cannot be used with your key (the provider said it is not available). Start again and pick another model, ideally the one marked "recommended".';
  if (/402|insufficient balance|insufficient_quota|credit balance|insufficient credits|billing|payment required/i.test(m))
    return 'Your AI account has no credit left (the provider said: insufficient balance). Add credit on the provider\'s website, or start again with another key. This is not a problem with your website.';
  if (/overload|high demand|unavailable|503|529|try again later/i.test(m))
    return 'The AI provider is overloaded right now. This is temporary and not a problem with your website: try again in a few minutes, or pick another model (stable models are busy less often than preview ones).';
  if (/401|403|invalid.*key|unauthorized|authentication/i.test(m)) return 'The AI provider rejected the API key.';
  if (/429|rate limit|quota|exhausted/i.test(m)) return 'The AI provider rate limit or quota was reached. Free keys run out quickly; try a Quick test or a paid key.';
  return m.slice(0, 300);
}

/** Asks the model for a JSON object matching the schema. Retries once with the error. */
export async function structured<S extends z.ZodType>(ctx: LlmCtx, task: string, prompt: string, schema: S): Promise<z.infer<S>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
    try {
      const res = await withRetry(ctx, () =>
        generateText({
          model: ctx.model,
          instructions: ctx.instructions,
          prompt: `TASK: ${task}\n\n${prompt}${attempt ? `\n\nYour previous answer could not be used (${errText(lastErr)}). Reply with valid JSON that matches the schema.` : ''}`,
          output: Output.object({ schema }),
          abortSignal: ctx.run.abort.signal,
          maxRetries: 1,
          timeout: { stepMs: STEP_TIMEOUT_MS },
        }),
      );
      ctx.run.addUsage(res.usage);
      return res.output as z.infer<S>;
    } catch (e) {
      lastErr = e;
      if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
      if (FATAL.test(String(e)) || TRANSIENT.test(String(e)) || /429|rate limit/i.test(String(e))) throw new Error(errText(e));
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
      abortSignal: ctx.run.abort.signal,
      maxRetries: 1,
      timeout: { stepMs: STEP_TIMEOUT_MS },
      // Keep the context small: old page snapshots are dropped once newer ones exist.
      prepareStep: async ({ messages }) =>
        messages.length > 8
          ? { messages: pruneMessages({ messages, toolCalls: [{ type: 'before-last-6-messages', tools: ['snapshot'] }], emptyMessages: 'remove' }) }
          : {},
    }));
    ctx.run.addUsage(res.usage);
    const toolCalls = res.steps.flatMap((s) => s.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input })));
    return { text: res.text, toolCalls };
  } catch (e) {
    if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
    throw new Error(errText(e));
  }
}
