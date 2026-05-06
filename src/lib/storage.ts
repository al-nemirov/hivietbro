import { Storage } from '@plasmohq/storage';
import { STORAGE } from './config';

const storage = new Storage();

export interface StoredUser {
  id: number;
  email: string;
  display_name: string | null;
  picture_url: string | null;
  plan: string;
  is_admin: boolean;
  preferred_lang: string;
  partner_lang: string;
}

export async function getToken(): Promise<string | null> {
  return (await storage.get<string>(STORAGE.token)) ?? null;
}

export async function setToken(token: string): Promise<void> {
  await storage.set(STORAGE.token, token);
}

export async function getUser(): Promise<StoredUser | null> {
  return (await storage.get<StoredUser>(STORAGE.user)) ?? null;
}

export async function setUser(user: StoredUser): Promise<void> {
  await storage.set(STORAGE.user, user);
}

export async function clearAuth(): Promise<void> {
  await storage.remove(STORAGE.token);
  await storage.remove(STORAGE.user);
}

export async function isEnabled(): Promise<boolean> {
  const v = await storage.get<boolean>(STORAGE.enabled);
  return v ?? true;
}

export async function setEnabled(v: boolean): Promise<void> {
  await storage.set(STORAGE.enabled, v);
}
