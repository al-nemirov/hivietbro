// Plasmo content script — инжектится в chat.zalo.me
// Селекторы разведаны 2026-05-06, см. docs/zalo-dom.md

import type { PlasmoCSConfig } from 'plasmo';
import { translate as apiTranslate } from '../lib/api';
import { getToken, isEnabled } from '../lib/storage';
import { cacheGet, cacheSet } from '../lib/cache';

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
  inputContent: '.chat-input-content',
  sendButton: '.send-msg-btn',
};

const OUTGOING_CLASS = 'me';
const QID_HOST_SELECTOR = '[data-component="message-content-view"]';
// ============================================================================

const OVERLAY_CLASS = 'zb-overlay';
const OVERLAY_DATA_ATTR = 'data-zb-msg-id';
const STATUS_CLASS = 'zb-status';

interface UserSettings {
  preferred_lang: string;
  partner_lang: string;
}

let settings: UserSettings = { preferred_lang: 'ru', partner_lang: 'vi' };

let attachedMsgRoot: Element | null = null;
let msgObserver: MutationObserver | null = null;
let translationInFlight = false;
let outgoingHandlersAttached = false;

// Дедуп параллельных переводов одного и того же qid (если ремоунт случился во время сетевого запроса)
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
    .${OVERLAY_CLASS} {
      display: block;
      margin: 4px 0 0;
      padding: 6px 10px;
      background: rgba(64, 130, 255, 0.08);
      border-left: 3px solid #4082ff;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1.4;
      color: #1a3d8f;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .${OVERLAY_CLASS}[data-loading="1"] { opacity: 0.5; font-style: italic; }
    .${OVERLAY_CLASS}[data-error="1"] {
      background: rgba(255, 64, 64, 0.08);
      border-left-color: #ff4040;
      color: #8f1a1a;
    }
    .${STATUS_CLASS} {
      position: fixed;
      bottom: 8px;
      right: 16px;
      padding: 6px 12px;
      background: #4082ff;
      color: #fff;
      border-radius: 16px;
      font: 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      z-index: 99999;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .${STATUS_CLASS}--show { opacity: 1; }
    .${STATUS_CLASS}--error { background: #ff4040; }
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

function getChatHash(): string | undefined {
  const input = document.querySelector(SEL.inputField) as HTMLElement | null;
  return input?.dataset?.trailer || undefined;
}

async function processBubble(bubble: Element): Promise<void> {
  if (isOutgoing(bubble)) return;
  // Если на этом DOM-узле уже есть наш overlay — не дублируем
  if (bubble.querySelector(`[${OVERLAY_DATA_ATTR}]`)) return;

  const qid = getBubbleStableId(bubble);
  if (!qid) return;

  const text = extractText(bubble);
  if (!text) return;

  const target = bubble.querySelector('.message-content-wrapper') ?? bubble;
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.dataset.loading = '1';
  overlay.setAttribute(OVERLAY_DATA_ATTR, qid);
  overlay.textContent = '…';
  target.appendChild(overlay);

  try {
    // 1. Локальный кэш (IDB + AES-GCM): мгновенно для уже виденных сообщений
    const cached = await cacheGet(qid, settings.preferred_lang);
    if (cached && cached.src_text === text) {
      overlay.textContent = cached.tgt_text;
      overlay.dataset.loading = '0';
      return;
    }

    // 2. In-flight дедуп: при ремоунте во время сетевого запроса не плодим параллельных
    let translation: string;
    if (pending.has(qid)) {
      translation = await pending.get(qid)!;
    } else {
      const p = (async () => {
        const result = await apiTranslate({
          text,
          source_lang: settings.partner_lang,
          target_lang: settings.preferred_lang,
          direction: 'incoming',
          chat_id: getChatHash(),
        });
        // Сохраняем в локальный кэш — следующий раз будет мгновенно
        await cacheSet(qid, {
          src_text: text,
          src_lang: settings.partner_lang,
          tgt_text: result.translation,
          tgt_lang: settings.preferred_lang,
          ts: Date.now(),
        });
        return result.translation;
      })();
      pending.set(qid, p);
      try {
        translation = await p;
      } finally {
        pending.delete(qid);
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

function attachMessageObserver(root: Element): void {
  if (attachedMsgRoot === root) return; // тот же узел, обзёрвер уже стоит
  if (msgObserver) {
    msgObserver.disconnect();
    msgObserver = null;
  }
  attachedMsgRoot = root;

  // Обработать уже отрисованные баблы
  root.querySelectorAll(SEL.messageBubble).forEach((b) => void processBubble(b));

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
  console.info('[zalo-bridge] message observer attached on', root);
}

// ===== OUTGOING — перехват натуральной отправки ============================

function getStatus(): HTMLElement {
  let el = document.querySelector(`.${STATUS_CLASS}`) as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = STATUS_CLASS;
    document.body.appendChild(el);
  }
  return el;
}

function showStatus(text: string, isError = false): void {
  const el = getStatus();
  el.textContent = text;
  el.classList.toggle(`${STATUS_CLASS}--error`, isError);
  el.classList.add(`${STATUS_CLASS}--show`);
}

function hideStatus(): void {
  const el = getStatus();
  el.classList.remove(`${STATUS_CLASS}--show`, `${STATUS_CLASS}--error`);
}

function attachOutgoingInterceptors(): void {
  if (outgoingHandlersAttached) return;
  outgoingHandlersAttached = true;

  document.addEventListener(
    'keydown',
    (e) => {
      if (translationInFlight) return;
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
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

  console.info('[zalo-bridge] outgoing interceptors attached');
}

async function interceptAndSend(input: HTMLElement, ruText: string): Promise<void> {
  if (translationInFlight) return;
  translationInFlight = true;
  showStatus('Перевожу…');

  try {
    const result = await apiTranslate({
      text: ruText,
      source_lang: settings.preferred_lang,
      target_lang: settings.partner_lang,
      direction: 'outgoing',
      chat_id: getChatHash(),
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

    showStatus('Отправлено ✓');
    setTimeout(hideStatus, 800);
  } catch (err) {
    console.error('[zalo-bridge] send failed:', err);
    showStatus(`Ошибка: ${(err as Error).message}`, true);
    setTimeout(hideStatus, 3500);
  } finally {
    translationInFlight = false;
  }
}

// ===== ROOT WATCHER =========================================================

function watchUI(): void {
  const tryAttach = (): void => {
    const msgRoot = document.querySelector(SEL.messageContainer);
    if (msgRoot) attachMessageObserver(msgRoot);
  };

  tryAttach();

  // body-watcher: переключения чатов, медленный SPA-рендер.
  // attachMessageObserver сам решает, нужно ли передёрнуть observer (другой узел?)
  const bodyObs = new MutationObserver(() => {
    const root = document.querySelector(SEL.messageContainer);
    if (!root) {
      // контейнера сейчас нет — забудем старый узел
      attachedMsgRoot = null;
      if (msgObserver) {
        msgObserver.disconnect();
        msgObserver = null;
      }
      return;
    }
    tryAttach();
  });
  bodyObs.observe(document.body, { childList: true, subtree: true });
}

bootstrap().catch((e) => console.error('[zalo-bridge] bootstrap failed:', e));
