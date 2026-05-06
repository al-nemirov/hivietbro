// Plasmo content script — инжектится в chat.zalo.me
// Селекторы разведаны 2026-05-06, см. docs/zalo-dom.md

import type { PlasmoCSConfig } from 'plasmo';
import { translate as apiTranslate } from '../lib/api';
import { getToken, isEnabled } from '../lib/storage';

export const config: PlasmoCSConfig = {
  matches: ['https://chat.zalo.me/*'],
  all_frames: false,
  run_at: 'document_idle',
};

// === SELECTORS ==============================================================
const SEL = {
  // Скролл-контейнер сообщений активного чата
  messageContainer: '#messageViewScroll',
  // Один баббл (исходящего или входящего сообщения)
  messageBubble: '[data-component="bubble-message"]',
  // Текст сообщения внутри баббла
  messageText: '[data-component="message-text-content"]',
  // Поле ввода (contenteditable)
  inputField: '#richInput',
  // Кнопка отправки (видна только если инпут не пустой)
  sendButton: '.send-msg-btn',
  // Активный чат в сайдбаре
  activeConvItem: '#conversationList .conv-item.selected',
};

// Outgoing помечен модификатором `me` на баббле
const OUTGOING_CLASS = 'me';

// Маркер сообщения с qid → используем как стабильный ID
const QID_HOST_SELECTOR = '[data-component="message-content-view"]';
// ============================================================================

const PROCESSED_IDS = new Set<string>();
const OVERLAY_CLASS = 'zb-overlay';
const OVERLAY_DATA_ATTR = 'data-zb-msg-id';

interface UserSettings {
  preferred_lang: string;
  partner_lang: string;
}

let settings: UserSettings = { preferred_lang: 'ru', partner_lang: 'vi' };

async function bootstrap(): Promise<void> {
  if (!(await isEnabled())) return;
  const token = await getToken();
  if (!token) {
    console.info('[zalo-bridge] не залогинен — открой popup расширения');
    return;
  }

  injectStyles();
  waitForChatAndAttach();
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

function isOutgoing(bubble: Element): boolean {
  return bubble.classList.contains(OUTGOING_CLASS);
}

function getBubbleStableId(bubble: Element): string | null {
  // Предпочитаем data-qid (стабильнее), fallback — id (bb_msg_id_<ts>)
  const qid = bubble.querySelector(QID_HOST_SELECTOR)?.getAttribute('data-qid');
  if (qid) return qid;
  return bubble.id || null;
}

function extractText(bubble: Element): string {
  const t = bubble.querySelector(SEL.messageText);
  return (t?.textContent ?? '').trim();
}

function getChatHash(): string | undefined {
  // Используем имя собеседника из data-trailer у инпута — стабильно для 1-1
  const input = document.querySelector(SEL.inputField) as HTMLElement | null;
  return input?.dataset?.trailer || undefined;
}

async function processBubble(bubble: Element): Promise<void> {
  const stableId = getBubbleStableId(bubble);
  if (!stableId) return;
  if (PROCESSED_IDS.has(stableId)) return;
  // Если этот же баббл уже имеет overlay (после ремоунта react-virtualized) — не трогаем
  if (bubble.querySelector(`[${OVERLAY_DATA_ATTR}]`)) {
    PROCESSED_IDS.add(stableId);
    return;
  }
  PROCESSED_IDS.add(stableId);

  const text = extractText(bubble);
  if (!text) return;

  // MVP: переводим только входящие
  if (isOutgoing(bubble)) return;

  // Точка вставки overlay — внутрь .message-content-wrapper, под текст,
  // но проще всего — в самый баббл `[data-component="bubble-message"]`,
  // визуально под текстом сообщения
  const target = bubble.querySelector('.message-content-wrapper') ?? bubble;

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.dataset.loading = '1';
  overlay.setAttribute(OVERLAY_DATA_ATTR, stableId);
  overlay.textContent = '…';
  target.appendChild(overlay);

  try {
    const result = await apiTranslate({
      text,
      source_lang: settings.partner_lang,
      target_lang: settings.preferred_lang,
      direction: 'incoming',
      chat_id: getChatHash(),
    });
    overlay.textContent = result.translation;
    overlay.dataset.loading = '0';
  } catch (err) {
    overlay.dataset.error = '1';
    overlay.dataset.loading = '0';
    overlay.textContent = `[ошибка перевода: ${(err as Error).message}]`;
  }
}

function attachObserver(root: Element): void {
  // Обработать уже отрисованные баблы
  root.querySelectorAll(SEL.messageBubble).forEach((b) => {
    void processBubble(b);
  });

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n.matches(SEL.messageBubble)) {
          void processBubble(n);
        } else {
          n.querySelectorAll?.(SEL.messageBubble).forEach((b) => {
            void processBubble(b);
          });
        }
      });
    }
  });
  obs.observe(root, { childList: true, subtree: true });
  console.info('[zalo-bridge] observer attached');
}

function waitForChatAndAttach(): void {
  // Zalo рендерит chat-area асинхронно после загрузки. Ждём появления контейнера.
  const tryAttach = (): boolean => {
    const root = document.querySelector(SEL.messageContainer);
    if (root) {
      attachObserver(root);
      return true;
    }
    return false;
  };

  if (tryAttach()) return;

  // Watcher на body — ждём, когда #messageViewScroll появится
  const bodyObs = new MutationObserver(() => {
    if (tryAttach()) bodyObs.disconnect();
  });
  bodyObs.observe(document.body, { childList: true, subtree: true });

  // Также — на смену активного чата #messageViewScroll может пересоздаться,
  // тогда нужен новый observer. Но это покроется тем же body-watcher'ом.
  // (TODO: оптимизировать — не пересоздавать observer на каждом switch'е чата)
}

bootstrap().catch((e) => console.error('[zalo-bridge] bootstrap failed:', e));
