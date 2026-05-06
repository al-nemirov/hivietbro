// Тонкая обёртка над /glossary endpoints Worker'а

import { API_BASE } from './config';
import { getToken } from './storage';

export interface GlossaryEntry {
  id?: number;
  source_text: string;
  source_lang: string;
  target_text: string;
  target_lang: string;
  notes?: string | null;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

export async function listGlossary(): Promise<GlossaryEntry[]> {
  const r = await authedFetch('/glossary');
  if (!r.ok) throw new Error(`glossary list ${r.status}`);
  const data = (await r.json()) as { entries: GlossaryEntry[] };
  return data.entries;
}

export async function upsertGlossary(entry: GlossaryEntry): Promise<void> {
  const r = await authedFetch('/glossary', { method: 'POST', body: JSON.stringify(entry) });
  if (!r.ok) throw new Error(`glossary upsert ${r.status}`);
}

export async function deleteGlossary(id: number): Promise<void> {
  const r = await authedFetch('/glossary', { method: 'DELETE', body: JSON.stringify({ id }) });
  if (!r.ok) throw new Error(`glossary delete ${r.status}`);
}
