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
  // 1 retry на сетевые/5xx ошибки — чтобы транзитивный «Failed to fetch» не убил перевод
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await authedFetch('/translate', { method: 'POST', body: JSON.stringify(input) });
      if (r.status >= 500) {
        lastErr = new Error(`translate ${r.status}`);
        if (attempt === 0) {
          await new Promise((res) => setTimeout(res, 600));
          continue;
        }
      }
      if (!r.ok) throw new Error(`translate ${r.status}: ${await r.text()}`);
      return r.json();
    } catch (e) {
      lastErr = e;
      // Сетевые ошибки (Failed to fetch) — повторяем один раз
      if (attempt === 0) {
        await new Promise((res) => setTimeout(res, 600));
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('translate failed');
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

export async function getCheckoutUrl(): Promise<string> {
  const r = await authedFetch('/billing/checkout');
  if (!r.ok) throw new Error(`checkout ${r.status}`);
  const data = (await r.json()) as { url: string };
  return data.url;
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

// ===== Per-chat settings sync =====

export interface ServerChatSettings {
  chat_key: string;
  display_name?: string | null;
  enabled: number; // SQLite stores boolean as 0/1
  partner_lang: string;
  preferred_lang: string;
  updated_at: number;
}

export async function pullChatsFromServer(since = 0): Promise<ServerChatSettings[]> {
  const r = await authedFetch(`/settings/chats?since=${since}`);
  if (!r.ok) throw new Error(`pull chats ${r.status}`);
  const data = (await r.json()) as { chats: ServerChatSettings[] };
  return data.chats;
}

export async function pushChatsToServer(
  chats: Array<{
    chat_key: string;
    display_name?: string | null;
    enabled: boolean;
    partner_lang: string;
    preferred_lang: string;
    updated_at: number;
  }>
): Promise<void> {
  if (chats.length === 0) return;
  const r = await authedFetch('/settings/chats', { method: 'PUT', body: JSON.stringify(chats) });
  if (!r.ok) throw new Error(`push chats ${r.status}`);
}
