import { API_BASE } from './config';
import { getToken } from './storage';

export interface TranslateInput {
  text: string;
  source_lang: string;
  target_lang: string;
  context?: string[];
  chat_id?: string;
  direction: 'incoming' | 'outgoing';
}

export interface TranslateOutput {
  translation: string;
  model: string;
  cached: boolean;
  remaining_today: number | null;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

export async function translate(input: TranslateInput): Promise<TranslateOutput> {
  const r = await authedFetch('/translate', { method: 'POST', body: JSON.stringify(input) });
  if (!r.ok) throw new Error(`translate ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getMe(): Promise<unknown> {
  const r = await authedFetch('/me');
  if (!r.ok) throw new Error(`me ${r.status}`);
  return r.json();
}

export async function getUsage(): Promise<{ today: { messages: number; chars: number; cost_usd: number }; plan: string; is_admin: boolean }> {
  const r = await authedFetch('/usage');
  if (!r.ok) throw new Error(`usage ${r.status}`);
  return r.json();
}

export async function exchangeGoogleCode(code: string, redirect_uri: string): Promise<{ token: string; user: any }> {
  const r = await fetch(`${API_BASE}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri }),
  });
  if (!r.ok) throw new Error(`auth ${r.status}: ${await r.text()}`);
  return r.json();
}
