// Локальный кэш переводов в IndexedDB с AES-GCM шифрованием.
// Ключ деривится через PBKDF2 из локального seed (32 случайных байта),
// сохранённого в chrome.storage.local. Защищает от случайного просмотра
// IDB-файла другими процессами/расширениями (chrome.storage isolation).
//
// Это soft-encryption: атакующий с FS-доступом + содержимым chrome.storage
// сможет расшифровать. Реальная защита — Chrome's profile sandbox.

import { Storage } from '@plasmohq/storage';

const DB_NAME = 'zb-cache';
const DB_VERSION = 1;
const STORE = 'translations';
const SEED_KEY = 'zb_local_seed';
const PBKDF2_SALT = 'zalo-bridge-v1';
const PBKDF2_ITERATIONS = 100_000;

const storage = new Storage();

export interface CacheEntry {
  src_text: string;
  src_lang: string;
  tgt_text: string;
  tgt_lang: string;
  ts: number;
}

interface DbRecord {
  qid: string;
  encrypted: ArrayBuffer;
  iv: ArrayBuffer;
  tgt_lang: string;
  ts: number;
}

let cachedKey: CryptoKey | null = null;
let cachedDb: IDBDatabase | null = null;

async function getOrCreateSeed(): Promise<Uint8Array> {
  let seedB64 = await storage.get<string>(SEED_KEY);
  if (!seedB64) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    seedB64 = btoa(String.fromCharCode(...seed));
    await storage.set(SEED_KEY, seedB64);
    return seed;
  }
  return Uint8Array.from(atob(seedB64), (c) => c.charCodeAt(0));
}

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const seed = await getOrCreateSeed();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    seed,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  cachedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(PBKDF2_SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return cachedKey;
}

async function getDb(): Promise<IDBDatabase> {
  if (cachedDb) return cachedDb;
  cachedDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'qid' });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return cachedDb;
}

export async function cacheGet(
  qid: string,
  expectedTgtLang: string
): Promise<CacheEntry | null> {
  try {
    const db = await getDb();
    const record = await new Promise<DbRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(qid);
      req.onsuccess = () => resolve(req.result as DbRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!record) return null;
    if (record.tgt_lang !== expectedTgtLang) return null;

    const key = await getKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      key,
      record.encrypted
    );
    return JSON.parse(new TextDecoder().decode(decrypted)) as CacheEntry;
  } catch (e) {
    console.warn('[zalo-bridge] cache get failed:', e);
    return null;
  }
}

export async function cacheSet(qid: string, entry: CacheEntry): Promise<void> {
  try {
    const db = await getDb();
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(entry))
    );

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put({
        qid,
        encrypted,
        iv: iv.buffer,
        tgt_lang: entry.tgt_lang,
        ts: Date.now(),
      } as DbRecord);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[zalo-bridge] cache set failed:', e);
  }
}

export async function cacheClear(): Promise<void> {
  try {
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    await storage.remove(SEED_KEY);
    cachedKey = null;
  } catch (e) {
    console.warn('[zalo-bridge] cache clear failed:', e);
  }
}

export async function cacheStats(): Promise<{ count: number; oldest_ts: number | null }> {
  try {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const count = countReq.result;
        if (count === 0) {
          resolve({ count: 0, oldest_ts: null });
          return;
        }
        const cursorReq = store.index('ts').openCursor(null, 'next');
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          resolve({ count, oldest_ts: cur ? (cur.value as DbRecord).ts : null });
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      };
      countReq.onerror = () => reject(countReq.error);
    });
  } catch {
    return { count: 0, oldest_ts: null };
  }
}
