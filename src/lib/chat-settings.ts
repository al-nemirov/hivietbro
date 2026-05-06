// Per-chat settings: язык собеседника + включён ли перевод для конкретного чата.
// Хранится в chrome.storage.local — синхронизируется между popup и content script.

import { Storage } from '@plasmohq/storage';

const PREFIX = 'zb_chat:';
const INDEX_KEY = 'zb_chat_index'; // массив всех ключей чатов для popup'а

const storage = new Storage();

export interface ChatSettings {
  enabled: boolean;
  partner_lang: string; // 'vi' | 'en' | 'zh' | 'ja' | 'ko' | 'fr' | ...
  preferred_lang: string; // 'ru' (язык, на который переводим входящие)
  display_name?: string; // имя из data-trailer для popup'а
  updated_at: number;
}

export const SUPPORTED_PARTNER_LANGS = [
  { code: 'vi', label: 'Tiếng Việt', flag: 'VI' },
  { code: 'en', label: 'English', flag: 'EN' },
  { code: 'zh', label: '中文', flag: 'ZH' },
  { code: 'ja', label: '日本語', flag: 'JA' },
  { code: 'ko', label: '한국어', flag: 'KO' },
  { code: 'fr', label: 'Français', flag: 'FR' },
];

export const SUPPORTED_PREFERRED_LANGS = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
];

function key(chatKey: string): string {
  return PREFIX + chatKey;
}

export function defaultSettings(displayName?: string): ChatSettings {
  return {
    enabled: false,
    partner_lang: 'vi',
    preferred_lang: 'ru',
    display_name: displayName,
    updated_at: Date.now(),
  };
}

export async function getChatSettings(chatKey: string): Promise<ChatSettings | null> {
  const v = await storage.get<ChatSettings>(key(chatKey));
  return v ?? null;
}

export async function getOrInitChatSettings(
  chatKey: string,
  displayName?: string
): Promise<ChatSettings> {
  const existing = await getChatSettings(chatKey);
  if (existing) {
    if (displayName && existing.display_name !== displayName) {
      existing.display_name = displayName;
      await setChatSettings(chatKey, existing);
    }
    return existing;
  }
  const s = defaultSettings(displayName);
  await setChatSettings(chatKey, s);
  return s;
}

export async function setChatSettings(chatKey: string, settings: ChatSettings): Promise<void> {
  settings.updated_at = Date.now();
  await storage.set(key(chatKey), settings);

  const index = (await storage.get<string[]>(INDEX_KEY)) ?? [];
  if (!index.includes(chatKey)) {
    index.push(chatKey);
    await storage.set(INDEX_KEY, index);
  }
}

export async function listChats(): Promise<Array<{ chatKey: string; settings: ChatSettings }>> {
  const index = (await storage.get<string[]>(INDEX_KEY)) ?? [];
  const out: Array<{ chatKey: string; settings: ChatSettings }> = [];
  for (const ck of index) {
    const s = await storage.get<ChatSettings>(key(ck));
    if (s) out.push({ chatKey: ck, settings: s });
  }
  out.sort((a, b) => b.settings.updated_at - a.settings.updated_at);
  return out;
}

export async function deleteChatSettings(chatKey: string): Promise<void> {
  await storage.remove(key(chatKey));
  const index = (await storage.get<string[]>(INDEX_KEY)) ?? [];
  const next = index.filter((k) => k !== chatKey);
  await storage.set(INDEX_KEY, next);
}

/**
 * Миграция настроек со старого ключа (trailer) на новый (qid prefix).
 * Если по новому ключу ничего нет, но по старому есть — копируем.
 */
export async function migrateChatSettings(newKey: string, oldKey: string): Promise<ChatSettings | null> {
  if (newKey === oldKey) return null;
  const [newer, older] = await Promise.all([getChatSettings(newKey), getChatSettings(oldKey)]);
  if (newer) return null; // уже мигрировали
  if (!older) return null; // нечего мигрировать
  await setChatSettings(newKey, { ...older, display_name: older.display_name ?? oldKey });
  await deleteChatSettings(oldKey);
  return { ...older };
}
