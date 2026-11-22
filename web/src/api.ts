import type { CheckpointAnswer, KeyCheckResult, ProviderId, PublicRunState } from '../../server/types';

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && (data as { error?: string }).error) throw new Error((data as { error: string }).error);
  return data as T;
}

export const api = {
  checkKey: (provider: ProviderId | 'mock', apiKey: string) => post<KeyCheckResult>('/api/check-key', { provider, apiKey }),
  preview: (url: string) => post<{ ok: boolean; error?: string; host?: string; title?: string; themeColor?: string | null }>('/api/preview', { url }),
  async createRun(config: Record<string, unknown>, files: File[]): Promise<string> {
    const form = new FormData();
    form.set('config', JSON.stringify(config));
    files.forEach((f) => form.append('docs', f));
    const res = await fetch('/api/runs', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not start the test.');
    return data.id;
  },
  getRun: async (id: string): Promise<PublicRunState | null> => {
    const res = await fetch(`/api/runs/${id}`);
    return res.ok ? res.json() : null;
  },
  answer: (id: string, checkpointId: string, answer: CheckpointAnswer) => post(`/api/runs/${id}/answer`, { checkpointId, answer }),
  stop: (id: string) => post(`/api/runs/${id}/stop`, {}),
  health: async () => (await fetch('/api/health')).json() as Promise<{ ok: boolean; mock: boolean }>,
};

// Remember this browser's runs so "My tests" can list them. Storage may be unavailable.
const KEY = 'qa-agent-runs';
export function rememberRun(id: string, url: string) {
  try {
    const list = recentRuns().filter((r) => r.id !== id);
    list.unshift({ id, url, at: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* ignore */
  }
}
export function recentRuns(): { id: string; url: string; at: number }[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
