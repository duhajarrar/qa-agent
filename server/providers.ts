import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogle } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { KeyCheckResult, ModelInfo, ProviderId } from './types.js';
import { createMockModel } from './mock/mockModel.js';

export const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'groq'];

export function createModel(provider: ProviderId | 'mock', apiKey: string, modelId: string): LanguageModel {
  switch (provider) {
    case 'anthropic': return createAnthropic({ apiKey })(modelId);
    case 'openai': return createOpenAI({ apiKey })(modelId);
    case 'google': return createGoogle({ apiKey })(modelId);
    case 'deepseek': return createDeepSeek({ apiKey })(modelId);
    case 'groq': return createGroq({ apiKey })(modelId);
    case 'openrouter':
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey,
        headers: { 'X-Title': 'QA Agent' },
      })(modelId);
    case 'mock':
      if (process.env.ENABLE_MOCK_PROVIDER !== 'true') throw new Error('Mock provider is disabled');
      return createMockModel();
  }
}

// ---------------- Key check + live model list ----------------
// Model IDs change often, so we never hard-code them: we ask the provider which
// models this key can use, and pick a sensible default with name patterns.

const PREFERENCES: Record<ProviderId, RegExp[]> = {
  anthropic: [/sonnet/i, /opus/i, /haiku/i],
  openai: [/^gpt-5(?!.*(nano|codex|chat|audio|realtime|search|image|pro))/i, /^gpt-4\.1(?!.*nano)/i, /^gpt-4o(?!.*(mini|audio|realtime|search))/i],
  google: [/^gemini-[\d.]+-flash(?!.*(lite|image|tts|live|audio|thinking))/i, /^gemini-[\d.]+-pro(?!.*(image|tts|vision))/i, /gemini.*flash/i],
  deepseek: [/^deepseek-chat$/i, /deepseek/i],
  openrouter: [/^anthropic\/claude-.*sonnet/i, /^openai\/gpt-5(?!.*(nano|codex))/i, /^google\/gemini-.*flash/i, /:free$/i],
  // Llama 4 Scout has the highest tokens-per-minute allowance on Groq's free tier, which a browser agent needs.
  // gpt-oss on Groq often sends malformed tool calls, so models that call tools reliably come first.
  groq: [/llama-4-scout/i, /kimi-k2/i, /llama-.*70b/i, /qwen/i, /gpt-oss-120b/i, /llama/i],
};

const EXCLUDE = /(orpheus|playai|allam|banana|robotics|customtools|custom-tools|embed|whisper|tts|transcribe|audio|realtime|image|dall-e|moderation|guard|search|instruct|davinci|babbage|imagen|veo|aqa|learnlm|gemma-?\d*-?\d*b?-?it$|computer-use|live)/i;

function newestFirst(a: string, b: string) {
  return b.localeCompare(a, 'en', { numeric: true });
}

const UNSTABLE = /(preview|exp|experimental|beta|alpha)/i;

function pickRecommended(provider: ProviderId, models: ModelInfo[]): string | undefined {
  const all = models.map((m) => m.id);
  // Prefer stable models: preview models are busier and change without notice.
  const stable = all.filter((id) => !UNSTABLE.test(id));
  for (const ids of [stable, all]) {
    for (const re of PREFERENCES[provider]) {
      const hits = ids.filter((id) => re.test(id)).sort(newestFirst);
      if (hits.length) return hits[0];
    }
  }
  return stable[0] ?? all[0];
}

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  if (!res.ok) {
    let msg = `The provider answered ${res.status}.`;
    if (res.status === 401 || res.status === 403) msg = 'This key was not accepted. Check that you copied the whole key.';
    else if (res.status === 402) msg = 'This account has no credit left. Add credit on the provider\'s website, or use another key.';
    else if (res.status === 429) msg = 'This key has hit its rate limit. Wait a minute and try again.';
    throw new Error(msg);
  }
  return JSON.parse(body);
}

export async function checkKey(provider: ProviderId, apiKey: string): Promise<KeyCheckResult> {
  try {
    if (!apiKey || apiKey.trim().length < 8) return { ok: false, error: 'Paste your full API key.', models: [] };
    const key = apiKey.trim();
    let models: ModelInfo[] = [];
    switch (provider) {
      case 'anthropic': {
        const j = await getJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
        models = j.data.map((m: { id: string; display_name?: string }) => ({ id: m.id, label: m.display_name || m.id }));
        break;
      }
      case 'openai': {
        const j = await getJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` });
        models = j.data
          .map((m: { id: string }) => m.id)
          .filter((id: string) => /^(gpt-|o\d)/.test(id) && !EXCLUDE.test(id))
          .sort(newestFirst)
          .map((id: string) => ({ id, label: id }));
        break;
      }
      case 'google': {
        const j = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': key });
        models = (j.models || [])
          .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m: { name: string; displayName?: string }) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
          .filter((m: ModelInfo) => m.id.startsWith('gemini') && !EXCLUDE.test(m.id));
        break;
      }
      case 'deepseek': {
        const j = await getJson('https://api.deepseek.com/models', { Authorization: `Bearer ${key}` });
        models = j.data.map((m: { id: string }) => ({ id: m.id, label: m.id }));
        // DeepSeek is pay-as-you-go: a valid key with an empty balance fails on the first request.
        const bal = await getJson('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${key}` }).catch(() => null);
        if (bal && bal.is_available === false) {
          return { ok: false, error: 'This DeepSeek key works, but the account has no balance. Top up at platform.deepseek.com, or use another key.', models: [] };
        }
        break;
      }
      case 'groq': {
        const j = await getJson('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${key}` });
        models = j.data
          .filter((m: { id: string; active?: boolean }) => m.active !== false && !EXCLUDE.test(m.id))
          .map((m: { id: string }) => ({ id: m.id, label: m.id }));
        break;
      }
      case 'openrouter': {
        const info = await getJson('https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${key}` });
        const remaining = info?.data?.limit_remaining;
        if (typeof remaining === 'number' && remaining <= 0) {
          return { ok: false, error: 'This OpenRouter key has reached its credit limit. Add credit or raise the limit at openrouter.ai, or use another key.', models: [] };
        }
        const j = await getJson('https://openrouter.ai/api/v1/models', {});
        models = j.data
          .filter((m: { supported_parameters?: string[] }) => m.supported_parameters?.includes('tools'))
          .map((m: { id: string; name?: string }) => ({ id: m.id, label: (m.name || m.id) + (m.id.endsWith(':free') ? ' (free)' : '') }));
        break;
      }
    }
    if (!models.length) return { ok: false, error: 'The key works, but no suitable chat models are available for it.', models: [] };
    return { ok: true, models, recommended: pickRecommended(provider, models) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.includes('fetch failed') ? 'Could not reach the provider. Try again in a moment.' : msg, models: [] };
  }
}

/** Free or rate-limited options get a Quick test by default so a run can finish within daily limits. */
export function isLimitedModel(provider: ProviderId, modelId: string): boolean {
  return provider === 'groq' || modelId.endsWith(':free') || (provider === 'google' && /flash/i.test(modelId));
}
