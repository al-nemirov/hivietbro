// Plasmo content script — инжектится в chat.zalo.me
// Селекторы разведаны 2026-05-06, см. docs/zalo-dom.md

import type { PlasmoCSConfig } from 'plasmo';
import { Storage } from '@plasmohq/storage';
import LOGO_URL from 'data-base64:~assets/icon.png';
import { translate as apiTranslate, pullChatsFromServer, pushChatsToServer } from '../lib/api';
import { getToken, isEnabled } from '../lib/storage';
import { cacheGet, cacheSet } from '../lib/cache-client';
import {
  getOrInitChatSettings,
  getChatSettings,
  setChatSettings,
  migrateChatSettings,
  getLastSyncTs,
  setLastSyncTs,
  SUPPORTED_PARTNER_LANGS,
  SUPPORTED_PREFERRED_LANGS,
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
const CHIP_CLASS = 'zb-chip';
const TOOLTIP_CLASS = 'zb-tooltip';
const PREVIEW_CLASS = 'zb-preview';

const STORAGE_CHIP_POSITION = 'zb_chip_position';
const STORAGE_ONBOARD_SEEN = 'zb_onboard_seen';

const localStorage_ = new Storage();

let attachedMsgRoot: Element | null = null;
let msgObserver: MutationObserver | null = null;
let translationInFlight = false;
let outgoingHandlersAttached = false;

let currentChatKey: string | null = null;
let currentChatDisplayName: string | null = null;
let currentChatSettings: ChatSettings | null = null;

const pending = new Map<string, Promise<string>>();

// ===== EXTENSION CONTEXT GUARD ==============================================
// После reload'а расширения старый content script остаётся в открытой вкладке,
// но все chrome.* API уже мёртвы. Без проверки получим спам "Extension context
// invalidated" в консоли при каждом MutationObserver tick'е.

let contextDead = false;

function isContextValid(): boolean {
  if (contextDead) return false;
  try {
    return !!chrome.runtime?.id;
  } catch {
    contextDead = true;
    return false;
  }
}

function markContextDead(): void {
  if (contextDead) return;
  contextDead = true;
  console.info('[zalo-bridge] extension reloaded — content script disabled until page refresh');
  // Отключаем все наши observers
  if (msgObserver) {
    try {
      msgObserver.disconnect();
    } catch {}
    msgObserver = null;
  }
  if (bodyObserver) {
    try {
      bodyObserver.disconnect();
    } catch {}
    bodyObserver = null;
  }
  // Скрываем чип чтобы пользователь не пытался кликать на мертвый UI
  const chip = document.querySelector(`.${CHIP_CLASS}`);
  if (chip) (chip as HTMLElement).style.display = 'none';
}

// Перехватываем глобальные unhandled rejection и errors с этим текстом
window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  const msg = (ev.reason instanceof Error ? ev.reason.message : String(ev.reason)) ?? '';
  if (msg.includes('Extension context invalidated') || msg.includes('Extension context was invalidated')) {
    ev.preventDefault();
    markContextDead();
  }
});
window.addEventListener('error', (ev: ErrorEvent) => {
  const msg = ev.message ?? '';
  if (msg.includes('Extension context invalidated') || msg.includes('Extension context was invalidated')) {
    ev.preventDefault();
    markContextDead();
  }
});

let bodyObserver: MutationObserver | null = null;

async function bootstrap(): Promise<void> {
  if (!(await isEnabled())) return;
  const token = await getToken();
  if (!token) {
    console.info('[zalo-bridge] не залогинен — открой popup расширения');
    return;
  }

  injectStyles();
  attachOutgoingInterceptors();

  // Сначала синхронизация с сервером (await) — чтобы настройки активного
  // чата уже были в chrome.storage до первого render'а чипа. Без этого
  // чип может мелькнуть в дефолтном OFF до того как sync подтянет ON.
  // Таймаут 3с чтобы не блокировать UI если сервер тормозит.
  try {
    await Promise.race([
      syncFromServer(),
      new Promise((res) => setTimeout(res, 3000)),
    ]);
  } catch (e) {
    console.warn('[zalo-bridge] sync from server failed:', e);
  }

  watchUI();
  console.info('[zalo-bridge] active');
}

// ===== LANGUAGE DETECTION ===================================================

/**
 * Определяет язык текста по символам.
 * Покрывает русский, вьетнамский (с диакритикой и без), английский.
 */
const VI_DIACRITIC_RE =
  /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ]/;
const VI_COMMON_RE =
  /\b(không|được|là|tôi|bạn|anh|em|chị|ơi|tao|mày|gì|của|cái|này|đó|và|hay|với|cho|một|hai|ba|năm|sao|đi|làm|ngày|hôm|bao|nhiêu|rồi|còn|đã|sẽ|đang|đâu|nào|khi|thế)\b/i;
const CYRILLIC_RE = /[Ѐ-ӿ]/;
const HANGUL_RE = /[가-힯ᄀ-ᇿ㄰-㆏]/;
const HIRAGANA_KATAKANA_RE = /[぀-ヿ]/;
const CJK_RE = /[一-鿿]/;

function detectLang(text: string): string {
  const t = text.trim();
  if (!t) return 'unknown';

  let cyr = 0,
    latin = 0,
    han = 0,
    kana = 0,
    cjk = 0,
    total = 0;
  for (const ch of t) {
    if (/\p{Letter}/u.test(ch)) {
      total++;
      if (CYRILLIC_RE.test(ch)) cyr++;
      else if (HANGUL_RE.test(ch)) han++;
      else if (HIRAGANA_KATAKANA_RE.test(ch)) kana++;
      else if (CJK_RE.test(ch)) cjk++;
      else if (/[a-zA-Z]/.test(ch)) latin++;
    }
  }
  if (total === 0) return 'unknown';

  // Доминирующий скрипт
  if (cyr / total > 0.5) return 'ru';
  if (han / total > 0.3) return 'ko';
  if (kana / total > 0.2) return 'ja';
  if (cjk / total > 0.5) return 'zh';

  // Вьетнамский: диакритика или характерные слова
  if (VI_DIACRITIC_RE.test(t)) return 'vi';
  if (VI_COMMON_RE.test(t)) return 'vi';

  // Латиница без VI-сигналов — английский
  if (latin / total > 0.5) return 'en';

  return 'unknown';
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
    @keyframes zb-pop {
      from { opacity: 0; transform: translateY(6px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes zb-bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
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
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .${OVERLAY_CLASS}:hover { background: rgba(64, 130, 255, 0.05); }
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
    .${OVERLAY_CLASS}[data-mode="original"] {
      color: #475569;
      font-style: italic;
    }
    .${OVERLAY_CLASS}[data-mode="original"]::before { content: 'ORIG'; }
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
      left: 50%;
      transform: translate(-50%, 12px);
      padding: 8px 14px;
      background: rgba(26, 29, 36, 0.92);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #fff;
      border-radius: 18px;
      font: 500 12.5px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.1);
      z-index: 999998;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.18s ease, transform 0.18s ease;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .${STATUS_CLASS}--show { opacity: 1; transform: translate(-50%, 0); }
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

    /* Floating chip — draggable */
    .${CHIP_CLASS} {
      position: fixed;
      right: 20px;
      bottom: 100px;
      z-index: 999997;
      font: 500 12.5px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: zb-pop 0.18s ease-out;
      touch-action: none;
      user-select: none;
    }
    .${CHIP_CLASS}__btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      background: #fff;
      border: 1px solid #e6e8ec;
      border-radius: 22px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.05);
      cursor: grab;
      color: #1a1d24;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
      font: inherit;
    }
    .${CHIP_CLASS}__btn:hover { border-color: #4082ff; box-shadow: 0 4px 20px rgba(64, 130, 255, 0.18); }
    .${CHIP_CLASS}--dragging .${CHIP_CLASS}__btn { cursor: grabbing; box-shadow: 0 8px 28px rgba(64, 130, 255, 0.25); }
    .${CHIP_CLASS}__dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #cbd5e1; flex: 0 0 auto;
    }
    .${CHIP_CLASS}--on .${CHIP_CLASS}__dot { background: #10b981; }
    .${CHIP_CLASS}--on .${CHIP_CLASS}__btn { border-color: #d1ddf4; background: #f7faff; }
    .${CHIP_CLASS}__lang { font-weight: 700; letter-spacing: 0.3px; color: #4082ff; }
    .${CHIP_CLASS}--off .${CHIP_CLASS}__lang { color: #94a3b8; }

    .${CHIP_CLASS}__menu {
      position: absolute;
      width: 280px;
      background: #fff;
      border: 1px solid #e6e8ec;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04);
      padding: 10px;
      animation: zb-pop 0.15s ease-out;
    }
    .${CHIP_CLASS}__lang-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px;
    }
    .${CHIP_CLASS}__menu-header {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: #94a3b8; padding: 4px 6px 6px;
    }
    .${CHIP_CLASS}__row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 6px; cursor: pointer; border-radius: 6px;
    }
    .${CHIP_CLASS}__row:hover { background: #f8fafc; }
    .${CHIP_CLASS}__row strong { color: #1a1d24; font-weight: 500; }
    .${CHIP_CLASS}__chat-name {
      font-size: 11px; color: #94a3b8; padding: 0 6px 6px;
      max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .${CHIP_CLASS}__divider { height: 1px; background: #f0f2f5; margin: 6px -10px; }
    .${CHIP_CLASS}__lang-row {
      display: flex; align-items: center; gap: 8px; padding: 8px 6px;
      cursor: pointer; border-radius: 6px; color: #1a1d24;
    }
    .${CHIP_CLASS}__lang-row:hover { background: #f8fafc; }
    .${CHIP_CLASS}__lang-row--active {
      background: #e8f0ff; color: #1d4ed8; font-weight: 600;
    }
    .${CHIP_CLASS}__lang-tag {
      flex: 0 0 28px; font-weight: 700; font-size: 11px; letter-spacing: 0.4px;
      color: #4082ff; padding: 3px 0; text-align: center;
      border: 1px solid #d1ddf4; background: #f0f7ff; border-radius: 4px;
    }
    .${CHIP_CLASS}__switch {
      position: relative; width: 36px; height: 20px;
      background: #cbd5e1; border-radius: 10px;
      border: 0; padding: 0; cursor: pointer;
      transition: background 0.15s ease; flex: 0 0 auto;
    }
    .${CHIP_CLASS}__switch::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 16px; height: 16px; border-radius: 8px;
      background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      transition: left 0.15s ease;
    }
    .${CHIP_CLASS}__switch[data-on="1"] { background: #10b981; }
    .${CHIP_CLASS}__switch[data-on="1"]::after { left: 18px; }
    .${CHIP_CLASS}__hint {
      font-size: 10px; color: #94a3b8;
      padding: 0 6px 4px; line-height: 1.3;
    }

    /* Onboarding tooltip */
    .${TOOLTIP_CLASS} {
      position: fixed;
      background: #1a1d24;
      color: #fff;
      padding: 10px 14px;
      border-radius: 10px;
      font: 500 12.5px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,0.2);
      z-index: 999996;
      max-width: 240px;
      animation: zb-bounce 1.6s ease-in-out infinite;
      pointer-events: auto;
    }
    .${TOOLTIP_CLASS}::after {
      content: '';
      position: absolute;
      bottom: -8px;
      right: 24px;
      width: 0; height: 0;
      border-left: 8px solid transparent;
      border-right: 8px solid transparent;
      border-top: 8px solid #1a1d24;
    }
    .${TOOLTIP_CLASS}__close {
      display: inline-block;
      margin-top: 6px;
      font-size: 11px;
      color: #93c5fd;
      cursor: pointer;
      text-decoration: underline;
    }

    /* Outgoing preview */
    .${PREVIEW_CLASS} {
      position: fixed;
      bottom: 100px;
      left: 50%;
      transform: translateX(-50%);
      max-width: 480px;
      width: calc(100vw - 60px);
      background: rgba(26, 29, 36, 0.96);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #fff;
      padding: 14px 16px;
      border-radius: 12px;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 16px 40px rgba(0,0,0,0.25);
      z-index: 999998;
      animation: zb-pop 0.15s ease-out;
    }
    .${PREVIEW_CLASS}__label {
      font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
      color: #93c5fd; text-transform: uppercase; margin-bottom: 4px;
    }
    .${PREVIEW_CLASS}__text {
      font-size: 14px; line-height: 1.5; word-break: break-word;
      white-space: pre-wrap;
    }
    .${PREVIEW_CLASS}__row {
      margin-top: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .${PREVIEW_CLASS}__hint {
      font-size: 11px; color: #94a3b8;
    }
    .${PREVIEW_CLASS}__btn {
      padding: 6px 12px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.05);
      color: #fff;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }
    .${PREVIEW_CLASS}__btn--primary {
      background: #4082ff; border-color: #4082ff;
    }
    .${PREVIEW_CLASS}__btn--primary:hover { background: #2a6bea; }
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

/** Извлекает стабильный contactId из qid. Формат: <id>@<msgId>... или <id>_xxx@... */
function extractContactIdFromQid(qid: string): string | null {
  const m = qid.match(/^(\d+)/);
  return m ? m[1] : null;
}

// Cache: trailer (имя контакта) → последний известный качественный chat key.
// Когда qid видим — учим связь. Когда qid временно пропадает (скролл),
// возвращаем закэшированный ключ, чтобы chat key не «прыгал» c:↔t:.
const trailerToChatKey = new Map<string, string>();

/**
 * Находит стабильный chat key:
 *   - data-qid префикс ANY видимого баббла (стабильный contactId Zalo) — учим cache
 *   - fallback: cached `c:contactId` для известного trailer'а
 *   - fallback: `t:trailer` (только если ни разу не видели qid этого чата)
 */
function findChatKey(): { key: string | null; displayName: string | null } {
  const input = document.querySelector(SEL.inputField) as HTMLElement | null;
  const trailer = input?.dataset?.trailer ?? null;

  // Найти любой data-qid на видимых баблах
  const anyQidEl = document.querySelector(`${SEL.messageBubble} ${QID_HOST_SELECTOR}`);
  const qid = anyQidEl?.getAttribute('data-qid');
  const contactId = qid ? extractContactIdFromQid(qid) : null;

  if (contactId) {
    const key = `c:${contactId}`;
    if (trailer) trailerToChatKey.set(trailer, key); // запоминаем
    return { key, displayName: trailer };
  }
  // qid отсутствует — пробуем закэшированный c:
  if (trailer) {
    const cached = trailerToChatKey.get(trailer);
    if (cached) return { key: cached, displayName: trailer };
    return { key: `t:${trailer}`, displayName: trailer };
  }
  return { key: null, displayName: null };
}

async function loadCurrentChatSettings(): Promise<void> {
  const { key, displayName } = findChatKey();
  if (!key) {
    // НЕ обнуляем существующее состояние — это может быть transient
    // (Zalo во время re-render'а убирает все qid). Если чат реально
    // закрыт, tick детектит это через 3 null-msgRoot подряд.
    return;
  }
  if (key === currentChatKey && currentChatSettings) return;

  currentChatKey = key;
  currentChatDisplayName = displayName ?? key;

  // Миграция: если у нас новый ключ "c:<id>" но настройки лежат под старым "t:<trailer>"
  if (key.startsWith('c:') && displayName) {
    const oldKey = `t:${displayName}`;
    await migrateChatSettings(key, oldKey);
  }

  currentChatSettings = await getOrInitChatSettings(key, displayName ?? undefined);
}

async function processBubble(bubble: Element): Promise<void> {
  if (!isContextValid()) return;
  if (isOutgoing(bubble)) return;
  if (!currentChatSettings || !currentChatSettings.enabled) return;

  const qid = getBubbleStableId(bubble);
  if (!qid) return;

  // Smart dedup: ReactVirtualized переиспользует DOM-узлы при скролле истории.
  // Один и тот же bubble может содержать разные сообщения в разное время.
  // Сравниваем qid — если не совпадает, удаляем старый overlay и обрабатываем заново.
  const existingOverlay = bubble.querySelector(`[${OVERLAY_DATA_ATTR}]`);
  if (existingOverlay) {
    const existingQid = existingOverlay.getAttribute(OVERLAY_DATA_ATTR);
    if (existingQid === qid) return; // тот же баббл с тем же qid — уже обработан
    existingOverlay.remove(); // переиспользован под другой qid — снести стейл
  }

  const text = extractText(bubble);
  if (!text) return;

  // Авто-детект: если входящее сообщение уже на языке пользователя — не переводим
  const detected = detectLang(text);
  const tgtLang = currentChatSettings.preferred_lang;
  if (detected === tgtLang) return;

  // Используем определённый язык как src; если не определилось — берём конфиг чата
  const srcLang = detected !== 'unknown' ? detected : currentChatSettings.partner_lang;

  const target = bubble.querySelector('.message-content-wrapper') ?? bubble;
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.dataset.loading = '1';
  overlay.dataset.mode = 'translation';
  overlay.dataset.original = text;
  overlay.setAttribute(OVERLAY_DATA_ATTR, qid);
  overlay.textContent = '…';
  // toggle original on click
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = overlay.dataset.mode ?? 'translation';
    if (cur === 'translation') {
      overlay.dataset.savedTranslation = overlay.textContent ?? '';
      overlay.dataset.mode = 'original';
      overlay.textContent = overlay.dataset.original ?? '';
    } else {
      overlay.dataset.mode = 'translation';
      overlay.textContent = overlay.dataset.savedTranslation ?? overlay.textContent ?? '';
    }
  });
  target.appendChild(overlay);

  try {
    const cached = await cacheGet(qid, srcLang, tgtLang);
    if (cached && cached.src_text === text) {
      overlay.textContent = cached.tgt_text;
      overlay.dataset.savedTranslation = cached.tgt_text;
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
    overlay.dataset.savedTranslation = translation;
    overlay.dataset.loading = '0';
  } catch (err) {
    overlay.dataset.error = '1';
    overlay.dataset.loading = '0';
    overlay.textContent = `[ошибка: ${(err as Error).message}]`;
  }
}

function rescanVisibleMessages(): void {
  if (!attachedMsgRoot) return;
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

// ===== FLOATING CHIP (DRAGGABLE) ============================================

function ensureChip(): HTMLElement {
  let chip = document.querySelector(`.${CHIP_CLASS}`) as HTMLElement | null;
  if (chip) return chip;
  chip = document.createElement('div');
  chip.className = CHIP_CLASS;
  document.body.appendChild(chip);
  void restoreChipPosition(chip);
  return chip;
}

async function restoreChipPosition(chip: HTMLElement): Promise<void> {
  const pos = await localStorage_.get<{ left: number; top: number }>(STORAGE_CHIP_POSITION);
  if (!pos) return;
  // clamp to viewport
  const left = Math.max(0, Math.min(window.innerWidth - 200, pos.left));
  const top = Math.max(0, Math.min(window.innerHeight - 50, pos.top));
  chip.style.left = `${left}px`;
  chip.style.top = `${top}px`;
  chip.style.right = 'auto';
  chip.style.bottom = 'auto';
}

function attachDragHandlers(chip: HTMLElement): void {
  const btn = chip.querySelector(`.${CHIP_CLASS}__btn`) as HTMLElement | null;
  if (!btn || btn.dataset.zbDrag === '1') return;
  btn.dataset.zbDrag = '1';

  let dragStart: { x: number; y: number; startLeft: number; startTop: number } | null = null;
  let isDragging = false;

  btn.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    const rect = chip.getBoundingClientRect();
    dragStart = { x: e.clientX, y: e.clientY, startLeft: rect.left, startTop: rect.top };
    isDragging = false;
    btn.setPointerCapture(e.pointerId);
  });

  btn.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (!isDragging && Math.hypot(dx, dy) > 5) {
      isDragging = true;
      chip.classList.add(`${CHIP_CLASS}--dragging`);
      // переключаем с right/bottom на left/top
      chip.style.right = 'auto';
      chip.style.bottom = 'auto';
    }
    if (isDragging) {
      const left = Math.max(0, Math.min(window.innerWidth - chip.offsetWidth, dragStart.startLeft + dx));
      const top = Math.max(0, Math.min(window.innerHeight - chip.offsetHeight, dragStart.startTop + dy));
      chip.style.left = `${left}px`;
      chip.style.top = `${top}px`;
    }
  });

  btn.addEventListener('pointerup', async (e: PointerEvent) => {
    if (!dragStart) return;
    btn.releasePointerCapture(e.pointerId);
    if (isDragging) {
      const rect = chip.getBoundingClientRect();
      await localStorage_.set(STORAGE_CHIP_POSITION, { left: rect.left, top: rect.top });
      chip.classList.remove(`${CHIP_CLASS}--dragging`);
    } else {
      // Это был клик — открываем меню
      toggleChipMenu(chip);
    }
    dragStart = null;
    isDragging = false;
  });

  btn.addEventListener('pointercancel', () => {
    dragStart = null;
    isDragging = false;
    chip.classList.remove(`${CHIP_CLASS}--dragging`);
  });
}

function renderChip(): void {
  const chip = ensureChip();
  const s = currentChatSettings;

  if (!currentChatKey || !s) {
    chip.style.display = 'none';
    return;
  }
  chip.style.display = '';
  chip.classList.toggle(`${CHIP_CLASS}--on`, !!s.enabled);
  chip.classList.toggle(`${CHIP_CLASS}--off`, !s.enabled);

  const t = I18N[getUiLang()];
  const partnerInfo = SUPPORTED_PARTNER_LANGS.find((l) => l.code === s.partner_lang);
  const partnerTag = partnerInfo?.flag ?? s.partner_lang.toUpperCase();
  const myInfo = SUPPORTED_PREFERRED_LANGS.find((l) => l.code === s.preferred_lang);
  const myTag = (myInfo as { code: string; flag?: string })?.flag ?? s.preferred_lang.toUpperCase();
  const langTag = `${partnerTag} ↔ ${myTag}`;
  const stateText = s.enabled ? t.chipStateOn : t.chipStateOff;

  if (!chip.querySelector(`.${CHIP_CLASS}__btn`)) {
    chip.innerHTML = `
      <button class="${CHIP_CLASS}__btn" type="button" aria-label="Настройки перевода">
        <span class="${CHIP_CLASS}__dot"></span>
        <span class="${CHIP_CLASS}__lang"></span>
        <span class="${CHIP_CLASS}__state"></span>
      </button>
    `;
    attachDragHandlers(chip);
  }
  const langEl = chip.querySelector(`.${CHIP_CLASS}__lang`);
  const stateEl = chip.querySelector(`.${CHIP_CLASS}__state`);
  if (langEl) langEl.textContent = langTag;
  if (stateEl) stateEl.textContent = stateText;

  // онбординг — один раз показать стрелку
  void maybeShowOnboarding(chip);
}

function toggleChipMenu(chip: HTMLElement): void {
  const existing = chip.querySelector(`.${CHIP_CLASS}__menu`);
  if (existing) {
    existing.remove();
    return;
  }

  const s = currentChatSettings;
  if (!s) return;

  const menu = document.createElement('div');
  menu.className = `${CHIP_CLASS}__menu`;

  // Решаем где раскрыть меню (вверх или вниз — в зависимости от позиции чипа)
  const chipRect = chip.getBoundingClientRect();
  if (chipRect.top > window.innerHeight / 2) {
    menu.style.bottom = `calc(100% + 8px)`;
  } else {
    menu.style.top = `calc(100% + 8px)`;
  }
  // По горизонтали — выравниваем по правому краю чипа, но если близко к левому краю — по левому
  if (chipRect.left < 200) {
    menu.style.left = '0';
  } else {
    menu.style.right = '0';
  }

  const partnerOptions = SUPPORTED_PARTNER_LANGS.map(
    (lang) => `
    <div class="${CHIP_CLASS}__lang-row${lang.code === s.partner_lang ? ` ${CHIP_CLASS}__lang-row--active` : ''}" data-partner-lang="${lang.code}">
      <span class="${CHIP_CLASS}__lang-tag">${lang.flag}</span>
      <span>${lang.label}</span>
    </div>
  `
  ).join('');

  const myOptions = SUPPORTED_PREFERRED_LANGS.map(
    (lang) => `
    <div class="${CHIP_CLASS}__lang-row${lang.code === s.preferred_lang ? ` ${CHIP_CLASS}__lang-row--active` : ''}" data-my-lang="${lang.code}">
      <span class="${CHIP_CLASS}__lang-tag">${lang.code.toUpperCase()}</span>
      <span>${lang.label}</span>
    </div>
  `
  ).join('');

  const t = I18N[getUiLang()];
  menu.innerHTML = `
    <div class="${CHIP_CLASS}__chat-name">${escapeHtml(currentChatDisplayName ?? currentChatKey ?? '')}</div>
    <div class="${CHIP_CLASS}__row" data-action="toggle">
      <strong>${escapeHtml(t.chipToggleLabel)}</strong>
      <button class="${CHIP_CLASS}__switch" type="button" data-on="${s.enabled ? '1' : '0'}"></button>
    </div>
    <div class="${CHIP_CLASS}__divider"></div>
    <div class="${CHIP_CLASS}__menu-header">${escapeHtml(t.chipMyLang)}</div>
    <div class="${CHIP_CLASS}__lang-grid">${myOptions}</div>
    <div class="${CHIP_CLASS}__divider"></div>
    <div class="${CHIP_CLASS}__menu-header">${escapeHtml(t.chipPartnerLang)}</div>
    <div class="${CHIP_CLASS}__lang-grid">${partnerOptions}</div>
    <div class="${CHIP_CLASS}__divider"></div>
    <div class="${CHIP_CLASS}__hint">${escapeHtml(t.chipHint)}</div>
  `;

  chip.appendChild(menu);

  const toggleRow = menu.querySelector(`[data-action="toggle"]`) as HTMLElement;
  toggleRow.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentChatKey || !currentChatSettings) return;
    currentChatSettings = { ...currentChatSettings, enabled: !currentChatSettings.enabled };
    await setChatSettings(currentChatKey, currentChatSettings);
    void syncToServer(currentChatKey, currentChatSettings);
    const sw = menu.querySelector(`.${CHIP_CLASS}__switch`) as HTMLElement;
    sw.dataset.on = currentChatSettings.enabled ? '1' : '0';
    renderChip();
    rescanVisibleMessages();
  });

  // Партнёр
  menu.querySelectorAll(`[data-partner-lang]`).forEach((row) => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const lang = (row as HTMLElement).dataset.partnerLang;
      if (!lang || !currentChatKey || !currentChatSettings) return;
      if (lang === currentChatSettings.partner_lang) return;
      currentChatSettings = { ...currentChatSettings, partner_lang: lang };
      await setChatSettings(currentChatKey, currentChatSettings);
      void syncToServer(currentChatKey, currentChatSettings);
      menu.remove();
      renderChip();
      rescanVisibleMessages();
    });
  });

  // Я
  menu.querySelectorAll(`[data-my-lang]`).forEach((row) => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const lang = (row as HTMLElement).dataset.myLang;
      if (!lang || !currentChatKey || !currentChatSettings) return;
      if (lang === currentChatSettings.preferred_lang) return;
      currentChatSettings = { ...currentChatSettings, preferred_lang: lang };
      await setChatSettings(currentChatKey, currentChatSettings);
      void syncToServer(currentChatKey, currentChatSettings);
      menu.remove();
      renderChip();
      rescanVisibleMessages();
    });
  });

  const close = (ev: MouseEvent): void => {
    if (!menu.contains(ev.target as Node) && !chip.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ===== ONBOARDING ===========================================================

// Локализованные сообщения интерфейса. Язык определяется по navigator.language;
// fallback на ru.
interface I18nMsg {
  // Onboarding
  onboardTitle: string;
  onboardSubtitle: string;
  step1: string;
  step2: string;
  step3: string;
  tipLabel: string;
  tipText: string;
  startBtn: string;
  arrowHint: string;
  close: string;
  // Chip + popover
  chipMyLang: string;
  chipPartnerLang: string;
  chipToggleLabel: string;
  chipHint: string;
  chipStateOn: string;
  chipStateOff: string;
  // Status
  statusTranslating: string;
  statusSent: string;
  statusCancelled: string;
  statusErrorPrefix: string;
  // Preview
  previewLabel: string;
  previewHint: string;
  previewBtnCancel: string;
  previewBtnSend: string;
  // Errors
  errEmptyTranslation: string;
  errSendBtnNotFound: string;
  errPrefix: string;
}

const I18N: Record<string, I18nMsg> = {
  ru: {
    onboardTitle: 'Добро пожаловать в HiVietBro',
    onboardSubtitle: 'Перевод чата в реальном времени',
    step1: 'Найдите плавающую кнопку HiVietBro в углу — её можно перетащить куда удобно.',
    step2: 'Кликните на кнопку, выберите свой язык и язык собеседника, включите перевод.',
    step3: 'Пишите на родном языке — расширение само переведёт перед отправкой.',
    tipLabel: 'Совет',
    tipText: 'Избегайте сложных идиом и игры слов — точность перевода выше у простых, прямых фраз.',
    startBtn: 'Начать',
    arrowHint: 'Кнопка здесь →',
    close: 'понятно',
    chipMyLang: 'Я говорю на',
    chipPartnerLang: 'Партнёр говорит на',
    chipToggleLabel: 'Перевод включён',
    chipHint: 'Перетащите иконку, чтобы переместить. Клик по переводу — показать оригинал.',
    chipStateOn: 'перевод вкл',
    chipStateOff: 'перевод выкл',
    statusTranslating: 'Перевожу…',
    statusSent: 'Отправлено',
    statusCancelled: 'Отменено',
    statusErrorPrefix: 'Ошибка',
    previewLabel: 'Будет отправлено',
    previewHint: 'Esc — отменить · Enter — отправить',
    previewBtnCancel: 'Отменить',
    previewBtnSend: 'Отправить',
    errEmptyTranslation: 'пустой перевод',
    errSendBtnNotFound: 'кнопка отправки не найдена',
    errPrefix: 'ошибка',
  },
  en: {
    onboardTitle: 'Welcome to HiVietBro',
    onboardSubtitle: 'Real-time chat translation',
    step1: 'Find the floating HiVietBro button in the corner — you can drag it anywhere.',
    step2: 'Click the button, pick your language and the partner\'s language, enable translation.',
    step3: 'Type in your native language — the extension will translate before sending.',
    tipLabel: 'Tip',
    tipText: 'Avoid heavy idioms and word-play — accuracy is higher for plain, direct phrasing.',
    startBtn: 'Start',
    arrowHint: 'Button is here →',
    close: 'got it',
    chipMyLang: 'I speak',
    chipPartnerLang: 'Partner speaks',
    chipToggleLabel: 'Translation enabled',
    chipHint: 'Drag the icon to reposition. Click any translation to toggle the original.',
    chipStateOn: 'translation on',
    chipStateOff: 'translation off',
    statusTranslating: 'Translating…',
    statusSent: 'Sent',
    statusCancelled: 'Cancelled',
    statusErrorPrefix: 'Error',
    previewLabel: 'Will be sent',
    previewHint: 'Esc — cancel · Enter — send',
    previewBtnCancel: 'Cancel',
    previewBtnSend: 'Send',
    errEmptyTranslation: 'empty translation',
    errSendBtnNotFound: 'send button not found',
    errPrefix: 'error',
  },
  ko: {
    onboardTitle: 'HiVietBro에 오신 것을 환영합니다',
    onboardSubtitle: '실시간 채팅 번역',
    step1: '화면 모서리에서 떠 있는 HiVietBro 버튼을 찾으세요 — 원하는 위치로 드래그할 수 있습니다.',
    step2: '버튼을 누르고, 본인 언어와 상대방 언어를 선택한 후 번역을 활성화하세요.',
    step3: '모국어로 입력하시면, 확장 프로그램이 발신 전에 번역해 드립니다.',
    tipLabel: '팁',
    tipText: '어려운 관용구나 말장난은 피하세요 — 단순하고 직접적인 표현일수록 번역 정확도가 높습니다.',
    startBtn: '시작',
    arrowHint: '버튼이 여기 →',
    close: '확인',
    chipMyLang: '내가 사용하는 언어',
    chipPartnerLang: '상대방 사용 언어',
    chipToggleLabel: '번역 활성화',
    chipHint: '아이콘을 드래그해 이동할 수 있습니다. 번역을 클릭하면 원문이 표시됩니다.',
    chipStateOn: '번역 ON',
    chipStateOff: '번역 OFF',
    statusTranslating: '번역 중…',
    statusSent: '전송됨',
    statusCancelled: '취소됨',
    statusErrorPrefix: '오류',
    previewLabel: '전송될 내용',
    previewHint: 'Esc — 취소 · Enter — 전송',
    previewBtnCancel: '취소',
    previewBtnSend: '전송',
    errEmptyTranslation: '빈 번역',
    errSendBtnNotFound: '전송 버튼을 찾을 수 없음',
    errPrefix: '오류',
  },
  vi: {
    onboardTitle: 'Chào mừng đến với HiVietBro',
    onboardSubtitle: 'Dịch chat thời gian thực',
    step1: 'Tìm nút HiVietBro nổi ở góc màn hình — có thể kéo đến vị trí thuận tiện.',
    step2: 'Nhấn vào nút, chọn ngôn ngữ của bạn và ngôn ngữ đối tác, bật bản dịch.',
    step3: 'Nhập tin nhắn bằng ngôn ngữ mẹ đẻ — ứng dụng sẽ dịch trước khi gửi.',
    tipLabel: 'Mẹo',
    tipText: 'Tránh thành ngữ phức tạp và cách chơi chữ — câu đơn giản, trực tiếp sẽ được dịch chính xác hơn.',
    startBtn: 'Bắt đầu',
    arrowHint: 'Nút ở đây →',
    close: 'hiểu rồi',
    chipMyLang: 'Tôi nói',
    chipPartnerLang: 'Đối tác nói',
    chipToggleLabel: 'Bật bản dịch',
    chipHint: 'Kéo biểu tượng để di chuyển. Nhấn vào bản dịch để xem bản gốc.',
    chipStateOn: 'dịch ON',
    chipStateOff: 'dịch OFF',
    statusTranslating: 'Đang dịch…',
    statusSent: 'Đã gửi',
    statusCancelled: 'Đã hủy',
    statusErrorPrefix: 'Lỗi',
    previewLabel: 'Sẽ gửi',
    previewHint: 'Esc — hủy · Enter — gửi',
    previewBtnCancel: 'Hủy',
    previewBtnSend: 'Gửi',
    errEmptyTranslation: 'bản dịch trống',
    errSendBtnNotFound: 'không tìm thấy nút gửi',
    errPrefix: 'lỗi',
  },
};

function getUiLang(): string {
  try {
    const code = (navigator.language || 'ru').slice(0, 2).toLowerCase();
    if (I18N[code]) return code;
  } catch {}
  return 'ru';
}

async function maybeShowOnboarding(chip: HTMLElement): Promise<void> {
  const seen = await localStorage_.get<boolean>(STORAGE_ONBOARD_SEEN);
  if (seen) return;
  if (document.querySelector('.zb-tour-overlay')) return;

  const t = I18N[getUiLang()];
  const chipRect = chip.getBoundingClientRect();

  // Затемнение фона (с прозрачным «окошком» вокруг чипа — он остаётся виден)
  const overlay = document.createElement('div');
  overlay.className = 'zb-tour-overlay';

  // Карточка приветствия + шаги
  const card = document.createElement('div');
  card.className = 'zb-tour-card';
  card.innerHTML = `
    <img class="zb-tour-logo" src="${LOGO_URL}" alt="HiVietBro">
    <div class="zb-tour-title">${escapeHtml(t.onboardTitle)}</div>
    <div class="zb-tour-subtitle">${escapeHtml(t.onboardSubtitle)}</div>
    <ol class="zb-tour-steps">
      <li><span class="zb-tour-step-num">1</span><span>${escapeHtml(t.step1)}</span></li>
      <li><span class="zb-tour-step-num">2</span><span>${escapeHtml(t.step2)}</span></li>
      <li><span class="zb-tour-step-num">3</span><span>${escapeHtml(t.step3)}</span></li>
    </ol>
    <div class="zb-tour-tip"><strong>${escapeHtml(t.tipLabel)}.</strong> ${escapeHtml(t.tipText)}</div>
    <button class="zb-tour-btn" type="button">${escapeHtml(t.startBtn)}</button>
  `;

  // Позиция карточки: слева/справа от чипа (там где больше места)
  const placeOnLeft = chipRect.right > window.innerWidth / 2;
  if (placeOnLeft) {
    card.style.right = `${window.innerWidth - chipRect.left + 24}px`;
  } else {
    card.style.left = `${chipRect.right + 24}px`;
  }
  card.style.bottom = `${Math.max(40, window.innerHeight - chipRect.bottom - 30)}px`;

  // SVG-стрелка от карточки к чипу
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.setAttribute('class', 'zb-tour-arrow');
  arrow.setAttribute('width', '120');
  arrow.setAttribute('height', '80');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  if (placeOnLeft) {
    arrow.style.right = `${window.innerWidth - chipRect.left + 8}px`;
    arrow.style.bottom = `${window.innerHeight - chipRect.bottom + chipRect.height / 2 - 30}px`;
    path.setAttribute('d', 'M 10 10 Q 60 30, 100 60');
  } else {
    arrow.style.left = `${chipRect.right + 8}px`;
    arrow.style.bottom = `${window.innerHeight - chipRect.bottom + chipRect.height / 2 - 30}px`;
    path.setAttribute('d', 'M 110 10 Q 60 30, 20 60');
  }
  path.setAttribute('stroke', '#fff');
  path.setAttribute('stroke-width', '3');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-dasharray', '6 6');
  path.setAttribute('stroke-linecap', 'round');
  arrow.appendChild(path);

  // Стрелка-наконечник
  const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  if (placeOnLeft) {
    head.setAttribute('points', '95,55 105,65 95,67');
  } else {
    head.setAttribute('points', '25,55 15,65 25,67');
  }
  head.setAttribute('fill', '#fff');
  arrow.appendChild(head);

  document.body.appendChild(overlay);
  document.body.appendChild(arrow);
  document.body.appendChild(card);

  const close = async (): Promise<void> => {
    overlay.remove();
    arrow.remove();
    card.remove();
    await localStorage_.set(STORAGE_ONBOARD_SEEN, true);
  };
  overlay.addEventListener('click', close);
  card.querySelector('.zb-tour-btn')?.addEventListener('click', close);
}

// ===== OUTGOING — перехват + preview =======================================

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
      if (!currentChatSettings?.enabled) return;
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

  const t = I18N[getUiLang()];

  // Если пользователь сам уже написал на языке партнёра — не переводим, отдаём Zalo как есть
  const detectedSrc = detectLang(ruText);
  if (detectedSrc === currentChatSettings.partner_lang) {
    const sendBtn = document.querySelector(SEL.sendButton) as HTMLElement | null;
    if (sendBtn) sendBtn.click();
    return;
  }

  translationInFlight = true;
  showStatus(t.statusTranslating);

  try {
    const result = await apiTranslate({
      text: ruText,
      source_lang: detectedSrc !== 'unknown' ? detectedSrc : currentChatSettings.preferred_lang,
      target_lang: currentChatSettings.partner_lang,
      direction: 'outgoing',
      chat_id: currentChatKey ?? undefined,
    });
    const vi = result.translation;
    if (!vi) throw new Error(t.errEmptyTranslation);

    hideStatus();

    // Показать preview, дать пользователю 1.8с на отмену через Esc
    const confirmed = await showPreviewAndAwaitConfirm(ruText, vi);
    if (!confirmed) {
      showStatus(t.statusCancelled, 'error');
      setTimeout(hideStatus, 1500);
      return;
    }

    input.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, vi);

    // Дополнительно дёрнем input event — на случай если Zalo не подхватил execCommand
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: vi }));

    // Поллим send-button до 600мс — Zalo'у нужно время на React rerender,
    // чтобы кнопка появилась после смены input.empty -> input.with-text
    let sendBtn: HTMLElement | null = null;
    for (let i = 0; i < 12; i++) {
      sendBtn = document.querySelector(SEL.sendButton) as HTMLElement | null;
      if (sendBtn) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    if (sendBtn) {
      sendBtn.click();
    } else {
      console.warn('[zalo-bridge] send button not found after 600ms, falling back to Enter key');
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }

    showStatus(t.statusSent, 'success');
    setTimeout(hideStatus, 1000);
  } catch (err) {
    console.error('[zalo-bridge] send failed:', err);
    showStatus(`${t.statusErrorPrefix}: ${(err as Error).message}`, 'error');
    setTimeout(hideStatus, 3500);
  } finally {
    translationInFlight = false;
  }
}

const PREVIEW_AUTO_CONFIRM_MS = 1800;

function showPreviewAndAwaitConfirm(srcText: string, tgtText: string): Promise<boolean> {
  const t = I18N[getUiLang()];
  return new Promise((resolve) => {
    document.querySelector(`.${PREVIEW_CLASS}`)?.remove();
    const panel = document.createElement('div');
    panel.className = PREVIEW_CLASS;
    panel.innerHTML = `
      <div class="${PREVIEW_CLASS}__label">${escapeHtml(t.previewLabel)}</div>
      <div class="${PREVIEW_CLASS}__text">${escapeHtml(tgtText)}</div>
      <div class="${PREVIEW_CLASS}__row">
        <span class="${PREVIEW_CLASS}__hint">${escapeHtml(t.previewHint)}</span>
        <div>
          <button class="${PREVIEW_CLASS}__btn" data-act="cancel">${escapeHtml(t.previewBtnCancel)}</button>
          <button class="${PREVIEW_CLASS}__btn ${PREVIEW_CLASS}__btn--primary" data-act="send">${escapeHtml(t.previewBtnSend)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    let done = false;
    const finish = (result: boolean): void => {
      if (done) return;
      done = true;
      window.clearTimeout(autoTimer);
      document.removeEventListener('keydown', onKey, true);
      panel.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(false);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(true);
      }
    };
    document.addEventListener('keydown', onKey, true);

    panel.querySelector('[data-act="cancel"]')?.addEventListener('click', () => finish(false));
    panel.querySelector('[data-act="send"]')?.addEventListener('click', () => finish(true));

    const autoTimer = window.setTimeout(() => finish(true), PREVIEW_AUTO_CONFIRM_MS);
  });
}

// ===== ROOT WATCHER (debounced) ============================================

function watchUI(): void {
  let pendingTick: number | null = null;
  let lastChatKey: string | null = null;
  let nullRootCount = 0;
  let lastScrollRescan = 0;

  const tick = async (): Promise<void> => {
    pendingTick = null;
    const msgRoot = document.querySelector(SEL.messageContainer);

    if (!msgRoot) {
      // НЕ обнуляем currentChatSettings сразу — Zalo может временно убрать
      // контейнер при ре-рендере (скролл, смена баббла). Сбрасываем только
      // если 3+ tick'ов подряд видят пустоту (≈600мс) — это уже точно «чат закрыт».
      nullRootCount++;
      if (nullRootCount >= 3) {
        if (attachedMsgRoot) {
          attachedMsgRoot = null;
          if (msgObserver) {
            msgObserver.disconnect();
            msgObserver = null;
          }
        }
        currentChatKey = null;
        currentChatDisplayName = null;
        currentChatSettings = null;
        lastChatKey = null;
        nullRootCount = 0;
        renderChip();
      }
      return;
    }
    nullRootCount = 0;

    const { key } = findChatKey();
    // Перезагружаем настройки ТОЛЬКО при non-null key и реальной смене чата.
    // Transient null key (qid temporarily gone during scroll) — игнорируем,
    // currentChatSettings остаётся прежним.
    if (key && key !== lastChatKey) {
      lastChatKey = key;
      await loadCurrentChatSettings();
    }

    if (msgRoot !== attachedMsgRoot) {
      attachMessageObserver(msgRoot);
      // Подключаем scroll listener — при скролле истории Zalo подгружает старые
      // сообщения; мы делаем дебаунсенный rescan чтобы старые баблы тоже
      // получили overlay.
      msgRoot.addEventListener('scroll', () => {
        const now = Date.now();
        if (now - lastScrollRescan < 350) return; // дебаунс
        lastScrollRescan = now;
        if (currentChatSettings?.enabled) rescanVisibleMessages();
      });
    }
    renderChip();
  };

  const schedule = (): void => {
    if (pendingTick !== null) return;
    if (!isContextValid()) {
      markContextDead();
      return;
    }
    pendingTick = window.setTimeout(() => void tick(), 200);
  };

  void tick();

  bodyObserver = new MutationObserver(schedule);
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  // Safety net: каждые 8 сек принудительный rescan видимых сообщений если
  // активный чат включён. Ловит граничные случаи когда MutationObserver
  // пропустил событие (history pagination Zalo иногда обходит childList API).
  setInterval(() => {
    if (!isContextValid()) return;
    if (currentChatSettings?.enabled) rescanVisibleMessages();
  }, 8000);
}

// ===== SERVER SYNC ==========================================================

async function syncFromServer(): Promise<void> {
  const since = await getLastSyncTs();
  const remote = await pullChatsFromServer(since);
  if (remote.length === 0) return;

  let maxTs = since;
  let currentChatChanged = false;
  for (const r of remote) {
    if (r.updated_at > maxTs) maxTs = r.updated_at;
    const local = await getChatSettings(r.chat_key);
    // Last-write-wins: серверный апдейт перезаписывает локальный, если он новее
    if (!local || r.updated_at > (local.updated_at ?? 0)) {
      await setChatSettings(r.chat_key, {
        enabled: r.enabled === 1 || (r.enabled as unknown) === true,
        partner_lang: r.partner_lang,
        preferred_lang: r.preferred_lang,
        display_name: r.display_name ?? undefined,
        updated_at: r.updated_at,
      });
      if (r.chat_key === currentChatKey) currentChatChanged = true;
    }
  }
  await setLastSyncTs(maxTs);
  console.info(`[zalo-bridge] synced ${remote.length} chats from server`);

  // КРИТИЧНО: если активный чат был обновлён сервером — перерисовать UI и
  // запустить rescan видимых сообщений. Без этого чип остаётся в дефолтном
  // OFF после первой загрузки, даже если на сервере enabled=true.
  if (currentChatChanged && currentChatKey) {
    const fresh = await getChatSettings(currentChatKey);
    if (fresh) {
      currentChatSettings = fresh;
      renderChip();
      rescanVisibleMessages();
      console.info('[zalo-bridge] active chat settings refreshed from server');
    }
  }
}

async function syncToServer(chatKey: string, settings: ChatSettings): Promise<void> {
  try {
    await pushChatsToServer([
      {
        chat_key: chatKey,
        display_name: settings.display_name ?? null,
        enabled: settings.enabled,
        partner_lang: settings.partner_lang,
        preferred_lang: settings.preferred_lang,
        updated_at: settings.updated_at,
      },
    ]);
  } catch (e) {
    console.warn('[zalo-bridge] sync to server failed:', e);
  }
}

bootstrap().catch((e) => console.error('[zalo-bridge] bootstrap failed:', e));
