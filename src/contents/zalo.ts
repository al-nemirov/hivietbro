// Plasmo content script — инжектится в chat.zalo.me
// Селекторы разведаны 2026-05-06, см. docs/zalo-dom.md

import type { PlasmoCSConfig } from 'plasmo';
import { translate as apiTranslate } from '../lib/api';
import { getToken, isEnabled } from '../lib/storage';
import { cacheGet, cacheSet } from '../lib/cache';
import {
  getOrInitChatSettings,
  setChatSettings,
  SUPPORTED_PARTNER_LANGS,
  type ChatSettings,
} from '../lib/chat-settings';

export const config: PlasmoCSConfig = {
  matches: ['https://chat.zalo.me/*'],
  all_frames: false,
  run_at: 'document_idle',
};

// === SELECTORS ==============================================================
const SEL = {
  messageContainer: '#messageViewScroll',
  messageBubble: '[data-component="bubble-message"]',
  messageText: '[data-component="message-text-content"]',
  inputField: '#richInput',
  sendButton: '.send-msg-btn',
};

const OUTGOING_CLASS = 'me';
const QID_HOST_SELECTOR = '[data-component="message-content-view"]';
// ============================================================================

const OVERLAY_CLASS = 'zb-overlay';
const OVERLAY_DATA_ATTR = 'data-zb-msg-id';
const STATUS_CLASS = 'zb-status';
const BANNER_CLASS = 'zb-banner';

let attachedMsgRoot: Element | null = null;
let msgObserver: MutationObserver | null = null;
let translationInFlight = false;
let outgoingHandlersAttached = false;

let currentChatKey: string | null = null;
let currentChatSettings: ChatSettings | null = null;

const pending = new Map<string, Promise<string>>();

async function bootstrap(): Promise<void> {
  if (!(await isEnabled())) return;
  const token = await getToken();
  if (!token) {
    console.info('[zalo-bridge] не залогинен — открой popup расширения');
    return;
  }

  injectStyles();
  attachOutgoingInterceptors();
  watchUI();
  console.info('[zalo-bridge] active');
}

function injectStyles(): void {
  if (document.getElementById('zb-styles')) return;
  const css = `
    @keyframes zb-fade-in {
      from { opacity: 0; transform: translateY(-2px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes zb-pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 0.8; }
    }

    .${OVERLAY_CLASS} {
      display: block;
      margin: 3px 0 0;
      padding: 5px 9px 5px 11px;
      background: transparent;
      border-left: 2px solid #4082ff;
      border-radius: 0 4px 4px 0;
      font-size: 12.5px;
      line-height: 1.45;
      color: #1d4ed8;
      white-space: pre-wrap;
      word-break: break-word;
      animation: zb-fade-in 0.2s ease-out;
      position: relative;
    }
    .${OVERLAY_CLASS}::before {
      content: 'RU';
      position: absolute;
      top: 4px;
      right: 6px;
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #94a3b8;
      opacity: 0.6;
      pointer-events: none;
    }
    .${OVERLAY_CLASS}[data-loading="1"] {
      animation: zb-pulse 1.2s ease-in-out infinite;
      color: #94a3b8;
      font-style: italic;
    }
    .${OVERLAY_CLASS}[data-error="1"] {
      border-left-color: #ef4444;
      color: #b91c1c;
      font-size: 11.5px;
    }
    .${OVERLAY_CLASS}[data-error="1"]::before { content: 'ERR'; color: #ef4444; }

    .${STATUS_CLASS} {
      position: fixed;
      bottom: 16px;
      right: 16px;
      padding: 8px 14px;
      background: rgba(26, 29, 36, 0.92);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #fff;
      border-radius: 18px;
      font: 500 12.5px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.1);
      z-index: 99999;
      pointer-events: none;
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 0.18s ease, transform 0.18s ease;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .${STATUS_CLASS}--show { opacity: 1; transform: translateY(0); }
    .${STATUS_CLASS}--error { background: rgba(185, 28, 28, 0.95); }
    .${STATUS_CLASS}__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4082ff;
      animation: zb-pulse 1s ease-in-out infinite;
      flex: 0 0 auto;
    }
    .${STATUS_CLASS}--success .${STATUS_CLASS}__dot { background: #10b981; animation: none; }
    .${STATUS_CLASS}--error .${STATUS_CLASS}__dot { background: #fca5a5; animation: none; }

    .${BANNER_CLASS} {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      background: linear-gradient(to bottom, #f7faff, #f0f4fb);
      border-bottom: 1px solid #e6e8ec;
      font: 500 12.5px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #475569;
      flex-shrink: 0;
      z-index: 5;
    }
    .${BANNER_CLASS}__title {
      flex: 0 0 auto;
      color: #475569;
    }
    .${BANNER_CLASS}__chat {
      font-weight: 600;
      color: #1a1d24;
    }
    .${BANNER_CLASS}__lang {
      flex: 0 0 auto;
      padding: 4px 10px;
      background: #fff;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      color: #1a1d24;
      transition: border-color 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .${BANNER_CLASS}__lang:hover { border-color: #4082ff; }
    .${BANNER_CLASS}__lang::after { content: '▾'; font-size: 9px; opacity: 0.5; margin-left: 2px; }
    .${BANNER_CLASS}__toggle {
      flex: 0 0 auto;
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }
    .${BANNER_CLASS}__switch {
      width: 32px;
      height: 18px;
      background: #cbd5e1;
      border-radius: 9px;
      position: relative;
      transition: background 0.15s ease;
      border: 0;
      padding: 0;
      cursor: pointer;
    }
    .${BANNER_CLASS}__switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 7px;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0,0,0,0.2);
      transition: left 0.15s ease;
    }
    .${BANNER_CLASS}--on .${BANNER_CLASS}__switch { background: #4082ff; }
    .${BANNER_CLASS}--on .${BANNER_CLASS}__switch::after { left: 16px; }
    .${BANNER_CLASS}__state {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      color: #94a3b8;
    }
    .${BANNER_CLASS}--on .${BANNER_CLASS}__state { color: #10b981; }

    .${BANNER_CLASS}__menu {
      position: absolute;
      top: calc(100% + 4px);
      background: #fff;
      border: 1px solid #e6e8ec;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.08);
      min-width: 180px;
      padding: 4px 0;
      z-index: 10;
    }
    .${BANNER_CLASS}__menu-item {
      display: block;
      width: 100%;
      padding: 8px 14px;
      background: transparent;
      border: 0;
      cursor: pointer;
      font: inherit;
      text-align: left;
      color: #1a1d24;
    }
    .${BANNER_CLASS}__menu-item:hover { background: #f3f4f6; }
    .${BANNER_CLASS}__menu-item--active { background: #e8f0ff; color: #1d4ed8; font-weight: 600; }
  `;
  const style = document.createElement('style');
  style.id = 'zb-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

// ===== INCOMING (read) ======================================================

function isOutgoing(bubble: Element): boolean {
  return bubble.classList.contains(OUTGOING_CLASS);
}

function getBubbleStableId(bubble: Element): string | null {
  const qid = bubble.querySelector(QID_HOST_SELECTOR)?.getAttribute('data-qid');
  if (qid) return qid;
  return bubble.id || null;
}

function extractText(bubble: Element): string {
  const t = bubble.querySelector(SEL.messageText);
  return (t?.textContent ?? '').trim();
}

function getChatKey(): string | null {
  const input = document.querySelector(SEL.inputField) as HTMLElement | null;
  return input?.dataset?.trailer || null;
}

async function loadCurrentChatSettings(): Promise<void> {
  const k = getChatKey();
  if (!k) {
    currentChatKey = null;
    currentChatSettings = null;
    return;
  }
  if (k === currentChatKey && currentChatSettings) return; // не меняли
  currentChatKey = k;
  currentChatSettings = await getOrInitChatSettings(k, k);
}

async function processBubble(bubble: Element): Promise<void> {
  if (isOutgoing(bubble)) return;
  if (bubble.querySelector(`[${OVERLAY_DATA_ATTR}]`)) return;
  if (!currentChatSettings || !currentChatSettings.enabled) return;

  const qid = getBubbleStableId(bubble);
  if (!qid) return;

  const text = extractText(bubble);
  if (!text) return;

  const srcLang = currentChatSettings.partner_lang;
  const tgtLang = currentChatSettings.preferred_lang;

  const target = bubble.querySelector('.message-content-wrapper') ?? bubble;
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.dataset.loading = '1';
  overlay.setAttribute(OVERLAY_DATA_ATTR, qid);
  overlay.textContent = '…';
  target.appendChild(overlay);

  try {
    const cached = await cacheGet(qid, srcLang, tgtLang);
    if (cached && cached.src_text === text) {
      overlay.textContent = cached.tgt_text;
      overlay.dataset.loading = '0';
      return;
    }

    let translation: string;
    const pendKey = `${qid}|${srcLang}|${tgtLang}`;
    if (pending.has(pendKey)) {
      translation = await pending.get(pendKey)!;
    } else {
      const p = (async () => {
        const result = await apiTranslate({
          text,
          source_lang: srcLang,
          target_lang: tgtLang,
          direction: 'incoming',
          chat_id: currentChatKey ?? undefined,
        });
        await cacheSet(qid, {
          src_text: text,
          src_lang: srcLang,
          tgt_text: result.translation,
          tgt_lang: tgtLang,
          ts: Date.now(),
        });
        return result.translation;
      })();
      pending.set(pendKey, p);
      try {
        translation = await p;
      } finally {
        pending.delete(pendKey);
      }
    }

    overlay.textContent = translation;
    overlay.dataset.loading = '0';
  } catch (err) {
    overlay.dataset.error = '1';
    overlay.dataset.loading = '0';
    overlay.textContent = `[ошибка перевода: ${(err as Error).message}]`;
  }
}

function rescanVisibleMessages(): void {
  if (!attachedMsgRoot) return;
  // Удаляем существующие overlay'и (если только что выключили перевод — они должны исчезнуть)
  if (!currentChatSettings?.enabled) {
    attachedMsgRoot.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
    return;
  }
  attachedMsgRoot.querySelectorAll(SEL.messageBubble).forEach((b) => void processBubble(b));
}

function attachMessageObserver(root: Element): void {
  if (attachedMsgRoot === root) return;
  if (msgObserver) {
    msgObserver.disconnect();
    msgObserver = null;
  }
  attachedMsgRoot = root;
  rescanVisibleMessages();

  msgObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n.matches(SEL.messageBubble)) {
          void processBubble(n);
        } else {
          n.querySelectorAll?.(SEL.messageBubble).forEach((b) => void processBubble(b));
        }
      });
    }
  });
  msgObserver.observe(root, { childList: true, subtree: true });
}

// ===== BANNER (per-chat settings UI) =======================================

function injectBanner(msgRoot: Element): void {
  // Ищем родителя scroll-контейнера и вставляем баннер выше
  const parent = msgRoot.parentElement;
  if (!parent) return;
  if (parent.querySelector(`.${BANNER_CLASS}`)) return;

  const banner = document.createElement('div');
  banner.className = BANNER_CLASS;
  parent.insertBefore(banner, msgRoot);
  renderBanner(banner);
}

function renderBanner(banner: HTMLElement): void {
  const s = currentChatSettings;
  const chatName = currentChatKey ?? '?';
  const langInfo = SUPPORTED_PARTNER_LANGS.find((l) => l.code === s?.partner_lang);
  const flagLabel = langInfo?.flag ?? s?.partner_lang.toUpperCase() ?? '?';

  banner.classList.toggle(`${BANNER_CLASS}--on`, !!s?.enabled);
  banner.innerHTML = `
    <span class="${BANNER_CLASS}__title">
      Перевод с <button class="${BANNER_CLASS}__lang" type="button">${flagLabel}</button> ↔ <strong>${(s?.preferred_lang ?? 'ru').toUpperCase()}</strong>
      &nbsp;·&nbsp; <span class="${BANNER_CLASS}__chat">${chatName}</span>
    </span>
    <label class="${BANNER_CLASS}__toggle">
      <span class="${BANNER_CLASS}__state">${s?.enabled ? 'ON' : 'OFF'}</span>
      <button class="${BANNER_CLASS}__switch" type="button"></button>
    </label>
  `;

  const langBtn = banner.querySelector(`.${BANNER_CLASS}__lang`) as HTMLButtonElement;
  langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openLangMenu(banner, langBtn);
  });

  const switchBtn = banner.querySelector(`.${BANNER_CLASS}__switch`) as HTMLButtonElement;
  switchBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentChatKey || !currentChatSettings) return;
    currentChatSettings = { ...currentChatSettings, enabled: !currentChatSettings.enabled };
    await setChatSettings(currentChatKey, currentChatSettings);
    renderBanner(banner);
    rescanVisibleMessages();
  });
}

function openLangMenu(banner: HTMLElement, anchor: HTMLElement): void {
  // закроем существующее меню
  banner.querySelector(`.${BANNER_CLASS}__menu`)?.remove();

  const menu = document.createElement('div');
  menu.className = `${BANNER_CLASS}__menu`;
  const rect = anchor.getBoundingClientRect();
  const bRect = banner.getBoundingClientRect();
  menu.style.left = `${rect.left - bRect.left}px`;

  for (const lang of SUPPORTED_PARTNER_LANGS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      `${BANNER_CLASS}__menu-item` +
      (lang.code === currentChatSettings?.partner_lang ? ` ${BANNER_CLASS}__menu-item--active` : '');
    btn.innerHTML = `<strong>${lang.flag}</strong> &nbsp; ${lang.label}`;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!currentChatKey || !currentChatSettings) return;
      currentChatSettings = { ...currentChatSettings, partner_lang: lang.code };
      await setChatSettings(currentChatKey, currentChatSettings);
      menu.remove();
      renderBanner(banner);
      rescanVisibleMessages();
    });
    menu.appendChild(btn);
  }
  banner.appendChild(menu);

  const close = (ev: MouseEvent): void => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

// ===== OUTGOING — перехват натуральной отправки ============================

function getStatus(): HTMLElement {
  let el = document.querySelector(`.${STATUS_CLASS}`) as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = STATUS_CLASS;
    el.innerHTML = `<span class="${STATUS_CLASS}__dot"></span><span class="${STATUS_CLASS}__text"></span>`;
    document.body.appendChild(el);
  }
  return el;
}

type StatusVariant = 'progress' | 'success' | 'error';

function showStatus(text: string, variant: StatusVariant = 'progress'): void {
  const el = getStatus();
  const textEl = el.querySelector(`.${STATUS_CLASS}__text`);
  if (textEl) textEl.textContent = text;
  el.classList.toggle(`${STATUS_CLASS}--success`, variant === 'success');
  el.classList.toggle(`${STATUS_CLASS}--error`, variant === 'error');
  el.classList.add(`${STATUS_CLASS}--show`);
}

function hideStatus(): void {
  const el = getStatus();
  el.classList.remove(`${STATUS_CLASS}--show`, `${STATUS_CLASS}--error`, `${STATUS_CLASS}--success`);
}

function attachOutgoingInterceptors(): void {
  if (outgoingHandlersAttached) return;
  outgoingHandlersAttached = true;

  document.addEventListener(
    'keydown',
    (e) => {
      if (translationInFlight) return;
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!currentChatSettings?.enabled) return; // если перевод выключен — не трогаем
      const input = document.querySelector(SEL.inputField) as HTMLElement | null;
      if (!input) return;
      if (!input.contains(e.target as Node)) return;
      const text = (input.textContent ?? '').trim();
      if (!text) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      void interceptAndSend(input, text);
    },
    true
  );

  document.addEventListener(
    'click',
    (e) => {
      if (translationInFlight) return;
      if (!currentChatSettings?.enabled) return;
      const btn = (e.target as Element)?.closest?.(SEL.sendButton) as HTMLElement | null;
      if (!btn) return;
      const input = document.querySelector(SEL.inputField) as HTMLElement | null;
      if (!input) return;
      const text = (input.textContent ?? '').trim();
      if (!text) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      void interceptAndSend(input, text);
    },
    true
  );
}

async function interceptAndSend(input: HTMLElement, ruText: string): Promise<void> {
  if (translationInFlight) return;
  if (!currentChatSettings) return;
  translationInFlight = true;
  showStatus('Перевожу…');

  try {
    const result = await apiTranslate({
      text: ruText,
      source_lang: currentChatSettings.preferred_lang,
      target_lang: currentChatSettings.partner_lang,
      direction: 'outgoing',
      chat_id: currentChatKey ?? undefined,
    });
    const vi = result.translation;
    if (!vi) throw new Error('пустой перевод');

    input.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, vi);

    await new Promise((r) => setTimeout(r, 80));

    const sendBtn = document.querySelector(SEL.sendButton) as HTMLElement | null;
    if (!sendBtn) throw new Error('кнопка отправки не найдена');
    sendBtn.click();

    showStatus('Отправлено', 'success');
    setTimeout(hideStatus, 1000);
  } catch (err) {
    console.error('[zalo-bridge] send failed:', err);
    showStatus(`Ошибка: ${(err as Error).message}`, 'error');
    setTimeout(hideStatus, 3500);
  } finally {
    translationInFlight = false;
  }
}

// ===== ROOT WATCHER =========================================================

function watchUI(): void {
  let lastChatKey: string | null = null;

  const tryAttach = async (): Promise<void> => {
    const msgRoot = document.querySelector(SEL.messageContainer);
    if (!msgRoot) return;

    // Перечитать настройки если ключ чата изменился
    const k = getChatKey();
    if (k !== lastChatKey) {
      lastChatKey = k;
      await loadCurrentChatSettings();
    }

    if (msgRoot !== attachedMsgRoot) attachMessageObserver(msgRoot);
    injectBanner(msgRoot);
    const banner = msgRoot.parentElement?.querySelector(`.${BANNER_CLASS}`) as HTMLElement | null;
    if (banner) renderBanner(banner);
  };

  void tryAttach();

  const bodyObs = new MutationObserver(() => {
    const root = document.querySelector(SEL.messageContainer);
    if (!root) {
      attachedMsgRoot = null;
      if (msgObserver) {
        msgObserver.disconnect();
        msgObserver = null;
      }
      return;
    }
    void tryAttach();
  });
  bodyObs.observe(document.body, { childList: true, subtree: true });
}

bootstrap().catch((e) => console.error('[zalo-bridge] bootstrap failed:', e));
