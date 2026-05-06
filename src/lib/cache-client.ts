// Тонкий клиент к кэшу. Все операции — через messaging к background service worker.
// Это решает проблему изолированных IndexedDB: content script (chat.zalo.me origin)
// и popup (chrome-extension origin) видят одну и ту же базу — она живёт в background.

import type { CacheEntry } from './cache-types';

export type { CacheEntry } from './cache-types';

interface CacheGetRequest {
  type: 'cache.get';
  qid: string;
  src_lang: string;
  tgt_lang: string;
}
interface CacheSetRequest {
  type: 'cache.set';
  qid: string;
  entry: CacheEntry;
}
interface CacheClearRequest {
  type: 'cache.clear';
}
interface CacheStatsRequest {
  type: 'cache.stats';
}
type Req = CacheGetRequest | CacheSetRequest | CacheClearRequest | CacheStatsRequest;

function safeSend<T>(msg: Req): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          // 'Extension context invalidated' и пр. — content script от старой версии
          resolve(null);
          return;
        }
        resolve(resp ?? null);
      });
    } catch {
      // chrome.runtime недоступен (например, расширение выгружено)
      resolve(null);
    }
  });
}

export async function cacheGet(
  qid: string,
  src_lang: string,
  tgt_lang: string
): Promise<CacheEntry | null> {
  return safeSend<CacheEntry>({ type: 'cache.get', qid, src_lang, tgt_lang });
}

export async function cacheSet(qid: string, entry: CacheEntry): Promise<void> {
  await safeSend<void>({ type: 'cache.set', qid, entry });
}

export async function cacheClear(): Promise<void> {
  await safeSend<void>({ type: 'cache.clear' });
}

export async function cacheStats(): Promise<{ count: number; oldest_ts: number | null }> {
  const r = await safeSend<{ count: number; oldest_ts: number | null }>({ type: 'cache.stats' });
  return r ?? { count: 0, oldest_ts: null };
}
