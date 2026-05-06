// Plasmo MV3 service worker — auth через chrome.identity.launchWebAuthFlow
// + единое хранилище кэша (IDB здесь, доступ через messaging из popup и content script)
import { exchangeGoogleCode } from './lib/api';
import { setToken, setUser } from './lib/storage';
import { cacheGet, cacheSet, cacheClear, cacheStats } from './lib/cache';

const GOOGLE_CLIENT_ID = process.env.PLASMO_PUBLIC_GOOGLE_CLIENT_ID ?? '';
const SCOPES = ['openid', 'email', 'profile'];

async function startGoogleOAuth(): Promise<{ ok: boolean; user?: unknown; error?: string }> {
  if (!GOOGLE_CLIENT_ID) {
    return { ok: false, error: 'PLASMO_PUBLIC_GOOGLE_CLIENT_ID не задан в .env' };
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID();
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      access_type: 'online',
      prompt: 'select_account',
      state,
    }).toString();

  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'no responseUrl' });
        return;
      }
      try {
        const url = new URL(responseUrl);
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        if (!code) {
          resolve({ ok: false, error: 'no code in callback' });
          return;
        }
        if (returnedState !== state) {
          resolve({ ok: false, error: 'state mismatch (CSRF)' });
          return;
        }
        const result = await exchangeGoogleCode(code, redirectUri);
        await setToken(result.token);
        await setUser(result.user);
        resolve({ ok: true, user: result.user });
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message });
      }
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'login': {
          const result = await startGoogleOAuth();
          sendResponse(result);
          return;
        }
        case 'cache.get': {
          const entry = await cacheGet(msg.qid, msg.src_lang, msg.tgt_lang);
          sendResponse(entry);
          return;
        }
        case 'cache.set': {
          await cacheSet(msg.qid, msg.entry);
          sendResponse({ ok: true });
          return;
        }
        case 'cache.clear': {
          await cacheClear();
          sendResponse({ ok: true });
          return;
        }
        case 'cache.stats': {
          const stats = await cacheStats();
          sendResponse(stats);
          return;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message: ' + msg?.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message });
    }
  })();
  return true; // async response
});
