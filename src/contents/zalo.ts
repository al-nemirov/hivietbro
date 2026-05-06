// Plasmo content script — инжектится в chat.zalo.me
// Селекторы разведаны 2026-05-06, см. docs/zalo-dom.md

import type { PlasmoCSConfig } from 'plasmo';
import { Storage } from '@plasmohq/storage';
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

  // Async: подтянуть настройки чатов с сервера (в фоне, не блокируем bootstrap)
  void syncFromServer().catch((e) => console.warn('[zalo-bridge] sync from server failed:', e));
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
      width: 240px;
      background: #fff;
      border: 1px solid #e6e8ec;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04);
      padding: 10px;
      animation: zb-pop 0.15s ease-out;
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

/**
 * Находит стабильный chat key:
 *   - data-qid префикс ANY видимого баббла (стабильный contactId Zalo)
 *   - fallback: data-trailer (имя контакта; для пустых чатов)
 */
function findChatKey(): { key: string | null; displayName: string | null } {
  const input = document.querySelector(SEL.inputField) as HTMLElement | null;
  const trailer = input?.dataset?.trailer ?? null;

  // Найти любой data-qid на видимых баблах
  const anyQidEl = document.querySelector(`${SEL.messageBubble} ${QID_HOST_SELECTOR}`);
  const qid = anyQidEl?.getAttribute('data-qid');
  const contactId = qid ? extractContactIdFromQid(qid) : null;

  if (contactId) return { key: `c:${contactId}`, displayName: trailer };
  if (trailer) return { key: `t:${trailer}`, displayName: trailer };
  return { key: null, displayName: null };
}

async function loadCurrentChatSettings(): Promise<void> {
  const { key, displayName } = findChatKey();
  if (!key) {
    currentChatKey = null;
    currentChatDisplayName = null;
    currentChatSettings = null;
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
  if (isOutgoing(bubble)) return;
  if (bubble.querySelector(`[${OVERLAY_DATA_ATTR}]`)) return;
  if (!currentChatSettings || !currentChatSettings.enabled) return;

  const qid = getBubbleStableId(bubble);
  if (!qid) return;

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

  const langInfo = SUPPORTED_PARTNER_LANGS.find((l) => l.code === s.partner_lang);
  const langTag = langInfo?.flag ?? s.partner_lang.toUpperCase();
  const stateText = s.enabled ? 'перевод вкл' : 'перевод выкл';

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

  const langOptions = SUPPORTED_PARTNER_LANGS.map(
    (lang) => `
    <div class="${CHIP_CLASS}__lang-row${lang.code === s.partner_lang ? ` ${CHIP_CLASS}__lang-row--active` : ''}" data-lang="${lang.code}">
      <span class="${CHIP_CLASS}__lang-tag">${lang.flag}</span>
      <span>${lang.label}</span>
    </div>
  `
  ).join('');

  menu.innerHTML = `
    <div class="${CHIP_CLASS}__chat-name">${escapeHtml(currentChatDisplayName ?? currentChatKey ?? '')}</div>
    <div class="${CHIP_CLASS}__row" data-action="toggle">
      <strong>Перевод включён</strong>
      <button class="${CHIP_CLASS}__switch" type="button" data-on="${s.enabled ? '1' : '0'}"></button>
    </div>
    <div class="${CHIP_CLASS}__divider"></div>
    <div class="${CHIP_CLASS}__menu-header">Партнёр говорит на</div>
    ${langOptions}
    <div class="${CHIP_CLASS}__divider"></div>
    <div class="${CHIP_CLASS}__hint">Чтобы переместить — потяни иконку. Клик по переводу — показать оригинал.</div>
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

  menu.querySelectorAll(`[data-lang]`).forEach((row) => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const lang = (row as HTMLElement).dataset.lang;
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

async function maybeShowOnboarding(chip: HTMLElement): Promise<void> {
  const seen = await localStorage_.get<boolean>(STORAGE_ONBOARD_SEEN);
  if (seen) return;
  if (document.querySelector(`.${TOOLTIP_CLASS}`)) return;

  const tip = document.createElement('div');
  tip.className = TOOLTIP_CLASS;
  tip.innerHTML = `
    <div>👇 Включи перевод для этого чата здесь.<br>Можно перетаскивать иконку куда удобно.</div>
    <span class="${TOOLTIP_CLASS}__close">понятно</span>
  `;
  document.body.appendChild(tip);

  // Position above the chip
  const rect = chip.getBoundingClientRect();
  tip.style.right = `${window.innerWidth - rect.right}px`;
  tip.style.top = `${rect.top - tip.offsetHeight - 12}px`;

  const close = async (): Promise<void> => {
    tip.remove();
    await localStorage_.set(STORAGE_ONBOARD_SEEN, true);
  };
  tip.querySelector(`.${TOOLTIP_CLASS}__close`)?.addEventListener('click', close);
  setTimeout(close, 12_000);
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

  // Если пользователь сам уже написал на языке партнёра — не переводим, отдаём Zalo как есть
  const detectedSrc = detectLang(ruText);
  if (detectedSrc === currentChatSettings.partner_lang) {
    // Откатить наше preventDefault — нативный send уже не сработает,
    // поэтому программно симулируем нажатие send-кнопки
    const sendBtn = document.querySelector(SEL.sendButton) as HTMLElement | null;
    if (sendBtn) sendBtn.click();
    return;
  }

  translationInFlight = true;
  showStatus('Перевожу…');

  try {
    const result = await apiTranslate({
      text: ruText,
      source_lang: detectedSrc !== 'unknown' ? detectedSrc : currentChatSettings.preferred_lang,
      target_lang: currentChatSettings.partner_lang,
      direction: 'outgoing',
      chat_id: currentChatKey ?? undefined,
    });
    const vi = result.translation;
    if (!vi) throw new Error('пустой перевод');

    hideStatus();

    // Показать preview, дать пользователю 1.8с на отмену через Esc
    const confirmed = await showPreviewAndAwaitConfirm(ruText, vi);
    if (!confirmed) {
      // Пользователь отменил — оставляем оригинальный текст в инпуте
      showStatus('Отменено', 'error');
      setTimeout(hideStatus, 1500);
      return;
    }

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

const PREVIEW_AUTO_CONFIRM_MS = 1800;

function showPreviewAndAwaitConfirm(srcText: string, tgtText: string): Promise<boolean> {
  return new Promise((resolve) => {
    document.querySelector(`.${PREVIEW_CLASS}`)?.remove();
    const panel = document.createElement('div');
    panel.className = PREVIEW_CLASS;
    panel.innerHTML = `
      <div class="${PREVIEW_CLASS}__label">Будет отправлено</div>
      <div class="${PREVIEW_CLASS}__text">${escapeHtml(tgtText)}</div>
      <div class="${PREVIEW_CLASS}__row">
        <span class="${PREVIEW_CLASS}__hint">Esc — отменить · Enter — отправить сейчас</span>
        <div>
          <button class="${PREVIEW_CLASS}__btn" data-act="cancel">Отменить</button>
          <button class="${PREVIEW_CLASS}__btn ${PREVIEW_CLASS}__btn--primary" data-act="send">Отправить</button>
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

  const tick = async (): Promise<void> => {
    pendingTick = null;
    const msgRoot = document.querySelector(SEL.messageContainer);

    if (!msgRoot) {
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
      renderChip();
      return;
    }

    const { key } = findChatKey();
    if (key !== lastChatKey) {
      lastChatKey = key;
      await loadCurrentChatSettings();
    }

    if (msgRoot !== attachedMsgRoot) attachMessageObserver(msgRoot);
    renderChip();
  };

  const schedule = (): void => {
    if (pendingTick !== null) return;
    pendingTick = window.setTimeout(() => void tick(), 200);
  };

  void tick();

  const bodyObs = new MutationObserver(schedule);
  bodyObs.observe(document.body, { childList: true, subtree: true });
}

// ===== SERVER SYNC ==========================================================

async function syncFromServer(): Promise<void> {
  const since = await getLastSyncTs();
  const remote = await pullChatsFromServer(since);
  if (remote.length === 0) return;

  let maxTs = since;
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
    }
  }
  await setLastSyncTs(maxTs);
  console.info(`[zalo-bridge] synced ${remote.length} chats from server`);
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
