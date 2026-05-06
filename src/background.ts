// Plasmo MV3 service worker — обрабатывает OAuth flow и сообщения от popup/content
import { exchangeGoogleCode } from './lib/api';
import { setToken, setUser } from './lib/storage';
import { DASHBOARD_URL } from './lib/config';

// На MV3 background — это service worker, без window.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'login') {
        // Открываем dashboard для OAuth — он редиректит обратно в расширение
        const redirectUri = chrome.identity.getRedirectURL('google');
        await chrome.tabs.create({ url: `${DASHBOARD_URL}/auth/start?ext_redirect=${encodeURIComponent(redirectUri)}` });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'oauth_callback') {
        // Альтернативный flow: dashboard передаёт code прямо в extension через postMessage
        const { code, redirect_uri } = msg;
        const result = await exchangeGoogleCode(code, redirect_uri);
        await setToken(result.token);
        await setUser(result.user);
        sendResponse({ ok: true, user: result.user });
        return;
      }

      sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message });
    }
  })();
  return true; // async response
});

// При первой установке открыть welcome
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: `${DASHBOARD_URL}/welcome` });
  }
});
