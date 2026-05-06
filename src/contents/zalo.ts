// Plasmo content script — инжектится в chat.zalo.me
// На текущем этапе селекторы — заглушки; будут заполнены после разведки DOM.
// См. docs/zalo-dom.md (создаётся в фазе разведки).

import type { PlasmoCSConfig } from 'plasmo';
import { translate as apiTranslate } from '../lib/api';
import { getToken, isEnabled } from '../lib/storage';

export const config: PlasmoCSConfig = {
  matches: ['https://chat.zalo.me/*'],
  all_frames: false,
  run_at: 'document_idle',
};

// === SELECTORS (TBD — заполнить после разведки DOM) =========================
// Найти после логина в Zalo Web с открытым диалогом.
const SEL = {
  // Контейнер списка сообщений в активном чате
  messageContainer: '[TBD-message-list-container]',
  // Один баббл сообщения (любой направления)
  messageBubble: '[TBD-message-bubble]',
  // Атрибут/класс, отличающий входящее от исходящего
  incomingMarker: '[TBD-incoming-class-or-attr]',
  // Текстовый узел внутри баббла
  messageText: '[TBD-text-inside-bubble]',
  // Поле ввода
  inputField: '[TBD-contenteditable-input]',
  // Кнопка отправки (если есть)
  sendButton: '[TBD-send-button]',
};
// ============================================================================

const PROCESSED = new WeakSet<Element>();
const OVERLAY_CLASS = 'zb-overlay';

interface UserSettings {
  preferred_lang: string;
  partner_lang: string;
}

let settings: UserSettings = { preferred_lang: 'ru', partner_lang: 'vi' };

async function bootstrap(): Promise<void> {
  if (!(await isEnabled())) return;
  const token = await getToken();
  if (!token) {
    console.info('[zalo-bridge] not signed in — open extension popup to log in');
    return;
  }

  // TODO: подгружать settings из /me
  injectStyles();
  observeMessages();
  // TODO: hijackInput() — после разведки DOM
}

function injectStyles(): void {
  const css = `
    .${OVERLAY_CLASS} {
      display: block;
      margin-top: 4px;
      padding: 6px 10px;
      background: rgba(64, 130, 255, 0.08);
      border-left: 3px solid #4082ff;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1.4;
      color: #1a3d8f;
      white-space: pre-wrap;
    }
    .${OVERLAY_CLASS}[data-loading="1"] {
      opacity: 0.5;
      font-style: italic;
    }
    .${OVERLAY_CLASS}[data-error="1"] {
      background: rgba(255, 64, 64, 0.08);
      border-left-color: #ff4040;
      color: #8f1a1a;
    }
  `;
  const style = document.createElement('style');
  style.id = 'zb-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function isIncoming(el: Element): boolean {
  // TBD после разведки. Stub:
  return el.matches(SEL.incomingMarker);
}

function extractText(bubble: Element): string {
  const t = bubble.querySelector(SEL.messageText);
  return (t?.textContent ?? '').trim();
}

async function processBubble(bubble: Element): Promise<void> {
  if (PROCESSED.has(bubble)) return;
  PROCESSED.add(bubble);

  const text = extractText(bubble);
  if (!text) return;

  // Переводим только входящие в фазе MVP
  if (!isIncoming(bubble)) return;

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.dataset.loading = '1';
  overlay.textContent = '…';
  bubble.appendChild(overlay);

  try {
    const result = await apiTranslate({
      text,
      source_lang: settings.partner_lang,
      target_lang: settings.preferred_lang,
      direction: 'incoming',
    });
    overlay.textContent = result.translation;
    overlay.dataset.loading = '0';
  } catch (err) {
    overlay.dataset.error = '1';
    overlay.dataset.loading = '0';
    overlay.textContent = `[ошибка перевода: ${(err as Error).message}]`;
  }
}

function observeMessages(): void {
  const root = document.querySelector(SEL.messageContainer);
  if (!root) {
    console.warn('[zalo-bridge] message container not found — селектор устарел?');
    // Ретрай через 1с — Zalo рендерит асинхронно
    setTimeout(observeMessages, 1000);
    return;
  }

  // Обработать уже отрисованные баблы
  root.querySelectorAll(SEL.messageBubble).forEach((b) => processBubble(b));

  // И слушать новые
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n.matches(SEL.messageBubble)) {
          processBubble(n);
        } else {
          n.querySelectorAll?.(SEL.messageBubble).forEach((b) => processBubble(b));
        }
      });
    }
  });
  obs.observe(root, { childList: true, subtree: true });
}

bootstrap().catch((e) => console.error('[zalo-bridge] bootstrap failed:', e));
