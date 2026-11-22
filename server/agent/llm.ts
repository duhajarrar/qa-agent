import { generateText, Output, isStepCount, hasToolCall, pruneMessages, type LanguageModel, type ToolSet } from 'ai';
import type { z } from 'zod';
import type { Run } from '../runs.js';

export interface LlmCtx {
  model: LanguageModel;
  run: Run;
  instructions: string;
}

function errText(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
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
      const res = await generateText({
        model: ctx.model,
        instructions: ctx.instructions,
        prompt: `TASK: ${task}\n\n${prompt}${attempt ? `\n\nYour previous answer could not be used (${errText(lastErr)}). Reply with valid JSON that matches the schema.` : ''}`,
        output: Output.object({ schema }),
        abortSignal: ctx.run.abort.signal,
        maxRetries: 2,
      });
      ctx.run.addUsage(res.usage);
      return res.output as z.infer<S>;
    } catch (e) {
      lastErr = e;
      if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
      if (/401|403|429|quota|rate limit|unauthorized/i.test(String(e))) throw new Error(errText(e));
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
    const res = await generateText({
      model: ctx.model,
      instructions: ctx.instructions,
      prompt: `TASK: ${task}\n\n${prompt}`,
      tools,
      stopWhen: stopTool ? [isStepCount(maxSteps), hasToolCall(stopTool)] : isStepCount(maxSteps),
      abortSignal: ctx.run.abort.signal,
      maxRetries: 2,
      // Keep the context small: old page snapshots are dropped once newer ones exist.
      prepareStep: async ({ messages }) =>
        messages.length > 8
          ? { messages: pruneMessages({ messages, toolCalls: [{ type: 'before-last-6-messages', tools: ['snapshot'] }], emptyMessages: 'remove' }) }
          : {},
    });
    ctx.run.addUsage(res.usage);
    const toolCalls = res.steps.flatMap((s) => s.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input })));
    return { text: res.text, toolCalls };
  } catch (e) {
    if (ctx.run.abort.signal.aborted) throw new Error('Run stopped');
    throw new Error(errText(e));
  }
}
