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
    @keyframes zb-fade-in {
      from { opacity: 0; transform: translateY(-2px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes zb-pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 0.8; }
    }
    @keyframes zb-slide-up {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
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
      letter-spacing: 0.1px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.1);
      z-index: 99999;
      pointer-events: none;
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 0.18s ease, transform 0.18s ease;
      max-width: 280px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .${STATUS_CLASS}--show {
      opacity: 1;
      transform: translateY(0);
    }
    .${STATUS_CLASS}--error {
      background: rgba(185, 28, 28, 0.95);
    }
    .${STATUS_CLASS}__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4082ff;
      animation: zb-pulse 1s ease-in-out infinite;
      flex: 0 0 auto;
    }
    .${STATUS_CLASS}--success .${STATUS_CLASS}__dot {
      background: #10b981;
      animation: none;
    }
    .${STATUS_CLASS}--error .${STATUS_CLASS}__dot {
      background: #fca5a5;
      animation: none;
    }
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
  el.classList.remove(
    `${STATUS_CLASS}--show`,
    `${STATUS_CLASS}--error`,
    `${STATUS_CLASS}--success`
  );
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
